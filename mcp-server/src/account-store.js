// A tapp account is an email address, nothing more. It exists so the hosted Studio can do what
// the local one does — stop at a sign-in and ask, and remember the answer — for a person it can
// tell apart from the next visitor. There are no passwords here: a sign-in is a link mailed to
// the address, used once, and a session cookie after that.
//
// Nothing secret is stored in the clear. A link token and a session token are random; only their
// SHA-256 lands on disk, so a copy of this directory cannot sign anyone in. Each account gets its
// own encrypted actor store (see actor-store.js) under its directory, so one person's test
// accounts are never listed under another's.
//
// Layout:  TAPP_HOME/accounts/
//            by-email/<sha256(email)>      → account id
//            accounts/<id>.json            { id, email, createdAt, lastSeenAt }
//            links/<sha256(token)>.json    { email, expiresAt }      (removed on use)
//            sessions/<sha256(token)>.json { accountId, createdAt, expiresAt }
//            tokens/<sha256(token)>.json   { id, accountId, label, createdAt, lastUsedAt }
//            actors/<id>/                  that account's ActorStore root
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A personal access token lets the owner's coding agent act as them without a browser. It is
// shown once, stored only as a hash, and never expires on its own — it is revoked by name.
export const TOKEN_PREFIX = "tapp_";
export const LINK_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// One address may ask for this many links in a ten-minute window; more is someone else's mailbox
// being flooded through us.
const LINKS_PER_WINDOW = 5;
const LINK_WINDOW_MS = 10 * 60 * 1000;

export function accountStoreRoot(env = process.env) {
  const home = (env.TAPP_HOME || "").trim() || path.join(os.homedir(), ".tapp");
  return path.join(home, "accounts");
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!EMAIL.test(email)) throw Object.assign(new Error("That does not look like an email address"), { statusCode: 400 });
  return email;
}

const sha = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const token = () => crypto.randomBytes(32).toString("base64url");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class AccountStore {
  constructor({ root = accountStoreRoot(), now = () => Date.now() } = {}) {
    this.root = root;
    this.now = now;
    this.linkRequests = new Map();
  }

  #file(kind, key) { return path.join(this.root, kind, `${key}.json`); }

  /** Ask for a sign-in link. Returns the token to mail — the only time it exists in the clear. */
  requestLink(rawEmail) {
    const email = normalizeEmail(rawEmail);
    const now = this.now();
    const recent = (this.linkRequests.get(email) || []).filter((at) => now - at < LINK_WINDOW_MS);
    if (recent.length >= LINKS_PER_WINDOW) {
      throw Object.assign(new Error("A few links were already sent to that address. Check your inbox, then try again in a little while."), { statusCode: 429 });
    }
    recent.push(now);
    this.linkRequests.set(email, recent);
    const value = token();
    writeJson(this.#file("links", sha(value)), { email, expiresAt: new Date(now + LINK_TTL_MS).toISOString() });
    return { email, token: value };
  }

  /** Use a link once. Returns a session token and the account, or null for a bad or spent link. */
  redeem(value) {
    if (!/^[A-Za-z0-9_-]{20,}$/.test(String(value || ""))) return null;
    const file = this.#file("links", sha(value));
    const link = readJson(file);
    try { fs.rmSync(file, { force: true }); } catch { /* spent either way */ }
    if (!link || Date.parse(link.expiresAt) < this.now()) return null;
    return this.signIn(link.email);
  }

  /** Open a session for an address whose owner has already been verified (a redeemed link, or
   *  an identity provider such as Cloudflare Access). */
  signIn(rawEmail) {
    const account = this.#ensureAccount(normalizeEmail(rawEmail));
    const session = token();
    writeJson(this.#file("sessions", sha(session)), { accountId: account.id, createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + SESSION_TTL_MS).toISOString() });
    return { session, account };
  }

  /** The account behind a session cookie, or null. */
  sessionAccount(value) {
    if (!/^[A-Za-z0-9_-]{20,}$/.test(String(value || ""))) return null;
    const session = readJson(this.#file("sessions", sha(value)));
    if (!session || Date.parse(session.expiresAt) < this.now()) return null;
    const account = readJson(this.#file("accounts", session.accountId));
    if (!account) return null;
    // lastSeenAt is coarse on purpose: a day, not a request log.
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if ((account.lastSeenAt || "").slice(0, 10) !== day) { account.lastSeenAt = new Date(this.now()).toISOString(); writeJson(this.#file("accounts", account.id), account); }
    return account;
  }

  signOut(value) {
    if (!/^[A-Za-z0-9_-]{20,}$/.test(String(value || ""))) return;
    try { fs.rmSync(this.#file("sessions", sha(value)), { force: true }); } catch { /* already gone */ }
  }

  /**
   * Issue a personal access token. The returned `token` is the only time it exists in the clear;
   * what lands on disk is its hash, so a copy of this directory cannot act as anyone.
   */
  issueToken(accountId, label = "coding agent") {
    if (!/^[a-f0-9]{24}$/.test(String(accountId || ""))) throw new Error("Not an account id");
    const name = String(label || "coding agent").trim().slice(0, 60) || "coding agent";
    const value = `${TOKEN_PREFIX}${token()}`;
    const id = crypto.randomBytes(6).toString("hex");
    writeJson(this.#file("tokens", sha(value)), { id, accountId, label: name, createdAt: new Date(this.now()).toISOString(), lastUsedAt: null });
    return { token: value, id, label: name };
  }

  /** The account behind a personal access token, or null. */
  tokenAccount(value) {
    const raw = String(value || "");
    if (!raw.startsWith(TOKEN_PREFIX) || raw.length < TOKEN_PREFIX.length + 20) return null;
    const file = this.#file("tokens", sha(raw));
    const record = readJson(file);
    if (!record) return null;
    const account = readJson(this.#file("accounts", record.accountId));
    if (!account) return null;
    // Coarse on purpose: a day, so "is this token still in use?" is answerable without a log of
    // every request an agent makes.
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if ((record.lastUsedAt || "").slice(0, 10) !== day) { record.lastUsedAt = new Date(this.now()).toISOString(); writeJson(file, record); }
    return account;
  }

  /** Tokens this account holds — labels and dates, never a value. */
  listTokens(accountId) {
    let names = [];
    try { names = fs.readdirSync(path.join(this.root, "tokens")); } catch { return []; }
    const out = [];
    for (const name of names) {
      const record = readJson(path.join(this.root, "tokens", name));
      if (record?.accountId !== accountId) continue;
      out.push({ id: record.id, label: record.label, createdAt: record.createdAt, lastUsedAt: record.lastUsedAt || null });
    }
    return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  revokeToken(accountId, id) {
    let names = [];
    try { names = fs.readdirSync(path.join(this.root, "tokens")); } catch { return false; }
    for (const name of names) {
      const file = path.join(this.root, "tokens", name);
      const record = readJson(file);
      if (record?.accountId !== accountId || record?.id !== String(id)) continue;
      try { fs.rmSync(file, { force: true }); return true; } catch { return false; }
    }
    return false;
  }

  /** Where this account's encrypted test accounts live. */
  actorRoot(accountId) {
    if (!/^[a-f0-9]{24}$/.test(String(accountId || ""))) throw new Error("Not an account id");
    return path.join(this.root, "actors", accountId);
  }

  #ensureAccount(email) {
    const indexFile = path.join(this.root, "by-email", sha(email));
    let id = null;
    try { id = fs.readFileSync(indexFile, "utf8").trim(); } catch { /* new */ }
    if (id) {
      const existing = readJson(this.#file("accounts", id));
      if (existing) return existing;
    }
    id = crypto.randomBytes(12).toString("hex");
    const account = { id, email, createdAt: new Date(this.now()).toISOString(), lastSeenAt: new Date(this.now()).toISOString() };
    writeJson(this.#file("accounts", id), account);
    fs.mkdirSync(path.dirname(indexFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(indexFile, `${id}\n`, { mode: 0o600 });
    return account;
  }
}

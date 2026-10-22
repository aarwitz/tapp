// Where tapp keeps what it has been told about an application's test accounts, and the signed-in
// sessions it has built with them.
//
// The point of the store is that a login happens once. The first time tapp meets a sign-in it
// asks (see the OCQA_AWAIT_INPUT protocol in web-explorer.js); after a successful sign-in the
// browser's storageState — cookies and local storage, which is what "being signed in" is — is kept
// here, so the next run starts inside the application. A login that needs a code from a phone or
// an email link therefore only ever has to be done by a person once.
//
// Everything here is encrypted at rest. The key is generated once into TAPP_HOME/actors/.key
// (0600). Each record is AES-256-GCM with the host and actor name as additional authenticated
// data, so a record copied between applications or actors does not decrypt — the same shape the
// hosted product's service-access store uses. Nothing in this module ever logs a value.
//
// Layout:  TAPP_HOME/actors/<host>/<actor>.json
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEY_FILE = ".key";
const CIPHER = "aes-256-gcm";
const INFO = "tapp-actor-store-v1";

export function actorStoreRoot(env = process.env) {
  const home = (env.TAPP_HOME || "").trim() || path.join(os.homedir(), ".tapp");
  return path.join(home, "actors");
}

// A host is the application; everything about it keys off the origin's host, never the full URL.
export function hostKey(target) {
  try { return new URL(String(target)).host.toLowerCase(); } catch { return String(target || "").trim().toLowerCase(); }
}

const ACTOR = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export function normalizeActorName(name) {
  const value = String(name || "default").trim();
  if (!ACTOR.test(value)) throw new Error(`Actor name '${value}' must be letters, digits, _ or - (max 64)`);
  return value;
}

function loadKey(root) {
  const keyPath = path.join(root, KEY_FILE);
  try {
    const raw = fs.readFileSync(keyPath);
    if (raw.length === 32) return raw;
  } catch { /* first use */ }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

function derive(root, host, actor) {
  return Buffer.from(crypto.hkdfSync("sha256", loadKey(root), `${host}/${actor}`, INFO, 32));
}

function seal(key, aad, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CIPHER, key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: ciphertext.toString("base64") };
}

function unseal(key, aad, sealed) {
  const decipher = crypto.createDecipheriv(CIPHER, key, Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8"));
}

function recordPath(root, host, actor) {
  return path.join(root, host.replace(/[^a-z0-9.:-]/gi, "_"), `${actor}.json`);
}

/**
 * The store for one application. `credentials` are what a person typed; `session` is the
 * browser's storageState after a sign-in worked. Either may be absent.
 */
export class ActorStore {
  constructor({ root = actorStoreRoot() } = {}) {
    this.root = root;
  }

  read(target, actorName = "default") {
    const host = hostKey(target);
    const actor = normalizeActorName(actorName);
    const file = recordPath(this.root, host, actor);
    let sealed;
    try { sealed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
    try {
      const record = unseal(derive(this.root, host, actor), `${host}/${actor}`, sealed);
      return { host, actor, ...record };
    } catch {
      // A record that does not authenticate is treated as absent, never as partially trusted.
      return null;
    }
  }

  write(target, actorName, record) {
    const host = hostKey(target);
    const actor = normalizeActorName(actorName);
    const prior = this.read(target, actor) || {};
    const next = {
      credentials: record.credentials ?? prior.credentials ?? null,
      session: record.session ?? prior.session ?? null,
      updatedAt: new Date().toISOString(),
      sessionSavedAt: record.session ? new Date().toISOString() : (prior.sessionSavedAt ?? null),
    };
    const file = recordPath(this.root, host, actor);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const sealed = seal(derive(this.root, host, actor), `${host}/${actor}`, next);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sealed), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { host, actor, sessionSavedAt: next.sessionSavedAt };
  }

  forget(target, actorName = "default") {
    const host = hostKey(target);
    const actor = normalizeActorName(actorName);
    try { fs.rmSync(recordPath(this.root, host, actor), { force: true }); return true; } catch { return false; }
  }

  // Names only — this is what a UI may show. Never the records.
  list(target) {
    const host = hostKey(target);
    const dir = path.dirname(recordPath(this.root, host, "x"));
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)); } catch { return []; }
    return names.map((actor) => {
      const record = this.read(target, actor);
      return { actor, hasCredentials: !!record?.credentials, hasSession: !!record?.session, sessionSavedAt: record?.sessionSavedAt || null };
    });
  }

  // Playwright wants storageState as a file path or an object; a path keeps the object out of
  // argument lists and logs. The file is 0600 and removed by the caller after the context opens.
  sessionFile(target, actorName = "default") {
    const record = this.read(target, actorName);
    if (!record?.session) return null;
    const dir = path.join(os.tmpdir(), "tapp-sessions");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${crypto.randomBytes(8).toString("hex")}.json`);
    fs.writeFileSync(file, JSON.stringify(record.session), { mode: 0o600 });
    return file;
  }
}

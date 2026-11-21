import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AccountStore, normalizeEmail, LINK_TTL_MS, SESSION_TTL_MS, TRIAL_MS } from "../mcp-server/src/account-store.js";
import { createMailer, signInMessage } from "../mcp-server/src/mailer.js";

const fresh = (clock = { t: Date.parse("2026-10-22T12:00:00Z") }) => ({ store: new AccountStore({ root: fs.mkdtempSync(path.join(os.tmpdir(), "tapp-accounts-")), now: () => clock.t }), clock });

test("a link signs in once, and the same address is the same account next time", () => {
  const { store } = fresh();
  const { token } = store.requestLink("  Sam@Example.TEST ");
  const first = store.redeem(token);
  assert.ok(first, "a fresh link signs in");
  assert.equal(first.account.email, "sam@example.test", "addresses are normalised");
  assert.equal(store.redeem(token), null, "a link works once");

  const again = store.redeem(store.requestLink("sam@example.test").token);
  assert.equal(again.account.id, first.account.id, "one address, one account");
  assert.notEqual(again.session, first.session, "every sign-in is its own session");
  assert.equal(store.sessionAccount(first.session).id, first.account.id, "the earlier session still works");
});

test("links and sessions expire, and signing out ends a session", () => {
  const { store, clock } = fresh();
  const { token } = store.requestLink("a@b.test");
  clock.t += LINK_TTL_MS + 1;
  assert.equal(store.redeem(token), null, "an old link is refused");

  const { session } = store.redeem(store.requestLink("a@b.test").token);
  assert.ok(store.sessionAccount(session));
  store.signOut(session);
  assert.equal(store.sessionAccount(session), null, "signed out");

  const { session: later } = store.redeem(store.requestLink("a@b.test").token);
  clock.t += SESSION_TTL_MS + 1;
  assert.equal(store.sessionAccount(later), null, "a session does not last forever");
});

test("nothing on disk signs anyone in", () => {
  const { store } = fresh();
  const { token } = store.requestLink("a@b.test");
  const { session } = store.redeem(store.requestLink("a@b.test").token);
  const everything = fs.readdirSync(store.root, { recursive: true })
    .map((entry) => path.join(store.root, String(entry)))
    .filter((file) => fs.statSync(file).isFile())
    .map((file) => `${file}\n${fs.readFileSync(file, "utf8")}`)
    .join("\n");
  assert.doesNotMatch(everything, new RegExp(token.slice(0, 16)), "the link token is only ever hashed");
  assert.doesNotMatch(everything, new RegExp(session.slice(0, 16)), "the session token is only ever hashed");
  assert.doesNotMatch(everything, /by-email\/[^\n]*a@b\.test/, "the email index is hashed too");
  assert.equal(store.redeem("not-a-token"), null);
  assert.equal(store.sessionAccount("x"), null);
});

test("one address cannot be flooded through us", () => {
  const { store } = fresh();
  for (let i = 0; i < 5; i += 1) store.requestLink("a@b.test");
  assert.throws(() => store.requestLink("a@b.test"), /already sent/);
  assert.doesNotThrow(() => store.requestLink("other@b.test"), "the limit is per address");
});

test("every account has its own place for test accounts", () => {
  const { store } = fresh();
  const { account } = store.redeem(store.requestLink("a@b.test").token);
  assert.equal(store.actorRoot(account.id), path.join(store.root, "actors", account.id));
  assert.throws(() => store.actorRoot("../x"), /account id/);
  assert.throws(() => normalizeEmail("nope"), /email address/);
});

test("without a mail provider the link goes to a private outbox, never a log", async () => {
  const outbox = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-outbox-"));
  const mailer = createMailer({ TAPP_MAIL_OUTBOX: outbox });
  assert.equal(mailer.transport, "outbox");
  const sent = await mailer.send(signInMessage({ to: "a@b.test", link: "https://app.runtapp.com/auth/TOKEN-XYZ", origin: "https://app.runtapp.com" }));
  assert.equal(fs.statSync(sent.file).mode & 0o777, 0o600);
  const eml = fs.readFileSync(sent.file, "utf8");
  assert.match(eml, /To: a@b\.test/);
  assert.match(eml, /https:\/\/app\.runtapp\.com\/auth\/TOKEN-XYZ/);
  assert.match(eml, /works once and expires/);
  assert.equal(createMailer({ TAPP_MAIL_RESEND_KEY: "re_x", TAPP_MAIL_FROM: "tapp <hello@runtapp.com>" }).transport, "resend");
  assert.equal(createMailer({ TAPP_MAIL_RESEND_KEY: "re_x", TAPP_MAIL_OUTBOX: outbox }).transport, "outbox", "a key without a from address is not a provider");
});

test("a personal access token acts as its account, is shown once, and is revoked by name", () => {
  const { store } = fresh();
  const { account } = store.redeem(store.requestLink("owner@example.test").token);
  const other = store.redeem(store.requestLink("someone@else.test").token).account;

  const issued = store.issueToken(account.id, "  Claude Code  ");
  assert.match(issued.token, /^tapp_[A-Za-z0-9_-]{20,}$/);
  assert.equal(issued.label, "Claude Code", "the label is trimmed, not the token");
  assert.equal(store.tokenAccount(issued.token).id, account.id);
  assert.equal(store.tokenAccount(`${issued.token}x`), null, "a near-miss is not a token");
  assert.equal(store.tokenAccount("not-a-token"), null);
  assert.equal(store.tokenAccount(""), null);

  // Listing shows labels and dates; the value is never recoverable from the store.
  const [listed] = store.listTokens(account.id);
  assert.equal(listed.label, "Claude Code");
  assert.equal(listed.id, issued.id);
  assert.ok(listed.createdAt);
  assert.deepEqual(store.listTokens(other.id), [], "one account never sees another's tokens");
  const everything = fs.readdirSync(store.root, { recursive: true })
    .map((entry) => path.join(store.root, String(entry)))
    .filter((file) => fs.statSync(file).isFile())
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  assert.doesNotMatch(everything, new RegExp(issued.token.slice(6, 26)), "only the hash is on disk");

  // Revocation is per account: another account cannot revoke this one's token.
  assert.equal(store.revokeToken(other.id, issued.id), false);
  assert.equal(store.tokenAccount(issued.token).id, account.id, "still valid");
  assert.equal(store.revokeToken(account.id, issued.id), true);
  assert.equal(store.tokenAccount(issued.token), null, "revoked");
  assert.deepEqual(store.listTokens(account.id), []);
  assert.throws(() => store.issueToken("../x"), /account id/);
});

test("a new account is on a free trial, a lapsed one is not, and the owner can change that (ADR-0011 §3)", () => {
  const { store, clock } = fresh();
  const { account } = store.signIn("new@example.test");
  let plan = store.entitlement(account);
  assert.equal(plan.kind, "trial");
  assert.equal(plan.allowed, true);
  assert.equal(plan.daysLeft, 14, "fourteen days, counted from signing up");

  clock.t += TRIAL_MS + 1;
  plan = store.entitlement(account.id);
  assert.equal(plan.kind, "lapsed");
  assert.equal(plan.allowed, false);
  assert.equal(plan.daysLeft, 0);

  // The owner's word: thirty more days from today, or paid for good.
  assert.equal(store.setPlan(account.id, { kind: "trial", days: 30 }).daysLeft, 30);
  assert.equal(store.entitlement(account.id).allowed, true);
  assert.equal(store.setPlan(account.id, { kind: "paid" }).kind, "paid");
  clock.t += 10 * TRIAL_MS;
  assert.equal(store.entitlement(account.id).allowed, true, "paid has no end");
  assert.throws(() => store.setPlan(account.id, { kind: "trial", days: 0 }), /1 to 365 days/);
  assert.throws(() => store.setPlan(account.id, { kind: "gold" }), /'paid' or 'trial'/);
  assert.throws(() => store.setPlan("0".repeat(24), { kind: "paid" }), /No such account/);
});

test("an account from before plans existed gets its trial from the day it is next seen, not the day it joined", () => {
  const { store, clock } = fresh();
  const { account } = store.signIn("old@example.test");
  // Strip the plan the way an older release would have written the record.
  const file = path.join(store.root, "accounts", `${account.id}.json`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  delete record.plan;
  fs.writeFileSync(file, JSON.stringify(record));
  clock.t += 200 * 86_400_000; // joined two hundred days ago
  const plan = store.entitlement(account.id);
  assert.equal(plan.kind, "trial");
  assert.equal(plan.daysLeft, 14, "a change in the rules never locks out someone already here");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).plan.kind, "trial", "and it is written down once");
});

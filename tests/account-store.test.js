import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AccountStore, normalizeEmail, LINK_TTL_MS, SESSION_TTL_MS } from "../mcp-server/src/account-store.js";
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

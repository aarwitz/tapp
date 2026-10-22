import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ActorStore, hostKey, normalizeActorName } from "../mcp-server/src/actor-store.js";

const fresh = () => new ActorStore({ root: fs.mkdtempSync(path.join(os.tmpdir(), "tapp-actors-")) });

test("what tapp is told about an account comes back, and only to the right app and actor", () => {
  const store = fresh();
  store.write("https://app.example.com/login?next=/dash", "client", { credentials: { email: "sam@example.test", password: "hunter2" } });

  const record = store.read("https://app.example.com/", "client");
  assert.equal(record.credentials.email, "sam@example.test");
  assert.equal(record.credentials.password, "hunter2");
  assert.equal(record.host, "app.example.com", "the application is its host, never the URL it was given on");

  // The record is bound to host and actor by the cipher's authenticated data: moving it between
  // applications or actors does not decrypt, so a mix-up cannot leak one app's login to another.
  assert.equal(store.read("https://app.example.com/", "coach"), null);
  assert.equal(store.read("https://other.example.com/", "client"), null);
});

test("nothing readable is ever on disk", () => {
  const store = fresh();
  store.write("https://app.example.com", "client", { credentials: { email: "sam@example.test", password: "S3cret-Value-XYZ" }, session: { cookies: [{ name: "sid", value: "COOKIE-VALUE-123" }] } });
  const everything = fs.readdirSync(store.root, { recursive: true })
    .map((entry) => path.join(store.root, String(entry)))
    .filter((file) => fs.statSync(file).isFile())
    .map((file) => fs.readFileSync(file).toString("latin1"))
    .join("\n");
  for (const secret of ["S3cret-Value-XYZ", "COOKIE-VALUE-123", "sam@example.test"]) {
    assert.doesNotMatch(everything, new RegExp(secret), `${secret} must not appear in plaintext anywhere in the store`);
  }
});

test("a session is kept beside credentials and either may arrive alone", () => {
  const store = fresh();
  store.write("https://app.example.com", "client", { credentials: { email: "a@b.test", password: "x" } });
  store.write("https://app.example.com", "client", { session: { cookies: [{ name: "sid", value: "1" }], origins: [] } });
  const record = store.read("https://app.example.com", "client");
  assert.equal(record.credentials.email, "a@b.test", "writing a session keeps the credentials");
  assert.equal(record.session.cookies[0].name, "sid");
  assert.ok(record.sessionSavedAt, "a saved session is dated");
});

test("the session file handed to the browser is private and short-lived", () => {
  const store = fresh();
  assert.equal(store.sessionFile("https://app.example.com", "client"), null, "no session, no file");
  store.write("https://app.example.com", "client", { session: { cookies: [], origins: [] } });
  const file = store.sessionFile("https://app.example.com", "client");
  assert.ok(fs.existsSync(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(file);
});

test("listing names actors and what they hold — never the values", () => {
  const store = fresh();
  store.write("https://app.example.com", "client", { credentials: { email: "a@b.test", password: "x" } });
  store.write("https://app.example.com", "coach", { session: { cookies: [], origins: [] } });
  const listed = store.list("https://app.example.com");
  assert.deepEqual(listed.map((a) => a.actor).sort(), ["client", "coach"]);
  const asText = JSON.stringify(listed);
  assert.doesNotMatch(asText, /a@b\.test|"x"/);
  assert.equal(listed.find((a) => a.actor === "client").hasCredentials, true);
  assert.equal(listed.find((a) => a.actor === "coach").hasSession, true);
  assert.deepEqual(store.list("https://nowhere.example.com"), []);
});

test("forgetting an actor removes it", () => {
  const store = fresh();
  store.write("https://app.example.com", "client", { credentials: { email: "a@b.test", password: "x" } });
  assert.equal(store.forget("https://app.example.com", "client"), true);
  assert.equal(store.read("https://app.example.com", "client"), null);
});

test("names are checked before they become paths", () => {
  assert.equal(hostKey("https://App.Example.com:8443/x?y=1"), "app.example.com:8443");
  assert.equal(normalizeActorName(" client "), "client");
  assert.throws(() => normalizeActorName("../etc"), /Actor name/);
  assert.equal(normalizeActorName(""), "default", "no name means the default actor");
});

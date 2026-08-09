import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureActor, credentialBindingsFromValue, readProjectConfig, validateProjectConfig } from "../mcp-server/src/project-config.js";

test("project actor configuration stores only secret bindings and never overwrites silently", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-project-config-"));
  const result = configureActor(root, {
    name: "alice", role: "member", session: "isolated", provisioning: "seeded",
    credentials: { email: { env: "TAPP_ACTOR_ALICE_EMAIL" }, password: { env: "TAPP_ACTOR_ALICE_PASSWORD" } },
  });
  assert.equal(result.actor.credentials.email.env, "TAPP_ACTOR_ALICE_EMAIL");
  assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(result.path, "utf8"), /alice@example|password-value/);
  assert.throws(() => configureActor(root, { name: "alice" }), /already exists/);
  const replaced = configureActor(root, { name: "alice", role: "admin", session: "isolated", credentials: { token: { env: "TAPP_ACTOR_ALICE_TOKEN" } }, replace: true });
  assert.equal(replaced.actor.role, "admin");
  assert.deepEqual(readProjectConfig(root).errors, []);
});

test("project configuration rejects values, malformed environment names, and cross-origin lifecycle URLs", () => {
  const base = { kind: "tapp-project-config", schemaVersion: 1, actors: { alice: { credentials: { email: { env: "ALICE_EMAIL" } } } } };
  assert.deepEqual(validateProjectConfig(base), []);
  assert.match(validateProjectConfig({ ...base, actors: { alice: { credentials: { email: { env: "ALICE_EMAIL", value: "secret" } } } } }).join("; "), /may contain only env/);
  assert.match(validateProjectConfig({ ...base, actors: { alice: { credentials: { email: { env: "bad-name" } } } } }).join("; "), /uppercase environment-variable/);
  assert.match(validateProjectConfig({ ...base, actors: { alice: { password: "secret" } } }).join("; "), /unsupported field 'password'/);
  assert.match(validateProjectConfig({ ...base, apiKey: "secret" }).join("; "), /unsupported project configuration field 'apiKey'/);
  assert.match(validateProjectConfig({ ...base, lifecycle: { setup: [{ request: { path: "https://other.test/reset" } }] } }).join("; "), /same-origin/);
  assert.match(validateProjectConfig({ ...base, lifecycle: { setup: [{ request: { path: "//other.test/reset" } }] } }).join("; "), /same-origin/);
});

test("contract credential placeholders become non-secret environment bindings", () => {
  assert.deepEqual(credentialBindingsFromValue({ email: "$ALICE_EMAIL", password: "$ALICE_PASSWORD", token: "literal" }), { email: "ALICE_EMAIL", password: "ALICE_PASSWORD" });
});

test("project configuration prefers .tapp and reads an existing .autotap project during migration", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-legacy-project-config-"));
  fs.mkdirSync(path.join(root, ".autotap"));
  fs.writeFileSync(path.join(root, ".autotap", "project.json"), JSON.stringify({ kind: "tapp-project-config", schemaVersion: 1, actors: {} }));
  assert.equal(readProjectConfig(root).relativePath, ".autotap/project.json");

  fs.mkdirSync(path.join(root, ".tapp"));
  fs.writeFileSync(path.join(root, ".tapp", "project.json"), JSON.stringify({ kind: "tapp-project-config", schemaVersion: 1, actors: { canonical: {} } }));
  assert.equal(readProjectConfig(root).relativePath, ".tapp/project.json");
  assert.ok(readProjectConfig(root).config.actors.canonical);
});

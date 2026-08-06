import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createManagedOperationEnvelope, validateManagedOperationEnvelope } from "../mcp-server/src/managed-operation.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("managed operation envelope pins repository, revision, target intent, and engine contract", () => {
  const envelope = createManagedOperationEnvelope({
    id:"a".repeat(24),
    repository:"acme/product",
    installationId:42,
    revision:"b".repeat(40),
    platform:"ios",
    targetId:"target_ios_app",
    capabilities:["ios-simulator", "xcode-build", "ios-simulator"],
    inputs:{ actions:55, timeout:900, failOn:"critical" },
  });
  assert.equal(envelope.schemaVersion, 1);
  assert.deepEqual(envelope.repository, { provider:"github", nameWithOwner:"acme/product", installationId:42, revision:"b".repeat(40) });
  assert.deepEqual(envelope.operation, { name:"gate", platform:"ios", targetId:"target_ios_app" });
  assert.deepEqual(envelope.capabilities, ["ios-simulator", "xcode-build"]);
  assert.match(envelope.engine.version, /^\d+\.\d+\.\d+/);
});

test("managed operation envelope rejects floating revisions and unknown semantics", () => {
  assert.throws(() => createManagedOperationEnvelope({ id:"a".repeat(24), repository:"acme/product", installationId:42, revision:"main" }), /exact 40-character Git revision/);
  const valid = createManagedOperationEnvelope({ id:"a".repeat(24), repository:"acme/product", installationId:42, revision:"b".repeat(40) });
  assert.throws(() => validateManagedOperationEnvelope({ ...valid, operation:{ name:"cloud-magic", platform:"ios", targetId:"" } }), /Unsupported managed product operation/);
});

test("managed child verifies the exact checkout and inspects through shared product operations", { timeout:30_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-managed-inspect-"));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><h1>Managed product</h1>");
  for (const args of [["init", "-q"], ["config", "user.email", "test@tapp.local"], ["config", "user.name", "Tapp Test"], ["add", "index.html"], ["commit", "-qm", "fixture"]]) {
    const result = spawnSync("git", args, { cwd:root, encoding:"utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd:root, encoding:"utf8" }).stdout.trim();
  const requestPath = path.join(root, "operation-request.json");
  const resultPath = path.join(root, "operation-result.json");
  const envelope = createManagedOperationEnvelope({ id:"c".repeat(24), repository:"acme/product", installationId:42, revision, operation:"inspect", capabilities:["browser"] });
  fs.writeFileSync(requestPath, JSON.stringify({ envelope, projectDir:root }));
  const child = spawnSync(process.execPath, [path.join(repositoryRoot, "cloud", "runner", "product-job.js"), requestPath, resultPath], {
    cwd:repositoryRoot,
    env:{ ...process.env, AUTOTAP_HOME:path.join(root, "tapp-home") },
    encoding:"utf8",
    timeout:25_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  assert.equal(result.ok, true);
  assert.equal(result.envelope.repository.revision, revision);
  assert.deepEqual(result.project.application.platforms, ["web"]);
  assert.equal(result.project.targets[0].platform, "web");
  assert.equal(fs.existsSync(path.join(root, ".autotap", "application-model.json")), true);
});

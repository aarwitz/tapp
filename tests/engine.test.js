// The engine module contract: importable without side effects (no server start), with the
// exports both surfaces (CLI verbs, MCP tools) build on — plus target-resolution behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const engine = await import("../mcp-server/src/index.js");

test("engine is import-safe and exports the shared surface", () => {
  for (const name of [
    "startMcpServer",
    "runQaIos",
    "runQaWeb",
    "captureUiTree",
    "openApp",
    "ensureBootedSim",
    "captureScreenshotImage",
    "resolveAppTarget",
    "buildAppForSim",
    "installAppOnBootedSim",
    "listInstalledUserApps",
    "findXcodeContainer",
    "explorationEnvFromArgs",
    "formatScreen",
  ]) {
    assert.equal(typeof engine[name], "function", `${name} exported`);
  }
});

test("findXcodeContainer prefers a workspace, skips Pods, accepts a container path directly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-xc-"));
  fs.mkdirSync(path.join(dir, "App", "MyApp.xcodeproj"), { recursive: true });
  fs.mkdirSync(path.join(dir, "App", "MyApp.xcworkspace"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Pods", "Decoy.xcodeproj"), { recursive: true });

  const picked = engine.findXcodeContainer(dir);
  assert.ok(picked.endsWith("MyApp.xcworkspace"), `workspace preferred, got ${picked}`);

  const direct = engine.findXcodeContainer(path.join(dir, "App", "MyApp.xcodeproj"));
  assert.ok(direct.endsWith("MyApp.xcodeproj"), "a container path resolves to itself");

  fs.rmSync(path.join(dir, "App", "MyApp.xcworkspace"), { recursive: true });
  const projOnly = engine.findXcodeContainer(dir);
  assert.ok(projOnly.endsWith("MyApp.xcodeproj"), "falls back to the project");
  assert.ok(!projOnly.includes("Pods"), "Pods decoys are skipped");
});

test("explorationEnvFromArgs maps creds, overrides, and the interactive channel", () => {
  const env = engine.explorationEnvFromArgs({
    testEmail: "qa@example.com",
    testPassword: "secret",
    inputOverrides: { "id:email_field": "qa@example.com", "  ": "dropped", empty: "" },
    interactive: true,
    interactiveResponsePath: "/tmp/resp.json",
  });
  assert.equal(env.OCQA_TEST_EMAIL, "qa@example.com");
  assert.equal(env.OCQA_TEST_PASSWORD, "secret");
  assert.equal(env.OCQA_INTERACTIVE_INPUT, "1");
  assert.equal(env.OCQA_INPUT_RESPONSE_PATH, "/tmp/resp.json");
  const overrides = JSON.parse(env.OCQA_INPUT_OVERRIDES_JSON);
  assert.deepEqual(overrides, { "id:email_field": "qa@example.com" }, "blank keys/values dropped");
});

test("interactive channel is NOT enabled without a response path", () => {
  const env = engine.explorationEnvFromArgs({ interactive: true });
  assert.equal(env.OCQA_INTERACTIVE_INPUT, undefined);
});

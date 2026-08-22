// The engine module contract: importable without side effects (no server start), with the
// exports both surfaces (CLI verbs, MCP tools) build on — plus target-resolution behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storagePreflight } from "../mcp-server/src/environment-preflight.js";

const engine = await import("../mcp-server/src/index.js");

test("storage preflight blocks a full evidence volume before it can become a false app crash", () => {
  const result = storagePreflight(process.cwd(), { statfs: () => ({ bavail: 10, bsize: 4096 }) });
  assert.equal(result.ok, false);
  assert.equal(result.level, "blocked");
  assert.match(result.message, /run was not started.*no app-crash finding/i);
});

test("storage preflight warns while preserving a usable volume", () => {
  const result = storagePreflight(process.cwd(), { statfs: () => ({ bavail: 500_000, bsize: 4096 }) });
  assert.equal(result.ok, true);
  assert.equal(result.level, "warning");
  assert.match(result.message, /iOS builds can require several GiB/);
});

test("coordinate session taps resolve to the smallest semantic element under the point", () => {
  const target = engine.semanticTargetAtPoint([
    { id:"container", hittable:true, frame:{ x:0, y:0, width:300, height:300 } },
    { id:"settings-tab", label:"Settings", hittable:true, frame:{ x:220, y:250, width:70, height:40 } },
  ], 250, 270);
  assert.equal(target, "settings-tab");
});

test("engine is import-safe and exports the shared surface", () => {
  for (const name of [
    "startMcpServer",
    "runQaIos",
    "runQaWeb",
    "runQaAndroid",
    "runExploreTarget",
    "startManagedWebTarget",
    "stopManagedWebTarget",
    "buildAndroidApp",
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
    "qaNextSteps",
    "recordingUnavailableReason",
  ]) {
    assert.equal(typeof engine[name], "function", `${name} exported`);
  }
});

test("native recording failures become concise actionable evidence warnings", () => {
  assert.match(engine.recordingUnavailableReason("Host recording is already in progress — Resource busy"), /recorder is busy/);
  assert.match(engine.recordingUnavailableReason("WARNING: Could not start simulator video recording"), /could not start/);
  assert.match(engine.recordingUnavailableReason(""), /did not produce/);
});

test("runExploreTarget refuses to guess without an application model", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-explore-nomodel-"));
  const r = await engine.runExploreTarget({ projectDir: dir });
  assert.ok(r.error && /application model/i.test(r.error), r.error);
});

test("runExploreTarget surfaces an unreadable application model instead of falling back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-explore-badmodel-"));
  fs.mkdirSync(path.join(dir, ".tapp"));
  fs.writeFileSync(path.join(dir, ".tapp", "application-model.json"), "{ not json");
  const r = await engine.runExploreTarget({ projectDir: dir });
  assert.ok(r.error && /unreadable/i.test(r.error), r.error);
});

test("runExploreTarget stops (does not silently pick) when the model target is ambiguous", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-explore-ambiguous-"));
  fs.mkdirSync(path.join(dir, ".tapp"));
  fs.writeFileSync(path.join(dir, ".tapp", "application-model.json"), JSON.stringify({
    kind: "tapp-application-model",
    application: { name: "multi", platforms: ["web"], targetIds: ["a", "b"] },
    targets: [
      { id: "a", platform: "web", name: "A", sourcePath: "a", runtime: { ownedUrl: null } },
      { id: "b", platform: "web", name: "B", sourcePath: "b", runtime: { ownedUrl: null } },
    ],
    requirements: [],
  }));
  const r = await engine.runExploreTarget({ projectDir: dir });
  assert.ok(r.error && /select one with --target/i.test(r.error), r.error);
});

test("runExploreTarget requires a confirmed Android application id before building", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-explore-android-"));
  fs.mkdirSync(path.join(dir, ".tapp"));
  fs.writeFileSync(path.join(dir, ".tapp", "application-model.json"), JSON.stringify({
    kind: "tapp-application-model",
    application: { name: "droid", platforms: ["android"], targetIds: ["app"] },
    targets: [
      { id: "app", platform: "android", name: "app", sourcePath: "app",
        build: { tool: "gradle-wrapper", projectDir: ".", task: ":app:assembleDebug" },
        runtime: { applicationId: null } },
    ],
    requirements: [],
  }));
  const r = await engine.runExploreTarget({ projectDir: dir });
  assert.ok(r.error && /application id/i.test(r.error), r.error);
});

test("QA next steps match the package-only surface without leaking MCP calls", () => {
  const next = engine.qaNextSteps({ findings: [{ type: "missing_asset" }] }, "cli");
  assert.match(next.join(" "), /npx -y @aarwitz\/tapp@latest report latest/);
  assert.match(next.join(" "), /--baseline <report\.json>/);
  assert.match(next.join(" "), /npx -y @aarwitz\/tapp@latest flow run <file>/);
  assert.doesNotMatch(next.join(" "), /tapp_open_app|baselineFindings|tapp_session_start/);
});

test("long Xcode output retains the final actionable compiler error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-xcode-tail-"));
  const bin = path.join(dir, "bin");
  const project = path.join(dir, "Product.xcodeproj");
  fs.mkdirSync(bin);
  fs.mkdirSync(project);
  const fakeXcodebuild = path.join(bin, "xcodebuild");
  fs.writeFileSync(fakeXcodebuild, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeSync(1, "build noise\\n".repeat(8000));
fs.writeSync(1, "/fixture/Product.swift:1:1: error: The file update.sample could not be opened\\n");
process.exit(65);
`);
  fs.chmodSync(fakeXcodebuild, 0o755);
  const moduleUrl = new URL("../mcp-server/src/index.js", import.meta.url).href;
  const script = `
    const engine = await import(${JSON.stringify(moduleUrl)});
    const result = await engine.buildAppForSim({ container:${JSON.stringify(project)}, scheme:"Product" });
    process.stdout.write(JSON.stringify(result));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`, TAPP_HOME: path.join(dir, "home") },
  }));
  assert.match(result.error, /Build failed \(scheme Product\)/);
  assert.match(result.details.errors.join("\n"), /update\.sample/);
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
  assert.equal(env.OCQA_CREDENTIALS_EXPLICIT, "1");
  assert.equal(env.OCQA_INTERACTIVE_INPUT, "1");
  assert.equal(env.OCQA_INPUT_RESPONSE_PATH, "/tmp/resp.json");
  const overrides = JSON.parse(env.OCQA_INPUT_OVERRIDES_JSON);
  assert.deepEqual(overrides, { "id:email_field": "qa@example.com" }, "blank keys/values dropped");
});

test("interactive channel is NOT enabled without a response path", () => {
  const env = engine.explorationEnvFromArgs({ interactive: true });
  assert.equal(env.OCQA_INTERACTIVE_INPUT, undefined);
});

test("remote AI requires explicit opt-in — an ambient API key is not consent", () => {
  assert.equal(engine.remoteAiOptedIn({ ANTHROPIC_API_KEY: "sk-ant-ambient" }), false);
  assert.equal(engine.remoteAiOptedIn({ ANTHROPIC_API_KEY: "sk", TAPP_ENABLE_REMOTE_AI: "1" }), true);
  assert.equal(engine.remoteAiOptedIn({ TAPP_ENABLE_REMOTE_AI: "true" }), true);
  assert.equal(engine.remoteAiOptedIn({ TAPP_SUBSCRIPTION_TOKEN: "tok" }), true, "Tapp subscription token is explicit");
  assert.equal(engine.remoteAiOptedIn({ AUTOTAP_SUBSCRIPTION_TOKEN: "tok" }), false, "the retired AUTOTAP_ token is no longer honored");
  assert.equal(engine.remoteAiOptedIn({}), false);
});

test("isInsideDir rejects sibling directories sharing a path prefix", () => {
  assert.equal(engine.isInsideDir("/repos/tapp", "/repos/tapp/flows/x.yml"), true);
  assert.equal(engine.isInsideDir("/repos/tapp", "/repos/tapp"), true);
  assert.equal(engine.isInsideDir("/repos/tapp", "/repos/tapp-malicious/x.yml"), false);
  assert.equal(engine.isInsideDir("/repos/tapp", "/repos/tapp/../evil"), false);
});

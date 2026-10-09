// Real simulator regressions for public issues #25–#28. DemoApp must already be built and
// installed; CI's iOS Action does that first. Run locally with TAPP_RUN_IOS_REGRESSIONS=1.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const { TappBridge } = createRequire(import.meta.url)("../vscode-extension/bridge.js");

const enabled = process.platform === "darwin" && process.env.TAPP_RUN_IOS_REGRESSIONS === "1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin/tapp.js");
const app = "io.github.aarwitz.tapp.demoapp";
const tappHome = process.env.TAPP_HOME || path.join(os.homedir(), ".tapp");
let evidence;

function run(args, { cwd = root, expected = 0, name } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    // 10 minutes: the first explore on a hosted macOS runner builds the harness; 300s timed out
    // on 2026-10-09 with the engine at 1/1 actions. The outer test budget is 900s per run.
    cwd, encoding: "utf8", timeout: 600_000, maxBuffer: 5_000_000,
    env: { ...process.env, TAPP_HOME: tappHome },
  });
  fs.writeFileSync(path.join(evidence, `${name}.log`), `${result.stdout || ""}\n${result.stderr || ""}`);
  assert.equal(result.status, expected, `${name}: ${result.error || ""}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function container(kind) {
  const result = spawnSync("xcrun", ["simctl", "get_app_container", "booted", app, kind], { encoding: "utf8" });
  assert.equal(result.status, 0, "Build and install DemoApp before running iOS regressions");
  return result.stdout.trim();
}

test("iOS login, installed inspection, content response, and flow evidence", { skip: !enabled, timeout: 900_000 }, async (t) => {
  fs.mkdirSync(path.join(tappHome, "captures"), { recursive: true });
  evidence = fs.mkdtempSync(path.join(tappHome, "captures", "ios-issue-regressions-"));
  console.log(`iOS regression evidence: ${evidence}`);

  await t.test("extension open then login replaces prefilled credentials on a screen without a navigation bar", async () => {
    const previous = process.env.OCQA_APP_LAUNCH_ENV_JSON;
    process.env.OCQA_APP_LAUNCH_ENV_JSON = JSON.stringify({ TAPP_DEMO_LOGIN_CASE: "prefilled" });
    const bridge = new TappBridge({ cwd: root, command: process.execPath, args: [cli, "mcp"] });
    try {
      const opening = bridge.openTarget(app, root);
      const login = bridge.login("qa@tapp.test", "test-secret");
      const [opened, signedIn] = await Promise.all([opening, login]);
      fs.writeFileSync(path.join(evidence, "interactive-login.json"), JSON.stringify({ opened, signedIn }, null, 2));
      assert.equal(opened.error, undefined, opened.error);
      assert.match(opened.text, /Prefilled sign in/);
      assert.equal(signedIn.error, undefined, signedIn.error);
      assert.match(signedIn.text, /Authenticated fixture/);
      const screenshot = await bridge.screenshot();
      assert.ok(screenshot.image, screenshot.error);
      fs.writeFileSync(path.join(evidence, "interactive-login.jpg"), screenshot.image.data);
    } finally {
      await bridge.dispose();
      if (previous === undefined) delete process.env.OCQA_APP_LAUNCH_ENV_JSON;
      else process.env.OCQA_APP_LAUNCH_ENV_JSON = previous;
    }
  });

  await t.test("actor Flow runs from the first wait through login on a screen without a navigation bar", () => {
    const cwd = path.join(evidence, "login-repository");
    fs.mkdirSync(path.join(cwd, ".tapp"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".tapp/project.json"), JSON.stringify({ kind: "tapp-project-config", schemaVersion: 1,
      actors: { coach: { credentials: { email: { env: "TAPP_FIXTURE_EMAIL" }, password: { env: "TAPP_FIXTURE_PASSWORD" } } } } }));
    const flow = path.join(cwd, "login.json");
    fs.writeFileSync(flow, JSON.stringify({ name: "prefilled-login", platform: "ios", app, steps: [
      { wait_for: "Email" }, { login: {} }, { assert_exists: "Authenticated fixture" },
    ] }));
    const prior = { email: process.env.TAPP_FIXTURE_EMAIL, password: process.env.TAPP_FIXTURE_PASSWORD };
    process.env.TAPP_FIXTURE_EMAIL = "qa@tapp.test";
    process.env.TAPP_FIXTURE_PASSWORD = "test-secret";
    try {
      const result = run(["flow", "run", flow, "--actor", "coach", "--launch-env", JSON.stringify({ TAPP_DEMO_LOGIN_CASE: "prefilled" })], { cwd, name: "actor-login-flow" });
      assert.match(result.stdout, /3\/3 steps/);
    } finally {
      if (prior.email === undefined) delete process.env.TAPP_FIXTURE_EMAIL; else process.env.TAPP_FIXTURE_EMAIL = prior.email;
      if (prior.password === undefined) delete process.env.TAPP_FIXTURE_PASSWORD; else process.env.TAPP_FIXTURE_PASSWORD = prior.password;
    }
  });

  await t.test("bare tree in an Xcode repository preserves the installed binary and app data", () => {
    const cwd = path.join(evidence, "repository");
    fs.mkdirSync(path.join(cwd, "App.xcodeproj"), { recursive: true });
    fs.mkdirSync(path.join(cwd, ".tapp"));
    fs.writeFileSync(path.join(cwd, ".tapp/application-model.json"), JSON.stringify({
      kind: "tapp-application-model", targets: [{ id: "fixture", platform: "ios", runtime: { bundleId: app } }],
    }));
    const installed = container("app");
    const binary = path.join(installed, "DemoApp");
    const hash = () => crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
    const before = hash();
    const sentinel = path.join(container("data"), "Documents", "tapp-inspection-sentinel.txt");
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, "preserve sandbox state");
    try {
      const result = run(["tree", "--json"], { cwd, name: "tree" });
      assert.ok(JSON.parse(result.stdout).elements.length > 0);
      assert.equal(container("app"), installed);
      assert.equal(hash(), before);
      assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve sandbox state");
    } finally { fs.rmSync(sentinel, { force: true }); }
  });

  for (const mode of ["immediate", "delayed", "selected", "dead"]) {
    await t.test(`${mode} date response`, () => {
      const reportPath = path.join(evidence, `${mode}.json`);
      run(["explore", app, "--actions", "1", "--timeout", "100", "--launch-env",
        JSON.stringify({ TAPP_DEMO_CONTENT_CASE: mode }), "--json", reportPath], { name: mode });
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      assert.equal(report.actionsPerformed, 1, "must actually tap the date control");
      const markers = fs.readFileSync(path.join(report.capture.path, "ocqa-markers.txt"), "utf8");
      assert.match(markers, /OCQA_ACTION:.*"target":"choose-date"/);
      const initial = markers.split("\n").find((line) => line.startsWith("OCQA_STATE:{"));
      assert.match(initial, /TIMES — THU, OCT 1/, "startup must not tap the date control before recording it");
      const noOps = report.findings.filter((finding) => finding.type === "unresponsive_element");
      assert.equal(noOps.length, mode === "dead" ? 1 : 0, JSON.stringify(report.findings));
      if (mode === "dead") assert.equal(noOps[0].target, "FR, 2");
    });
  }

  for (const fail of [false, true]) {
    await t.test(`${fail ? "failing" : "passing"} flow exposes PNG evidence`, () => {
      const name = fail ? "flow-fail" : "flow-pass";
      const source = path.join(evidence, `${name}.json`);
      fs.writeFileSync(source, JSON.stringify({ name, platform: "ios", app, steps: [
        { tap: "choose-date" },
        { assert_exists: { target: fail ? "Missing appointment" : "TIMES — FRI, OCT 2", timeoutMs: 750 } },
      ] }));
      const result = run(["flow", "run", source, "--launch-env", JSON.stringify({ TAPP_DEMO_CONTENT_CASE: "immediate" })], { name, expected: fail ? 1 : 0 });
      const folder = result.stdout.match(/Evidence: (.+)/)?.[1]?.trim();
      assert.ok(folder, result.stdout);
      const files = ["flow-final.png", ...(fail ? ["flow-failure-2.png"] : [])];
      for (const file of files) {
        const png = fs.readFileSync(path.join(folder, file));
        assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
        assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0);
      }
      assert.doesNotMatch(fs.readFileSync(path.join(folder, "flow.log"), "utf8"), /OCQA_EVIDENCE_WARNING:/);
    });
  }
});

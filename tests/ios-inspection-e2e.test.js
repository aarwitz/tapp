// Real simulator regressions for public issues #25–#27. DemoApp must already be built and
// installed; CI's iOS Action does that first. Run locally with TAPP_RUN_IOS_REGRESSIONS=1.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const enabled = process.platform === "darwin" && process.env.TAPP_RUN_IOS_REGRESSIONS === "1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin/tapp.js");
const app = "io.github.aarwitz.tapp.demoapp";
const tappHome = process.env.TAPP_HOME || path.join(os.homedir(), ".tapp");
let evidence;

function run(args, { cwd = root, expected = 0, name } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: "utf8", timeout: 300_000, maxBuffer: 5_000_000,
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

test("installed inspection, content response, and flow evidence on iOS", { skip: !enabled, timeout: 900_000 }, async (t) => {
  fs.mkdirSync(path.join(tappHome, "captures"), { recursive: true });
  evidence = fs.mkdtempSync(path.join(tappHome, "captures", "ios-issue-regressions-"));
  console.log(`iOS regression evidence: ${evidence}`);

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

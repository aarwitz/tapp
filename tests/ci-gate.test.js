// Cheap preflight checks must fail before Tapp spends macOS minutes booting a simulator.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gate = path.join(root, "scripts", "ci-gate.sh");

function preflight(extraArgs = [], env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-ci-preflight-"));
  const app = path.join(dir, "Fixture.app");
  fs.mkdirSync(app);
  return spawnSync("bash", [gate, "--app", app, "--bundle-id", "com.example.fixture", ...extraArgs], {
    encoding: "utf8",
    env: {
      ...process.env,
      OCQA_APP_LAUNCH_ARGS_JSON: "",
      OCQA_APP_LAUNCH_ENV_JSON: "",
      OCQA_LOGIN_STEPS_JSON: "",
      ...env,
    },
  });
}

test("CI gate rejects a missing explicit baseline before simulator work", () => {
  const r = preflight(["--baseline", "/definitely/missing/tapp-baseline.json"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Baseline not found/);
  assert.doesNotMatch(r.stdout, /Simulator/);
});

test("CI gate rejects an explicit Flow glob that matches nothing", () => {
  const r = preflight(["--flows", "/definitely/missing/*.yml"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--flows matched no files/);
  assert.doesNotMatch(r.stdout, /Simulator/);
});

test("CI gate rejects an explicit Scenario glob that matches nothing", () => {
  const r = preflight(["--scenarios", "/definitely/missing/*.yml"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--scenarios matched no files/);
  assert.doesNotMatch(r.stdout, /Simulator/);
});

test("CI gate rejects an explicit release Contract glob that matches nothing", () => {
  const r = preflight(["--contracts", "/definitely/missing/*.contract.ts"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--contracts matched no files/);
});

test("CI gate validates structured launch inputs before simulator work", () => {
  const r = preflight([], { OCQA_APP_LAUNCH_ENV_JSON: "[]" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /OCQA_APP_LAUNCH_ENV_JSON must be a valid JSON object/);
  assert.doesNotMatch(r.stdout, /Simulator/);
});

test("cross-platform gate rejects a Flow suite for the wrong platform before launch", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-ci-platform-"));
  const flow = path.join(dir, "android.yml");
  fs.writeFileSync(flow, "name: Android only\nplatform: android\napp: com.example\nsteps:\n  - assert_screen: Home\n");
  const r = spawnSync("bash", [gate, "--platform", "web", "--url", "http://127.0.0.1:9", "--flows", flow], {
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /None of the supplied Flows target platform 'web'/);
});

test("default discovery safely ignores another platform's entire Flow suite", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-ci-default-platform-"));
  const flows = path.join(dir, ".autotap", "flows");
  fs.mkdirSync(flows, { recursive: true });
  fs.writeFileSync(path.join(flows, "browser.yml"), "name: Browser only\nplatform: web\nurl: https://example.test\nsteps:\n  - assert_screen: Home\n");
  const r = spawnSync("bash", [gate,
    "--platform", "ios", "--project-dir", dir,
    "--app", path.join(dir, "missing.app"), "--bundle-id", "com.example.fixture",
  ], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Required: --app/);
  assert.doesNotMatch(r.stderr, /unbound variable|None of the supplied Flows/);
});

test("CI gate turns a changed-file manifest into the actual selected contract set before simulator work", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-ci-pr-plan-"));
  const tasks = path.join(dir, ".autotap", "tasks");
  const contracts = path.join(dir, ".autotap", "contracts");
  fs.mkdirSync(tasks, { recursive: true });
  fs.mkdirSync(contracts, { recursive: true });
  fs.writeFileSync(path.join(tasks, "launch.json"), JSON.stringify({ kind: "task", version: 1, name: "launchApp", steps: [{ tap: "Continue" }] }));
  const source = (name, criticality, task) => `import { defineContract } from "tapp-mcp/contracts";\nexport default defineContract({name:${JSON.stringify(name)},title:${JSON.stringify(name)},businessValue:"value",criticality:${JSON.stringify(criticality)},platforms:["ios"],actors:{customer:{}},steps:[{actor:"customer",task:${JSON.stringify(task)}}]});`;
  fs.writeFileSync(path.join(contracts, "critical.contract.ts"), source("mustRun", "critical", "launchApp"));
  // This is valid authoring input but cannot compile because the Task is absent. It
  // proves a skipped contract never reaches compilation/execution.
  fs.writeFileSync(path.join(contracts, "unrelated.contract.ts"), source("unrelated", "high", "missingTask"));
  const changes = path.join(dir, "changed.json");
  const planPath = path.join(dir, "plan.json");
  fs.writeFileSync(changes, JSON.stringify(["README.md"]));
  const relativeProjectDir = path.relative(root, dir);
  const r = spawnSync("bash", [gate,
    "--platform", "ios", "--app", path.join(dir, "missing.app"), "--bundle-id", "com.example.fixture",
    "--project-dir", relativeProjectDir, "--changed-files-file", changes, "--pr-plan-out", planPath,
  ], { encoding: "utf8", cwd: root });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /PR selection: 1 release contract/);
  assert.match(r.stderr, /Required: --app/);
  assert.doesNotMatch(r.stderr, /Could not compile release contract/);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  assert.deepEqual(plan.selected.map((item) => item.name), ["mustRun"]);
  assert.deepEqual(plan.skipped.map((item) => item.name), ["unrelated"]);
});

test("a valid PR plan selecting zero contracts survives Bash 3.2 nounset handling", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-ci-pr-empty-selection-"));
  fs.mkdirSync(path.join(dir, ".autotap"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".autotap", "ui-map.json"), JSON.stringify({ schemaVersion: 1, nodes: [], edges: [], coverage: {} }));
  const changes = path.join(dir, "changed.json");
  const planPath = path.join(dir, "plan.json");
  fs.writeFileSync(changes, JSON.stringify(["README.md"]));
  const r = spawnSync("bash", [gate,
    "--platform", "ios", "--app", path.join(dir, "missing.app"), "--bundle-id", "com.example.fixture",
    "--project-dir", dir, "--changed-files-file", changes, "--pr-plan-out", planPath,
  ], { encoding: "utf8", cwd: root });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /PR selection: 0 release contract/);
  assert.match(r.stderr, /Required: --app/);
  assert.doesNotMatch(r.stderr, /unbound variable/);
  assert.deepEqual(JSON.parse(fs.readFileSync(planPath, "utf8")).selected, []);
});

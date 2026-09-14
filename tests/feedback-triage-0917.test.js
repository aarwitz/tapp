// Regression tests for the 2026-09-14 field-report batch (public issues #1 #2 #3 #5 #7).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FLOW_ACTIONS, validateFlowSteps } from "../mcp-server/src/flow-runtime.js";
import { buildQaReport } from "../mcp-server/src/report.js";
import { sessionActUsageError } from "../mcp-server/src/index.js";
import { submitFeedbackViaGh } from "../mcp-server/src/feedback.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "tapp.js");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tapp-triage-"));

test("#2 the Flow vocabulary is one table and validate rejects what cannot replay", () => {
  assert.deepEqual(FLOW_ACTIONS.map((a) => a.action), ["tap", "type", "login", "swipe", "back", "wait", "wait_for", "assert_screen", "assert_exists", "assert_absent", "assert_text", "assert_ai"]);
  assert.deepEqual(validateFlowSteps({ steps: [{ tap: "Continue" }, { assert_exists: "Dashboard" }, { type: { field: "Email", value: "x" } }] }, "ios"), []);
  const errors = validateFlowSteps({ steps: [{ tap: "201,858" }, { click: "Sign in" }, { assert_text: { of: "Total" } }] }, "web");
  assert.equal(errors.length, 3);
  assert.match(errors[0], /coordinate/);
  assert.match(errors[1], /unknown action 'click'.*did you mean 'tap'/);
  assert.match(errors[2], /assert_text needs/);
});

test("#2 tapp flow validate exits 2 on a coordinate tap and tapp flow steps prints the table", () => {
  const dir = tmp();
  const file = path.join(dir, "legacy.yml");
  fs.writeFileSync(file, "name: legacy\nplatform: ios\napp: com.example.app\nsteps:\n  - tap: 201,858\n  - assert_screen: Home\n");
  const v = spawnSync(process.execPath, [bin, "flow", "validate", file], { encoding: "utf8" });
  assert.equal(v.status, 2, v.stdout + v.stderr);
  assert.match(v.stderr, /coordinate/);
  const steps = spawnSync(process.execPath, [bin, "flow", "steps"], { encoding: "utf8" });
  assert.equal(steps.status, 0);
  assert.match(steps.stdout, /assert_screen\s+target: the detected SCREEN TITLE/);
  const json = spawnSync(process.execPath, [bin, "flow", "steps", "--json"], { encoding: "utf8" });
  assert.equal(JSON.parse(json.stdout).length, 12);
});

test("#5 a native limited_surface outcome is an honest stopReason, not 'completed'", () => {
  const dir = tmp();
  const markers = path.join(dir, "ocqa-markers.txt");
  const lines = ["OCQA_STATE:exploration_started max_actions=40", "OCQA_STATE:credentials_supplied",
    'OCQA_CONTEXT:{"device":"iPhone 17 Pro","viewport":{"width":402,"height":874},"deviceScaleFactor":3.0}'];
  for (let i = 0; i < 12; i += 1) {
    lines.push(`OCQA_STATE:{"screen":"Screen ${i}","elements":9}`);
    lines.push(`OCQA_ACTION:{"type":"tap","target":"Button ${i}","screen":"Screen ${i}","narrative":"tap"}`);
  }
  lines.push('OCQA_COMPLETE:{"actions":12,"states":12,"issues":0,"screens":"","outcome":"limited_surface"}');
  fs.writeFileSync(markers, lines.join("\n") + "\n");
  const r = buildQaReport(markers, { platform: "ios", target: "com.example" });
  assert.equal(r.stopReason, "limited-surface");
  assert.equal(r.credentialsProvided, true, "#3 the presence marker must flip credentialsProvided");
  assert.deepEqual(r.captureContext, { device: "iPhone 17 Pro", viewport: { width: 402, height: 874 }, deviceScaleFactor: 3 });
});

test("#7 a malformed session act is answered with the accepted shape instead of reaching the driver", () => {
  assert.match(sessionActUsageError({ action: "wait", seconds: 3 }), /wait needs a target \(seconds\/ms are not arguments\)\. wait takes \{text\|id/);
  assert.equal(sessionActUsageError({ action: "wait", text: "Dashboard", timeoutMs: 8000 }), null);
  assert.match(sessionActUsageError({ action: "tap" }), /tap needs an id\/label or both x and y/);
  assert.equal(sessionActUsageError({ action: "tap", x: 10, y: 20 }), null);
  assert.match(sessionActUsageError({ action: "jump" }), /Unknown action 'jump'\. Accepted:/);
});

test("#1 a flow that dies before step 1 reports the XCTest reason as the first failure", () => {
  const dir = tmp();
  const log = path.join(dir, "flow.log");
  fs.writeFileSync(log, ["OCQA_FLOW_RESULT:started total=3 name=login kind=flow",
    "t =    12.40s     Failed to synthesize event: Neither element nor any descendant has keyboard focus. Element: Application",
    "Test Case '-[OCQAHarnessUITests.ExplorerTests testReplayFlow]' failed (14.2 seconds)."].join("\n") + "\n");
  const r = spawnSync("python3", [path.join(root, "scripts", "flow_lib.py"), "report", "--json", log], { encoding: "utf8" });
  const out = JSON.parse(r.stdout);
  assert.equal(out.passed, false);
  assert.match(out.abortReason, /^Failed to synthesize event: Neither element nor any descendant has keyboard focus/);
  assert.equal(out.steps[0].status, "fail");
  const human = spawnSync("python3", [path.join(root, "scripts", "flow_lib.py"), "report", log], { encoding: "utf8" });
  assert.match(human.stdout, /keyboard focus/);
});

test("feedback submit falls back to no labels when the account cannot set them", () => {
  const dir = tmp();
  const fakeGh = path.join(dir, "gh");
  fs.writeFileSync(fakeGh, `#!/bin/sh
for a in "$@"; do [ "$a" = "--label" ] && { echo "could not add label: 'feedback' not found" >&2; exit 1; }; done
cat >/dev/null; echo "https://github.com/aarwitz/tapp/issues/42"
`);
  fs.chmodSync(fakeGh, 0o755);
  const r = submitFeedbackViaGh({ title: "t", body: "b", labels: ["feedback", "bug"] }, fakeGh);
  assert.equal(r.ok, true);
  assert.equal(r.labelsApplied, false);
  assert.equal(r.url, "https://github.com/aarwitz/tapp/issues/42");
});

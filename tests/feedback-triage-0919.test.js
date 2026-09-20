// Field report 2026-09-19 (a coaching app's pricing screen): typing into a SwiftUI TextField raced the
// keyboard, the run died on XCTest's "Neither element nor any descendant has keyboard focus",
// and the CLI reported the abandoned run as PASSED with a shrunken step count.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const harness = fs.readFileSync(path.join(root, "Harness/OCQAHarnessUITests/ExplorerTests.swift"), "utf8");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tapp-0919-"));

test("type proves keyboard focus before typeText and retries with coordinate taps", () => {
  const focus = harness.match(/private func focusForTyping[\s\S]*?\n    }\n\n    \/\/ Replace existing field contents/)?.[0] || "";
  assert.ok(focus, "focusForTyping exists");
  assert.match(focus, /hasKeyboardFocus/);
  assert.match(focus, /for attempt in 0\.\.<3/);
  assert.match(focus, /coordinate\(withNormalizedOffset: CGVector\(dx: 0\.5, dy: 0\.5\)\)\.tap\(\)/);
  assert.match(focus, /OCQA_STATE:type_focus_miss/);
  const replace = harness.match(/private func replaceText\(on element: XCUIElement, with text: String\) -> Bool[\s\S]*?\n    }\n}/)?.[0] || "";
  assert.ok(replace, "replaceText returns Bool");
  assert.match(replace, /guard focusForTyping\(element\) else/);
  assert.match(replace, /OCQA_STATE:type_focus_failed/);
  // typeText only after the guard — never on an unfocused element
  assert.ok(replace.indexOf("guard focusForTyping") < replace.indexOf("element.typeText(text)"));
});

test("a field that never takes focus fails the type step with a reason instead of aborting the run", () => {
  assert.match(harness, /case "type":\s*\n\s*status = sessionType\(value, id: target\.isEmpty \? nil : target\) \? "pass" : "fail"\s*\n\s*if status == "fail" \{ detail = lastTypeFailure\.isEmpty/);
  assert.match(harness, /"focus_failed"/);
  assert.match(harness, /guard replaceText\(on: field, with: text\) else \{ return false \}/);
});

test("a run the harness abandons mid-way is reported as failed with the declared step count", () => {
  const dir = tmp();
  const log = path.join(dir, "flow.log");
  fs.writeFileSync(log, [
    "OCQA_FLOW_RESULT:started total=10 name=repro kind=flow",
    'OCQA_FLOW_STEP:{"index":1,"action":"wait_for","target":"Forgot password?","assert":false,"status":"pass","detail":""}',
    'OCQA_FLOW_STEP:{"index":2,"action":"login","target":"","assert":false,"status":"pass","detail":""}',
    "    t =    50.45s     Synthesize event",
    "/x/ExplorerTests.swift:4729: error: -[OCQAHarnessUITests.ExplorerTests testReplayFlow] : Failed to synthesize event: Neither element nor any descendant has keyboard focus. Element: TextField",
    "Test Case '-[OCQAHarnessUITests.ExplorerTests testReplayFlow]' failed (56.2 seconds).",
    "** TEST EXECUTE FAILED **",
  ].join("\n") + "\n");
  const r = spawnSync("python3", [path.join(root, "scripts", "flow_lib.py"), "report", "--json", log], { encoding: "utf8" });
  const out = JSON.parse(r.stdout);
  assert.equal(out.passed, false);
  assert.equal(out.total, 10, "declared total survives");
  assert.equal(out.executed, 2);
  assert.equal(r.status, 1);
  const last = out.steps[out.steps.length - 1];
  assert.equal(last.action, "harness");
  assert.equal(last.status, "fail");
  assert.match(last.detail, /keyboard focus/);
  assert.match(last.detail, /after step 2 of 10/);
  const human = spawnSync("python3", [path.join(root, "scripts", "flow_lib.py"), "report", log], { encoding: "utf8" });
  assert.match(human.stdout, /FLOW FAILED/);
  assert.doesNotMatch(human.stdout, /2\/2 steps/);
});

test("a completed run still reports normally", () => {
  const dir = tmp();
  const log = path.join(dir, "flow.log");
  fs.writeFileSync(log, [
    "OCQA_FLOW_RESULT:started total=2 name=ok kind=flow",
    'OCQA_FLOW_STEP:{"index":1,"action":"wait_for","target":"Home","assert":false,"status":"pass","detail":""}',
    'OCQA_FLOW_STEP:{"index":2,"action":"assert_exists","target":"Home","assert":true,"status":"pass","detail":""}',
    'OCQA_FLOW_RESULT:{"passed":true,"name":"ok","kind":"flow","total":2,"executed":2,"failed":0}',
  ].join("\n") + "\n");
  const r = spawnSync("python3", [path.join(root, "scripts", "flow_lib.py"), "report", "--json", log], { encoding: "utf8" });
  const out = JSON.parse(r.stdout);
  assert.equal(out.passed, true);
  assert.equal(out.steps.length, 2);
  assert.equal(r.status, 0);
});

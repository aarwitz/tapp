import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FlowLog, flowVariables, inferFlowPlatform, loadFlowFile, normalizeFlowStep, substituteFlowValue, isOptionalStep, validateFlowSteps } from "../mcp-server/src/flow-runtime.js";

test("Flow normalization is shared by native and browser drivers", () => {
  assert.deepEqual(normalizeFlowStep({ tap: "Continue" }), { action: "tap", target: "Continue", value: "Continue", params: {} });
  assert.deepEqual(normalizeFlowStep({ type: { field: "Email", value: "$TEST_EMAIL" } }), {
    action: "type", target: "Email", value: "$TEST_EMAIL", params: { field: "Email", value: "$TEST_EMAIL" },
  });
  assert.equal(substituteFlowValue("hello $WHO", { WHO: "world" }), "hello world");
  assert.equal(flowVariables({ vars: { ROLE: "admin" } }).ROLE, "admin");
});

test("Flow YAML preserves platform targets and reset policy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-flow-"));
  const file = path.join(dir, "web.yml");
  fs.writeFileSync(file, "name: Browser smoke\nplatform: web\nurl: http://127.0.0.1:3000\nreset: clear\nsteps:\n  - assert_screen: Home\n");
  const flow = loadFlowFile(file);
  assert.equal(flow.platform, "web");
  assert.equal(flow.url, "http://127.0.0.1:3000");
  assert.equal(flow.reset, "clear");
});

test("legacy app Flows remain iOS-only instead of leaking into web or Android gates", () => {
  assert.equal(inferFlowPlatform({ name: "Legacy iOS", app: "com.example.app", steps: [] }), "ios");
  assert.equal(inferFlowPlatform({ name: "Browser", url: "https://example.test", steps: [] }), "web");
  assert.equal(inferFlowPlatform({ name: "Android", platform: "android", app: "com.example.app", steps: [] }), "android");
});

test("FlowLog emits the same markers on every platform", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-flow-log-"));
  const logPath = path.join(dir, "flow.log");
  const log = new FlowLog({ logPath, flow: { name: "Smoke", steps: [{ tap: "Go" }] } });
  log.step({ index: 1, action: "tap", target: "Go", status: "pass" });
  const result = log.finish();
  assert.equal(result.passed, true);
  const raw = fs.readFileSync(logPath, "utf8");
  assert.match(raw, /OCQA_FLOW_STEP:/);
  assert.match(raw, /OCQA_FLOW_RESULT:\{"passed":true/);
});

test("FlowLog reports actual execution after fail-fast instead of implying skipped steps passed", () => {
  const log = new FlowLog({ flow: { name: "fail fast", steps: [{ tap: "A" }, { tap: "B" }, { tap: "C" }] } });
  log.step({ index: 1, action: "tap", target: "A", status: "pass" });
  log.step({ index: 2, action: "tap", target: "B", status: "fail", detail: "broken" });
  const result = log.finish();
  assert.equal(result.total, 3);
  assert.equal(result.executed, 2);
  assert.equal(result.failed, 1);
  assert.match(result.lines.at(-1), /"executed":2/);
});

test("FlowLog identifies compiled release-contract evidence and every attributed step", () => {
  const log = new FlowLog({ flow: {
    name: "Revenue path",
    kind: "flow",
    releaseContract: { name: "checkoutCompletes" },
    steps: [{ tap: "Buy" }],
  } });
  log.step({ index: 1, action: "tap", target: "Buy", status: "pass", task: "completeCheckout" });
  const result = log.finish();
  assert.equal(result.kind, "release-contract");
  assert.equal(result.contract, "checkoutCompletes");
  // Found by its prefix, not by its position: the log grew an OCQA_FLOW_CLOCK line between the
  // start and the first step (TM-497), and anything reading it by index broke.
  const stepLine = result.lines.find((line) => line.startsWith("OCQA_FLOW_STEP:"));
  assert.match(stepLine, /"contract":"checkoutCompletes"/);
  assert.match(stepLine, /"task":"completeCheckout"/);
});

test("a step can be optional, so a screen that only sometimes appears does not decide the run", () => {
  // The iOS "Save Password?" sheet appears after a sign-in on some runs and not others, same
  // account, same flow. A flow that taps it fails on the runs without it; a flow that ignores
  // it fails on the runs with it. There was no way to write one that passed both times, which
  // meant the journey could not be kept and re-checked at all (TM-497, public issue 33).
  assert.equal(isOptionalStep(normalizeFlowStep({ tap: { target: "Not Now", optional: true } })), true);
  assert.equal(isOptionalStep(normalizeFlowStep({ tap: { target: "Not Now", optional: "true" } })), true);
  assert.equal(isOptionalStep(normalizeFlowStep({ tap: { target: "Not Now" } })), false);
  assert.equal(isOptionalStep(normalizeFlowStep({ tap: "Not Now" })), false, "a bare target is never optional");
  assert.equal(isOptionalStep(normalizeFlowStep({ action: "tap", target: "Not Now", optional: true })), true);
  assert.equal(isOptionalStep(undefined), false);

  // It stays a normal step otherwise: same action, same target, and the validator accepts it.
  const step = normalizeFlowStep({ tap: { target: "Not Now", optional: true } });
  assert.equal(step.action, "tap");
  assert.equal(step.target, "Not Now");
  assert.deepEqual(validateFlowSteps({ platform: "ios", steps: [{ tap: { target: "Not Now", optional: true } }] }), []);
});

// TM-497 / TM-686: a one-time system alert belongs to the operating system, not the app, so a
// Flow's own `tap:` cannot reach it and the run stops on a screen nobody scripted. `alerts:` says
// what to do with it. Three of the eight demo takes on 11/7 were re-recorded because of these.
test("a flow says what to do with a system alert, and a typo is refused rather than ignored", () => {
  const ios = (alerts) => ({ name: "f", platform: "ios", app: "com.x", alerts, steps: [{ tap: "A" }] });
  assert.deepEqual(validateFlowSteps(ios("allow")), []);
  assert.deepEqual(validateFlowSteps(ios("dismiss")), []);
  assert.deepEqual(validateFlowSteps(ios("")), []);
  assert.deepEqual(validateFlowSteps({ ...ios("allow"), alerts: undefined }), []);

  // Silently doing nothing is how `alerts: yes` would behave, and YAML turns a bare `yes` into a
  // boolean on the way in, so the author would never learn their setting was not a setting.
  assert.match(validateFlowSteps(ios("Allow please"))[0], /is not a setting/);
  assert.match(validateFlowSteps(ios(true))[0], /is not a setting/);

  // Web and Android have no system alert in this sense; accepting it there would be a lie.
  const web = { name: "f", platform: "web", url: "https://x.test", alerts: "allow", steps: [{ tap: "A" }] };
  assert.match(validateFlowSteps(web, "web")[0], /applies to iOS flows/);
});

// A journey starting from an email link ("tap the sign-in link in your receipt") could not be
// written down before — open_url is a committed step, not a per-platform special case, so the
// validator has to agree on it the same way it agrees on any other step with a target.
test("open_url is a committed step, and needs a target like tap or wait_for", () => {
  assert.deepEqual(validateFlowSteps({ platform: "ios", steps: [{ open_url: "myapp://claim?t=$CLAIM_TOKEN" }] }), []);
  assert.deepEqual(validateFlowSteps({ platform: "web", steps: [{ open_url: "https://example.test/claim" }] }), []);
  assert.match(validateFlowSteps({ platform: "ios", steps: [{ open_url: "" }] })[0], /open_url needs a target/);
});

// TM-1077: an admin "Import contacts" page starts with choosing a CSV; before this, there was
// no committed Flow step for it, so that journey had to be driven by hand with raw Playwright.
test("upload needs {field, file}, like type needs {field, value}", () => {
  assert.deepEqual(validateFlowSteps({ platform: "web", steps: [{ upload: { field: "ci-file", file: "contacts.csv" } }] }), []);
  assert.match(validateFlowSteps({ platform: "web", steps: [{ upload: { field: "ci-file" } }] })[0], /upload needs \{field, file\}/);
  assert.match(validateFlowSteps({ platform: "web", steps: [{ upload: { file: "contacts.csv" } }] })[0], /upload needs \{field, file\}/);
});

test("loadFlowFile stamps the Flow with its own file path, so a later upload: resolves against it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-flow-sourcepath-"));
  const file = path.join(dir, "import.yml");
  fs.writeFileSync(file, "name: Import contacts\nplatform: web\nurl: http://127.0.0.1:3000\nsteps:\n  - assert_screen: Home\n");
  const flow = loadFlowFile(file);
  assert.equal(flow.sourcePath, file);
});

test("the alerts setting survives the parser that hands the flow to the harness", () => {
  // It is a flow-level key, and flow_lib.py copies a fixed list of those: a key missing from that
  // list is dropped on the floor, which is what happened the first time.
  const flowLib = fs.readFileSync(new URL("../scripts/flow_lib.py", import.meta.url), "utf8");
  assert.match(flowLib, /"releaseContract", "alerts"/,
    "flow_lib.py must copy `alerts` through to the harness, or the setting never arrives");
});

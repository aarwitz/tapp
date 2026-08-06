import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FlowLog, flowVariables, inferFlowPlatform, loadFlowFile, normalizeFlowStep, substituteFlowValue } from "../mcp-server/src/flow-runtime.js";

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
  assert.match(result.lines[1], /"contract":"checkoutCompletes"/);
  assert.match(result.lines[1], /"task":"completeCheckout"/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyCrashReport, findCrashReports, attributeRunCrash, summarizeCrashTraces } from "../mcp-server/src/ios-crash-attribution.js";

const UDID = "11111111-2222-3333-4444-555555555555";
const APP = "com.acme.app";

function ips(dir, name, header, body) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, `${JSON.stringify(header)}\n${JSON.stringify(body)}`);
  return full;
}
function reportsDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "tapp-ips-")); }

test("a genuine app crash carries the bundle id in the HEADER only (verified against a seeded fatalError)", () => {
  const c = classifyCrashReport({ header: { name: "AcmeApp", bundleID: APP }, body: { procName: "AcmeApp", exception: { type: "EXC_CRASH" } } }, { bundleId: APP, simulatorUdid: UDID });
  assert.equal(c.kind, "app");
});

test("an XPC/guard fault carries the bundle id in the body and is NOT an app crash", () => {
  const c = classifyCrashReport({ header: { name: "AcmeApp" }, body: { bundleID: APP, exception: { type: "EXC_GUARD" } } }, { bundleId: APP, simulatorUdid: UDID });
  assert.equal(c.kind, "guard-fault");
});

test("SpringBoard dying in our simulator is a simulator-system crash, never the app", () => {
  const c = classifyCrashReport({ header: { name: "SpringBoard" }, body: { procName: "SpringBoard", procPath: `/Library/Developer/CoreSimulator/Devices/${UDID}/data/../SpringBoard`, exception: { type: "EXC_BAD_ACCESS" } } }, { bundleId: APP, simulatorUdid: UDID });
  assert.equal(c.kind, "simulator-system");
});

test("a launch-throttle crash with no bundle id anywhere is the app when its procPath is in our app container; the XCUITest runner never is", () => {
  const base = `/Library/Developer/CoreSimulator/Devices/${UDID}/data/Containers/Bundle/Application/ABCD/`;
  const app = classifyCrashReport({ header: { name: "AcmeApp" }, body: { procName: "AcmeApp", procPath: `${base}AcmeApp.app/AcmeApp`, exception: { type: "EXC_CRASH" } } }, { bundleId: APP, simulatorUdid: UDID });
  assert.equal(app.kind, "app");
  const runner = classifyCrashReport({ header: { name: "OCQAHarnessUITests-Runner" }, body: { procName: "OCQAHarnessUITests-Runner", procPath: `${base}OCQAHarnessUITests-Runner.app/OCQAHarnessUITests-Runner` } }, { bundleId: APP, simulatorUdid: UDID });
  assert.equal(runner.kind, "test-runner");
  const otherSim = classifyCrashReport({ header: { name: "AcmeApp" }, body: { procName: "AcmeApp", procPath: `/Library/Developer/CoreSimulator/Devices/OTHER/data/Containers/Bundle/Application/X/AcmeApp.app/AcmeApp` } }, { bundleId: APP, simulatorUdid: UDID });
  assert.equal(otherSim.kind, "other", "a same-named app in a different simulator is not ours");
});

test("findCrashReports honours the run window and skips ExcUserFault notices", () => {
  const dir = reportsDir();
  const old = ips(dir, "AcmeApp-old.ips", { name: "AcmeApp", bundleID: APP }, { procName: "AcmeApp" });
  const past = Date.now() - 3_600_000;
  fs.utimesSync(old, past / 1000, past / 1000);
  ips(dir, "ExcUserFault_AcmeApp.ips", { name: "AcmeApp", bundleID: APP }, { procName: "AcmeApp" });
  ips(dir, "SpringBoard-now.ips", { name: "SpringBoard" }, { procName: "SpringBoard", procPath: `/Devices/${UDID}/x/SpringBoard`, exception: { type: "EXC_BAD_ACCESS" } });
  const since = Date.now() - 60_000;
  const r = findCrashReports({ since, bundleId: APP, simulatorUdid: UDID, dir });
  assert.equal(r.app.length, 0, "the hour-old app report predates this run");
  assert.equal(r.simulatorSystem.length, 1);
  assert.equal(r.simulatorSystem[0].procName, "SpringBoard");
  assert.equal(r.simulatorSystem[0].exceptionType, "EXC_BAD_ACCESS");
});

test("attribution verdicts: app beats system beats runner beats nothing", () => {
  const dir = reportsDir();
  const since = Date.now() - 60_000;
  assert.equal(attributeRunCrash({ since, bundleId: APP, simulatorUdid: UDID, dir }).verdict, "no-report");
  ips(dir, "runner.ips", { name: "OCQAHarnessUITests-Runner" }, { procName: "OCQAHarnessUITests-Runner", procPath: `/Devices/${UDID}/data/Containers/Bundle/Application/R/OCQAHarnessUITests-Runner.app/x` });
  assert.equal(attributeRunCrash({ since, bundleId: APP, simulatorUdid: UDID, dir }).verdict, "test-runner");
  ips(dir, "sb.ips", { name: "SpringBoard" }, { procName: "SpringBoard", procPath: `/Devices/${UDID}/SpringBoard` });
  assert.equal(attributeRunCrash({ since, bundleId: APP, simulatorUdid: UDID, dir }).verdict, "simulator-system");
  ips(dir, "app.ips", { name: "AcmeApp", bundleID: APP }, { procName: "AcmeApp", exception: { type: "EXC_CRASH" } });
  const a = attributeRunCrash({ since, bundleId: APP, simulatorUdid: UDID, dir });
  assert.equal(a.verdict, "app");
  assert.equal(a.reports.app[0].path, path.join(dir, "app.ips"));
  assert.equal(a.reports.simulatorSystem.length, 1, "the system crash is still recorded alongside");
});

test("a crash trace in tool output collapses to one attributed line; the surrounding output survives", () => {
  const text = [
    "Test Case '-[ExplorerTests testAutonomousExploration]' started.",
    "OCQA_STATE:{\"screen\":\"Home\"}",
    "Process:               SpringBoard [4242]",
    "Path:                  /Library/Developer/CoreSimulator/.../SpringBoard",
    "Identifier:            SpringBoard",
    "Exception Type:        EXC_BAD_ACCESS (SIGSEGV)",
    "Exception Codes:       KERN_INVALID_ADDRESS at 0x0000000000000010",
    "Thread 10 Crashed:: Dispatch queue: com.apple.root.user-initiated-qos",
    "0   libobjc.A.dylib   0x1 objc_msgSend + 32",
    "1   SpringBoard       0x2 -[SBApplication x] + 1",
    "Binary Images:",
    "0x1 - 0x2 libobjc.A.dylib",
    "OCQA_COMPLETE:{\"actions\":3}",
  ].join("\n");
  const out = summarizeCrashTraces(text);
  assert.match(out, /^\[crash trace of SpringBoard — EXC_BAD_ACCESS \(SIGSEGV\) omitted here; full text in full-output\.txt\]$/m);
  assert.doesNotMatch(out, /KERN_INVALID_ADDRESS|objc_msgSend/);
  assert.match(out, /^OCQA_STATE:/m);
  assert.match(out, /^OCQA_COMPLETE:/m, "marker lines after the trace are kept");
  assert.equal(summarizeCrashTraces("plain\noutput"), "plain\noutput");
});

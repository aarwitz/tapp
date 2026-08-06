import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { baselinePathForTarget, selectApplicationTarget, validateBaselineReport, writeTargetBaseline } from "../mcp-server/src/ci-setup.js";

const target = { id: "target_web_store_a1b2", platform: "web", name: "store", sourcePath: "." };
const model = { kind: "tapp-application-model", targets: [target, { id: "target_ios_app", platform: "ios", name: "App", sourcePath: "App.xcodeproj" }] };
const report = {
  platform: "web", targetKey: target.id, verdict: "ready", inconclusive: false, findings: [], screens: ["Home", "Checkout"], screensExplored: 2, actionsPerformed: 4,
  flows: [], scenarios: [], contracts: [{ name: "checkoutWorks", passed: true }], gate: { policy: "gate", failed: false, reasons: [] },
};

test("baseline target selection is explicit in multi-target repositories", () => {
  assert.equal(selectApplicationTarget(model, { platform: "web" }).id, target.id);
  assert.equal(selectApplicationTarget(model, { target: "App" }).platform, "ios");
  assert.throws(() => selectApplicationTarget(model), /Multiple targets/);
  assert.throws(() => selectApplicationTarget(model, { platform: "android" }), /No application target/);
});

test("baseline validation rejects inconclusive, blocked, cross-platform, and failed-suite reports", () => {
  assert.equal(validateBaselineReport(report, { platform: "web", targetId: target.id }).suite.contracts, 1);
  assert.throws(() => validateBaselineReport({ ...report, platform: "ios" }, { platform: "web", targetId: target.id }), /does not match/);
  assert.throws(() => validateBaselineReport({ ...report, inconclusive: true }, { platform: "web", targetId: target.id }), /inconclusive/);
  assert.throws(() => validateBaselineReport({ ...report, verdict: "blocked" }, { platform: "web", targetId: target.id }), /blocked/);
  assert.throws(() => validateBaselineReport({ ...report, contracts: [{ passed: false }] }, { platform: "web", targetId: target.id }), /failed contracts/);
  assert.throws(() => validateBaselineReport({ ...report, gate: { failed: true } }, { platform: "web", targetId: target.id }), /successful portable gate/);
  assert.throws(() => validateBaselineReport({ ...report, targetKey: "" }, { platform: "web", targetId: target.id }), /missing its targetKey/);
  assert.throws(() => validateBaselineReport({ ...report, targetKey: "target_web_admin" }, { platform: "web", targetId: target.id }), /does not match application-model target/);
});

test("target baselines are atomic, repository-local, and never overwritten silently", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-baseline-"));
  const localReport = {
    ...report,
    relativeMarkersFilePath: "../../.tapp/captures/ci.portable/ocqa-markers.txt",
    uiMap: { nodeCount: 2, path: "/Users/person/.tapp/captures/ci.portable/ui-map.json" },
    capture: { id: "ci.portable", path: "/Users/person/.tapp/captures/ci.portable", relativePath: "../../.tapp/captures/ci.portable" },
    reportHtml: "/Users/person/.tapp/captures/ci.portable/report.html",
    recording: "/Users/person/.tapp/captures/ci.portable/exploration.webm",
  };
  const written = writeTargetBaseline({ projectDir: root, target, report: localReport, sourceReport: path.join(root, "gate-report.json") });
  assert.equal(written.path, baselinePathForTarget(root, target));
  assert.equal(written.artifact.baselineIdentity.targetId, target.id);
  assert.equal(written.artifact.baselineIdentity.suite.contracts, 1);
  assert.equal(written.artifact.baselineIdentity.sourceReport, "gate-report.json");
  assert.equal(written.artifact.markersEvidence, "tapp-capture:ci.portable/ocqa-markers.txt");
  assert.equal(written.artifact.uiMap.evidence, "tapp-capture:ci.portable/ui-map.json");
  assert.deepEqual(written.artifact.capture, { id: "ci.portable", evidence: "tapp-capture:ci.portable" });
  assert.equal(written.artifact.reportHtmlEvidence, "tapp-capture:ci.portable/report.html");
  assert.equal(written.artifact.recordingEvidence, "tapp-capture:ci.portable/exploration.webm");
  assert.doesNotMatch(JSON.stringify(written.artifact), /\/Users\/person|\.\.\/\.\.\/\.tapp/);
  assert.throws(() => writeTargetBaseline({ projectDir: root, target, report }), /already exists/);
  const replaced = writeTargetBaseline({ projectDir: root, target, report: { ...report, verdict: "caution" }, replace: true });
  assert.equal(replaced.artifact.verdict, "caution");
});

// The judgment layer's core claim: same evidence trace in → same verdict out.
// These tests pin the verdict, dedup, coverage-floor, and honesty-label behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildQaReport, observationBadge, observationSummary, severityRank, parseOcqaMarkers, evaluateGate, GATE_EXIT, GATE_POLICY_VERSION } from "../mcp-server/src/report.js";
import { writeHtmlReport } from "../mcp-server/src/html-report.js";

function markersFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-test-"));
  const p = path.join(dir, "ocqa-markers.txt");
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

const CLEAN_RUN = [
  'OCQA_STATE:{"screen":"Home","elements":30}',
  'OCQA_ACTION:{"type":"tap","target":"Settings"}',
  'OCQA_ACTION:{"type":"tap","target":"Profile"}',
  'OCQA_ACTION:{"type":"tap","target":"Back"}',
  'OCQA_STATE:{"screen":"Settings","elements":20}',
  'OCQA_COMPLETE:{"actions":3,"states":2,"issues":0,"screens":"Home,Settings"}',
];

test("clean run with real coverage → a scoreless observation with no findings", () => {
  const r = buildQaReport(markersFile(CLEAN_RUN));
  assert.ok(r, "report parses");
  assert.equal(r.kind, "tapp-exploration-run");
  assert.equal(r.verdict, undefined, "exploration renders no ship verdict (ADR-0005)");
  assert.equal(r.releaseScore, undefined, "exploration renders no score");
  assert.equal(r.confidence, undefined);
  assert.equal(r.inconclusive, false);
  assert.equal(r.findingCounts.total, 0);
  assert.match(r.headline, /observation, not a release decision/);
  assert.ok(Array.isArray(r.checkedFor) && r.checkedFor.length > 0, "honesty label present");
  assert.ok(Array.isArray(r.notChecked) && r.notChecked.length > 0, "not-checked label present");
});

test("ExplorationRun carries the complete §4 schema contract", () => {
  const r = buildQaReport(markersFile(CLEAN_RUN));
  assert.equal(r.kind, "tapp-exploration-run");
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.runStatus, "completed");
  assert.equal(typeof r.stopReason, "string");
  assert.deepEqual(Object.keys(r.coverage).sort(), ["actionsPerformed", "screens", "screensExplored"]);
  assert.ok(r.evidence && typeof r.evidence.markers === "string", "evidence references the markers");
  assert.equal(r.uiMap, null, "uiMap is populated by the map-building consumer");
  assert.equal(r.comparison, null, "comparison is populated by a baseline diff");
  const thin = buildQaReport(markersFile([
    'OCQA_STATE:{"screen":"Home","elements":5}', 'OCQA_ACTION:{"type":"tap"}', 'OCQA_COMPLETE:{"actions":1,"states":1,"issues":0}',
  ]));
  assert.equal(thin.runStatus, "limited", "an inconclusive run is limited, not completed");
});

test("ExplorationRun preserves concrete target provenance", () => {
  const r = buildQaReport(markersFile(CLEAN_RUN), { platform: "android", target: " io.tapp.corpus.demo " });
  assert.equal(r.platform, "android");
  assert.equal(r.target, "io.tapp.corpus.demo");
  assert.equal(buildQaReport(markersFile(CLEAN_RUN)).target, null);
});

test("determinism: identical trace → identical observation", () => {
  const a = buildQaReport(markersFile(CLEAN_RUN));
  const b = buildQaReport(markersFile(CLEAN_RUN));
  assert.deepEqual(
    { f: a.findings, i: a.inconclusive, c: a.findingCounts },
    { f: b.findings, i: b.inconclusive, c: b.findingCounts }
  );
});

test("crash is always critical (severity coercion) and is a deterministic finding", () => {
  const r = buildQaReport(
    markersFile([
      ...CLEAN_RUN.slice(0, 5),
      'OCQA_ISSUE:{"type":"crash","severity":"low","title":"App crashed","screen":"Home","step":1}',
      'OCQA_COMPLETE:{"actions":3,"states":2,"issues":1}',
    ])
  );
  assert.equal(r.findings[0].severity, "critical", "crash coerced to critical even when marked low");
  assert.equal(r.findings[0].authority, "deterministic", "marker findings are deterministic-authority");
  assert.equal(r.findingCounts.critical, 1);
  assert.equal(r.verdict, undefined, "no verdict — the gate judges (see evaluateGate tests)");
});

test("findings dedup by type|screen — repeated detections count once", () => {
  const issue = 'OCQA_ISSUE:{"type":"error_message","severity":"high","title":"Error shown","screen":"Settings"}';
  const r = buildQaReport(markersFile([...CLEAN_RUN.slice(0, 5), issue, issue, issue]));
  assert.equal(r.findingCounts.total, 1);
  assert.equal(r.findingCounts.high, 1);
});

test("one missing web resource is one finding across routes and failed-request noise", () => {
  const r = buildQaReport(markersFile([
    ...CLEAN_RUN,
    'OCQA_ISSUE:{"type":"missing_asset","severity":"medium","title":"404 asset: /assets/js/nav.js","screen":"Home"}',
    'OCQA_ISSUE:{"type":"network_error","severity":"medium","title":"Request failed: /assets/js/nav.js (net::ERR_ABORTED)","screen":"Home"}',
    'OCQA_ISSUE:{"type":"missing_asset","severity":"medium","title":"404 asset: /assets/js/nav.js","screen":"Pricing"}',
    'OCQA_ISSUE:{"type":"network_error","severity":"medium","title":"Request failed: /assets/js/nav.js (net::ERR_ABORTED)","screen":"Help"}',
  ]), { platform: "web" });
  assert.equal(r.findingCounts.total, 1);
  assert.equal(r.findings[0].type, "missing_asset");
  assert.equal(r.findings[0].target, "/assets/js/nav.js");
  assert.equal(r.findings[0].screen, null, "resource defects are canonical across pages");
});

test("placeholder links deduplicate across web routes but retain distinct destinations", () => {
  const r = buildQaReport(markersFile([
    ...CLEAN_RUN,
    'OCQA_ISSUE:{"type":"placeholder_link","severity":"medium","title":"Link \\"Contact\\" has no destination","screen":"Home","target":"Contact"}',
    'OCQA_ISSUE:{"type":"placeholder_link","severity":"medium","title":"Link \\"Contact\\" has no destination","screen":"Pricing","target":"Contact"}',
    'OCQA_ISSUE:{"type":"placeholder_link","severity":"medium","title":"Link \\"App Store\\" has no destination","screen":"Home","target":"App Store"}',
  ]), { platform: "web" });
  assert.equal(r.findingCounts.total, 2);
  assert.deepEqual(r.findings.map((finding) => finding.target).sort(), ["App Store", "Contact"]);
  assert.ok(r.findings.every((finding) => finding.screen === null));
});

test("observation headline counts every reported finding", () => {
  const mediumIssues = Array.from({ length: 8 }, (_, index) =>
    `OCQA_ISSUE:{"type":"unresponsive_element","severity":"medium","title":"dead ${index}","screen":"Settings","target":"button-${index}"}`
  );
  const eight = buildQaReport(markersFile([...CLEAN_RUN, ...mediumIssues]));
  assert.match(eight.headline, /8 issue\(s\)/);
  assert.match(eight.headline, /observation, not a release decision/);

  const moreIssues = Array.from({ length: 18 }, (_, index) =>
    `OCQA_ISSUE:{"type":"unresponsive_element","severity":"medium","title":"dead ${index}","screen":"Settings","target":"button-${index}"}`
  );
  const eighteen = buildQaReport(markersFile([...CLEAN_RUN, ...moreIssues]));
  assert.match(eighteen.headline, /18 issue\(s\).*18 medium/);
});

test("native coverage uses the full completed action count when recovery actions are not narrated", () => {
  const r = buildQaReport(markersFile([
    'OCQA_STATE:{"screen":"Unknown","elements":6}',
    'OCQA_ACTION:{"type":"tap","target":"tab_bar_pos_0"}',
    'OCQA_COMPLETE:{"actions":10,"states":1,"issues":0,"screens":""}',
  ]));
  assert.equal(r.actionsPerformed, 10);
});

test("caller time-budget exhaustion is inconclusive partial evidence, not an app finding", () => {
  const r = buildQaReport(markersFile([
    'OCQA_STATE:{"screen":"Home","elements":30}',
    'OCQA_ACTION:{"type":"tap","target":"Settings"}',
    'OCQA_STATE:{"screen":"Settings","elements":20}',
    'OCQA_ACTION:{"type":"tap","target":"Profile"}',
    'OCQA_ACTION:{"type":"tap","target":"Back"}',
    // Compatibility proof: old captures included this misleading issue marker. It must be ignored.
    'OCQA_ISSUE:{"type":"explore_timeout","severity":"high","title":"Exploration timed out"}',
    'OCQA_COMPLETE:{"actions":3,"states":2,"issues":1,"timedOut":true,"timeoutSeconds":30}',
  ]));
  assert.equal(r.inconclusive, true);
  assert.equal(r.runStatus, "limited");
  assert.equal(r.stopReason, "time-budget-exhausted");
  assert.equal(r.findingCounts.total, 0);
  assert.match(r.headline, /30s time budget.*partial.*not an app performance finding/i);
  assert.ok(r.notChecked.some((item) => /full requested action budget/.test(item)));
  assert.equal(evaluateGate({ report: r }).outcome, "inconclusive");
});

test("coverage floor: a shallow run is inconclusive and says so", () => {
  const r = buildQaReport(
    markersFile([
      'OCQA_STATE:{"screen":"Launch","elements":5}',
      'OCQA_ACTION:{"type":"tap"}',
      'OCQA_COMPLETE:{"actions":1,"states":1,"issues":0}',
    ])
  );
  assert.equal(r.inconclusive, true);
  assert.equal(r.verdict, undefined);
  assert.equal(r.releaseScore, undefined);
  assert.match(r.headline, /NOT a pass/i);
});

test("a fully swept one-page web target is conclusive", () => {
  const r = buildQaReport(markersFile([
    'OCQA_ACTION:{"type":"open","target":"/"}',
    'OCQA_STATE:{"screen":"Landing","elements":8}',
    'OCQA_COMPLETE:{"actions":1,"states":1,"issues":0}',
  ]), { platform: "web" });
  assert.equal(r.inconclusive, false);
  assert.equal(r.stopReason, "completed");
});

test("a one-page web login wall without submitted credentials remains inconclusive", () => {
  const r = buildQaReport(markersFile([
    'OCQA_ACTION:{"type":"open","target":"/login"}',
    'OCQA_STATE:{"screen":"Sign in","elements":8,"inputs":[{"label":"Password","secure":true}]}',
    'OCQA_COMPLETE:{"actions":1,"states":1,"issues":0}',
  ]), { platform: "web" });
  assert.equal(r.inconclusive, true);
  assert.equal(r.stopReason, "login-wall-no-credentials");
  assert.ok(r.notChecked.some((item) => /sign-in behavior/.test(item)));
});

test("severityRank orders critical → low", () => {
  assert.ok(severityRank("critical") < severityRank("high"));
  assert.ok(severityRank("high") < severityRank("medium"));
  assert.ok(severityRank("medium") < severityRank("low"));
  assert.ok(severityRank("low") < severityRank("unknown-severity"));
});

test("malformed marker lines are ignored, not fatal", () => {
  const r = buildQaReport(markersFile([...CLEAN_RUN, "OCQA_ISSUE:{not json", 'OCQA_STATE:{"screen":']));
  assert.ok(r);
  assert.equal(r.findingCounts.total, 0);
});

test("parseOcqaMarkers returns null for a missing file", () => {
  assert.equal(parseOcqaMarkers("/nonexistent/path/markers.txt"), null);
});

test("two different dead controls on one screen are two findings (identity beyond type|screen)", () => {
  const r = buildQaReport(
    markersFile([
      ...CLEAN_RUN.slice(0, 5),
      'OCQA_ISSUE:{"type":"unresponsive_element","severity":"low","title":"dead Save","screen":"Settings","control":"Save"}',
      'OCQA_ISSUE:{"type":"unresponsive_element","severity":"low","title":"dead Delete","screen":"Settings","control":"Delete Account"}',
      'OCQA_ISSUE:{"type":"unresponsive_element","severity":"low","title":"dead Save again","screen":"Settings","control":"Save"}',
    ])
  );
  assert.equal(r.findingCounts.total, 2, "distinct targets counted separately; repeats deduped");
  assert.deepEqual(r.findings.map((f) => f.target).sort(), ["Delete Account", "Save"]);
});

test("checkedFor never claims sign-in checks when no login form was encountered", () => {
  const r = buildQaReport(markersFile(CLEAN_RUN));
  assert.ok(!r.checkedFor.some((c) => /sign-in/.test(c)));
  assert.ok(r.conditionsNotReached.some((c) => /sign-in/.test(c)));
});

test("a login surface without a submitted attempt does not claim sign-in checks", () => {
  const r = buildQaReport(
    markersFile([
      'OCQA_STATE:{"screen":"Login","elements":10,"inputs":[{"label":"Password","secure":true}]}',
      ...CLEAN_RUN,
    ])
  );
  assert.ok(!r.checkedFor.some((c) => /sign-in/.test(c)));
  assert.ok(r.notChecked.some((c) => /sign-in behavior/.test(c)));
  assert.equal(r.loginEncountered, true);
});

test("checkedFor claims failed sign-ins only after a real login submission", () => {
  const r = buildQaReport(markersFile([
    'OCQA_STATE:{"screen":"Login","elements":10,"inputs":[{"label":"Password","secure":true}]}',
    'OCQA_ACTION:{"type":"login","target":"Sign in"}',
    ...CLEAN_RUN,
  ]));
  assert.ok(r.checkedFor.some((c) => /failed sign-ins/.test(c)));
  assert.ok(!r.notChecked.some((c) => /sign-in behavior/.test(c)));
});

test("native login preamble and replay markers count as real sign-in submissions", () => {
  for (const submitted of [
    "OCQA_STATE:login_preamble_submitted",
    'OCQA_ACTION:{"type":"login_tap","target":"Sign in"}',
  ]) {
    const r = buildQaReport(markersFile([
      'OCQA_STATE:{"screen":"Login","elements":10,"inputs":[{"label":"Password","secure":true}]}',
      submitted,
      ...CLEAN_RUN,
    ]));
    assert.ok(r.checkedFor.some((c) => /failed sign-ins/.test(c)), submitted);
    assert.ok(!r.notChecked.some((c) => /no test credentials supplied/.test(c)), submitted);
  }
});

test("web platform gets web-specific honesty labels", () => {
  const r = buildQaReport(markersFile(CLEAN_RUN), { platform: "web" });
  assert.equal(r.platform, "web");
  assert.ok(r.checkedFor.some((c) => /uncaught exceptions/.test(c)));
  assert.ok(r.checkedFor.some((c) => /placeholder links/.test(c)));
  assert.ok(!r.checkedFor.some((c) => /keyboard/.test(c)), "no iOS keyboard claims on web");
  assert.ok(r.notChecked.some((c) => /first few visible buttons/.test(c)), "web button cap is disclosed");
  assert.ok(r.notChecked.some((c) => /claim accuracy/.test(c)), "content truth is explicitly out of scope");
  assert.ok(r.notChecked.some((c) => /privacy/.test(c)), "API data minimization is explicitly out of scope");
  assert.doesNotMatch(r.headline, /ship-ready/i);
  assert.equal(observationBadge(r), "🔭 EXPLORED");
  assert.match(observationSummary(r), /observation only/);
  assert.equal(r.verdict, undefined, "exploration renders no ship verdict");
  assert.equal(r.releaseScore, undefined);
  assert.equal(observationBadge({ ...r, inconclusive: true }), "🟡 INCONCLUSIVE (exploration)");
});

test("the shareable HTML evidence enumerates checked and unchecked scope", () => {
  const markers = markersFile(CLEAN_RUN);
  const report = buildQaReport(markers, { platform: "web" });
  const htmlPath = writeHtmlReport(path.dirname(markers), {
    report,
    label: "https://example.test",
    recordingWarning: "the simulator recorder is busy with another host recording",
  });
  const html = fs.readFileSync(htmlPath, "utf8");
  assert.match(html, /Checked this run/);
  assert.match(html, /uncaught exceptions/);
  assert.match(html, /Not checked this run/);
  assert.match(html, /content and claim accuracy/);
  assert.match(html, /Conditions not reached/);
  assert.match(html, /sign-in/);
  assert.match(html, /Recording/);
  assert.match(html, /recorder is busy/);
});

test("sampled web probe findings remain advisory and stay out of the deterministic counts", () => {
  const sampled = Array.from({ length: 20 }, (_, index) =>
    `OCQA_ISSUE:{"type":"unresponsive_element","severity":"medium","title":"dead ${index}","screen":"Home","target":"button-${index}"}`
  );
  const r = buildQaReport(markersFile([...CLEAN_RUN, ...sampled]), { platform: "web" });
  assert.equal(r.verdict, undefined);
  assert.equal(r.findingCounts.total, 20);
  assert.equal(r.deterministicFindingCounts.total, 0, "sampled probes never enter the deterministic (gate) counts");
  assert.equal(r.sampledFindingCounts.total, 20);
  assert.ok(r.findings.every((finding) => finding.evaluationTier === "sampled"));
  assert.ok(r.findings.every((finding) => finding.authority === "deterministic"), "source is deterministic; tier is sampled");
});

// ── evaluateGate: the pure gate decision (ADR-0005) ────────────────────────────────────────
// Fixed evidence in → identical GateRun out. These assert the outcome model directly (the
// process-level [char] tests in ci-report.test.js assert the same decisions end-to-end).
// Fixtures feed the fields evaluateGate actually reads now: deterministicFindingCounts + inconclusive
// (never the removed `verdict` label).
const okReport = { inconclusive: false, findingCounts: { total: 0 }, deterministicFindingCounts: { critical: 0, high: 0, medium: 0 } };

test("evaluateGate: clean evidence with no baseline is a pass (exit 0)", () => {
  const g = evaluateGate({ report: okReport, failOn: "gate" });
  assert.equal(g.outcome, "pass");
  assert.equal(g.exitCode, GATE_EXIT.pass);
  assert.equal(g.failed, false);
  assert.deepEqual(g.reasons, []);
  assert.equal(g.policyVersion, GATE_POLICY_VERSION);
});

test("evaluateGate: a critical finding with no baseline is a fail (exit 1)", () => {
  const g = evaluateGate({ report: { inconclusive: false, findingCounts: { total: 1 }, deterministicFindingCounts: { critical: 1 } }, failOn: "gate" });
  assert.equal(g.outcome, "fail");
  assert.equal(g.exitCode, 1);
});

test("evaluateGate: a deterministic failed sign-in is an absolute fail without a baseline", () => {
  const report = {
    inconclusive: false,
    findingCounts: { total: 1 },
    deterministicFindingCounts: { critical: 0, high: 1, medium: 0 },
    findings: [{ type: "auth_failed", severity: "high", authority: "deterministic", evaluationTier: "deterministic" }],
  };
  const g = evaluateGate({ report, failOn: "gate" });
  assert.equal(g.outcome, "fail");
  assert.equal(g.exitCode, GATE_EXIT.fail);
  assert.match(g.reasons.join(" "), /sign-in attempt/);
});

test("evaluateGate: sampled/model-observed auth advisories are not absolute failures", () => {
  for (const finding of [
    { type: "auth_failed", severity: "high", authority: "deterministic", evaluationTier: "sampled" },
    { type: "auth_failed", severity: "high", authority: "model-observed", evaluationTier: "deterministic" },
  ]) {
    const report = {
      inconclusive: false,
      findingCounts: { total: 1 },
      deterministicFindingCounts: { critical: 0, high: 0, medium: 0 },
      findings: [finding],
    };
    assert.equal(evaluateGate({ report, failOn: "gate" }).outcome, "pass");
  }
});

test("evaluateGate: the risk threshold blocks (many mediums, no crit) with no baseline", () => {
  // Decoupled from the score: findingsBlock computes this from counts, not the verdict label.
  const g = evaluateGate({ report: { inconclusive: false, findingCounts: { total: 18 }, deterministicFindingCounts: { critical: 0, high: 0, medium: 18 } }, failOn: "gate" });
  assert.equal(g.outcome, "fail");
});

test("evaluateGate: an inconclusive run is inconclusive even if its risk is low (thin run, not fail)", () => {
  const g = evaluateGate({ report: { inconclusive: true, findingCounts: { total: 18 }, deterministicFindingCounts: { critical: 0, high: 0, medium: 18 } }, failOn: "gate" });
  assert.equal(g.outcome, "inconclusive"); // coverage floor wins; findingsBlock defers on inconclusive
  assert.equal(g.exitCode, GATE_EXIT.inconclusive);
  assert.equal(g.failed, true);
});

test("evaluateGate: --fail-on any never passes an inconclusive run, even with zero findings", () => {
  // "any" is the strictest policy; a run that couldn't be conducted must fail closed, not pass.
  const g = evaluateGate({ report: { inconclusive: true, findingCounts: { total: 0 }, deterministicFindingCounts: { critical: 0, high: 0, medium: 0 } }, failOn: "any" });
  assert.equal(g.outcome, "inconclusive");
  assert.equal(g.exitCode, GATE_EXIT.inconclusive);
  assert.equal(g.failed, true);
});

test("evaluateGate: a selected-but-unexecuted contract is inconclusive, not fail", () => {
  const g = evaluateGate({ report: okReport, baseline: { findings: [] }, regression: { newFindings: [] }, prPlan: { execution: { notRun: 1 } }, failOn: "gate" });
  assert.equal(g.outcome, "inconclusive");
  assert.equal(g.exitCode, 3);
});

test("evaluateGate: precedence is fail > inconclusive > pass", () => {
  // A failed flow (fail) AND a selected contract that didn't run (inconclusive) → fail wins.
  const g = evaluateGate({
    report: okReport, baseline: { findings: [] }, regression: { newFindings: [] },
    flows: [{ passed: false }], prPlan: { execution: { notRun: 1 } }, failOn: "gate",
  });
  assert.equal(g.outcome, "fail");
  assert.equal(g.exitCode, 1);
  assert.equal(g.reasons.length, 2); // both reasons surfaced; fail wins the outcome
});

test("evaluateGate: a new high/critical regression vs a baseline is a fail", () => {
  const g = evaluateGate({
    report: okReport, baseline: { findings: [], inconclusive: false },
    regression: { newFindings: [{ severity: "high" }] }, failOn: "gate",
  });
  assert.equal(g.outcome, "fail");
  assert.match(g.reasons.join(" "), /new high vs\. baseline/);
});

test("evaluateGate: pre-existing debt (no regression, no crit, below risk threshold) passes", () => {
  const g = evaluateGate({
    report: { inconclusive: false, findingCounts: { total: 1 }, deterministicFindingCounts: { critical: 0, high: 1, medium: 0 } },
    baseline: { findings: [{ type: "x" }], inconclusive: false },
    regression: { newFindings: [] }, failOn: "gate",
  });
  assert.equal(g.outcome, "pass");
});

test("evaluateGate is a pure function: identical GateRun across repeated calls", () => {
  const evidence = {
    report: okReport, baseline: { findings: [] }, regression: { newFindings: [] },
    flows: [{ passed: false }], failOn: "gate",
  };
  assert.deepEqual(evaluateGate(evidence), evaluateGate(evidence));
});

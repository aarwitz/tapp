// The gate's headline promise: "we catch what your last release didn't have."
// Pins the baseline diff (comparison-only — no gate signal; the gate judges) and the two cross-run
// detectors. A "new high/critical" is what evaluateGate/the CI gate fails on.
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeRegression, computeContentCollapse, computeReachabilityLoss } from "../mcp-server/src/report.js";

const f = (type, screen, severity = "medium") => ({ type, screen, severity, title: type });

test("regression: new / persisting / resolved, matched by type|screen", () => {
  const baseline = [f("dead_button", "Home", "medium"), f("error_message", "Settings", "high")];
  const current = [f("error_message", "Settings", "high"), f("crash", "Profile", "critical")];
  const r = computeRegression(current, baseline);
  assert.equal(r.hadBaseline, true);
  assert.deepEqual(r.counts, { new: 1, persisting: 1, resolved: 1 });
  assert.equal(r.newFindings[0].type, "crash");
  assert.equal(r.resolved[0].type, "dead_button");
  assert.equal(r.gate, undefined, "comparison-only — no gate signal");
  assert.equal(r.newFindings.filter((x) => x.severity === "critical").length, 1, "1 new critical — the gate fails on this");
});

test("no new high/critical when only pre-existing debt remains (gate would pass)", () => {
  const baseline = [f("dead_button", "Home", "high")];
  const r = computeRegression([f("dead_button", "Home", "high")], baseline);
  assert.deepEqual(r.counts, { new: 0, persisting: 1, resolved: 0 });
  assert.equal(r.newFindings.length, 0, "pre-existing debt is not new — nothing for the gate to fail on");
});

test("regression returns null without a baseline (first run)", () => {
  assert.equal(computeRegression([f("crash", "Home")], undefined), null);
});

test("content collapse: rich screen going near-empty fires; small screens don't", () => {
  const findings = computeContentCollapse({ Feed: 3, Tiny: 1 }, { Feed: 30, Tiny: 4 });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].screen, "Feed");
  assert.equal(findings[0].severity, "high");
});

test("content collapse: unvisited screens are not compared", () => {
  assert.deepEqual(computeContentCollapse({}, { Feed: 30 }), []);
});

test("reachability loss fires only with a comparable action budget", () => {
  const baseline = { screens: ["Home", "Settings", "Profile"], actionsPerformed: 40 };
  const shortRun = { screens: ["Home"], actionsPerformed: 10 };
  assert.deepEqual(computeReachabilityLoss(shortRun, baseline), [], "a legit short run doesn't spray losses");
  const comparable = { screens: ["Home"], actionsPerformed: 40 };
  const losses = computeReachabilityLoss(comparable, baseline);
  assert.equal(losses.length, 2);
  assert.ok(losses.every((l) => l.type === "screen_unreachable" && l.severity === "high"));
});

test("REVIEW SCENARIO: fixing one control while breaking another on the same screen is a NEW regression", () => {
  const baseline = [{ type: "unresponsive_element", screen: "Settings", target: "Save", severity: "high", title: "dead Save" }];
  const current = [{ type: "unresponsive_element", screen: "Settings", target: "Delete Account", severity: "high", title: "dead Delete" }];
  const r = computeRegression(current, baseline);
  assert.deepEqual(r.counts, { new: 1, persisting: 0, resolved: 1 });
  assert.equal(r.newFindings[0].target, "Delete Account");
  assert.equal(r.resolved[0].target, "Save");
  assert.equal(r.newFindings[0].severity, "high", "the newly broken control is a new high — the gate fails on it");
});

test("regression identity migration: legacy target-less baselines match coarsely (no false gate failures on upgrade)", () => {
  const legacyBaseline = [{ type: "unresponsive_element", screen: "Settings", severity: "high", title: "dead button" }];
  const current = [{ type: "unresponsive_element", screen: "Settings", target: "Save", severity: "high", title: "dead Save" }];
  const r = computeRegression(current, legacyBaseline);
  assert.deepEqual(r.counts, { new: 0, persisting: 1, resolved: 0 });
  assert.equal(r.newFindings.length, 0, "coarse match on upgrade → no false new findings for the gate");
});

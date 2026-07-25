// The judgment layer's core claim: same evidence trace in → same verdict out.
// These tests pin the verdict, dedup, coverage-floor, and honesty-label behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildQaReport, severityRank, parseOcqaMarkers } from "../mcp-server/src/report.js";

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

test("clean run with real coverage → ready at full score", () => {
  const r = buildQaReport(markersFile(CLEAN_RUN));
  assert.ok(r, "report parses");
  assert.equal(r.verdict, "ready");
  assert.equal(r.confidence, 100);
  assert.equal(r.releaseScore, r.confidence, "releaseScore aliases confidence");
  assert.equal(r.inconclusive, false);
  assert.equal(r.findingCounts.total, 0);
  assert.ok(Array.isArray(r.checkedFor) && r.checkedFor.length > 0, "honesty label present");
  assert.ok(Array.isArray(r.notChecked) && r.notChecked.length > 0, "not-checked label present");
});

test("determinism: identical trace → identical verdict", () => {
  const a = buildQaReport(markersFile(CLEAN_RUN));
  const b = buildQaReport(markersFile(CLEAN_RUN));
  assert.deepEqual(
    { v: a.verdict, c: a.confidence, f: a.findings },
    { v: b.verdict, c: b.confidence, f: b.findings }
  );
});

test("crash is always critical (severity coercion) and blocks the verdict", () => {
  const r = buildQaReport(
    markersFile([
      ...CLEAN_RUN.slice(0, 5),
      'OCQA_ISSUE:{"type":"crash","severity":"low","title":"App crashed","screen":"Home","step":1}',
      'OCQA_COMPLETE:{"actions":3,"states":2,"issues":1}',
    ])
  );
  assert.equal(r.verdict, "blocked");
  assert.equal(r.findings[0].severity, "critical", "crash coerced to critical even when marked low");
  assert.equal(r.confidence, 75);
});

test("findings dedup by type|screen — repeated detections count once", () => {
  const issue = 'OCQA_ISSUE:{"type":"error_message","severity":"high","title":"Error shown","screen":"Settings"}';
  const r = buildQaReport(markersFile([...CLEAN_RUN.slice(0, 5), issue, issue, issue]));
  assert.equal(r.findingCounts.total, 1);
  assert.equal(r.findingCounts.high, 1);
  assert.equal(r.verdict, "caution", "a high finding caps the verdict at caution");
});

test("coverage floor: a shallow run is never ready", () => {
  const r = buildQaReport(
    markersFile([
      'OCQA_STATE:{"screen":"Launch","elements":5}',
      'OCQA_ACTION:{"type":"tap"}',
      'OCQA_COMPLETE:{"actions":1,"states":1,"issues":0}',
    ])
  );
  assert.equal(r.inconclusive, true);
  assert.notEqual(r.verdict, "ready");
  assert.ok(r.confidence <= 40, "floor caps the score");
  assert.match(r.headline, /NOT a pass/i);
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
  assert.equal(r.verdict, "ready");
});

test("parseOcqaMarkers returns null for a missing file", () => {
  assert.equal(parseOcqaMarkers("/nonexistent/path/markers.txt"), null);
});

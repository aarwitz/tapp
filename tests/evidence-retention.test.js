// TM-630: evidence ages out, and the reasons to keep a run all hold.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_KEEP_DAYS, KEEP_MARKER, captureRootFor, evidenceUsage, formatAge, keepDays, keepHint, keepReason,
  keepRunFor, markKeep, pruneEvidence, runDirOf,
} from "../mcp-server/src/evidence-retention.js";

const DAY = 24 * 60 * 60 * 1000;

/** A captures root with runs aged by mtime, plus a sibling the pruner must never touch. */
function fixture(runs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-retention-"));
  const root = path.join(home, "captures");
  fs.mkdirSync(root, { recursive: true });
  // Retained campaigns live beside captures/, which is what keeps them safe.
  fs.mkdirSync(path.join(home, "validation", "a-campaign"), { recursive: true });
  fs.writeFileSync(path.join(home, "validation", "a-campaign", "report.html"), "kept");
  for (const [name, { ageDays, keep = false, bytes = 32 }] of Object.entries(runs)) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "report.html"), "x".repeat(bytes));
    if (keep) fs.writeFileSync(path.join(dir, KEEP_MARKER), "");
    const when = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(dir, when, when);
  }
  return { home, root };
}

test("evidence past the window goes; recent, marked and active runs stay", () => {
  const { home, root } = fixture({
    "ios-old": { ageDays: 40 },
    "web-old": { ageDays: 20 },
    "ios-recent": { ageDays: 3 },
    "ios-old-but-marked": { ageDays: 40, keep: true },
  });
  const result = pruneEvidence({ env: { TAPP_KEEP_EVIDENCE_DAYS: "14" }, root });
  assert.deepEqual(result.removed.sort(), ["ios-old", "web-old"]);
  assert.equal(result.kept, 2);
  assert.ok(result.freedBytes > 0);
  assert.ok(fs.existsSync(path.join(root, "ios-recent")));
  assert.ok(fs.existsSync(path.join(root, "ios-old-but-marked")), "a marked run is never removed");
  // The decisive protection: pruning only ever walks captures/.
  assert.ok(fs.existsSync(path.join(home, "validation", "a-campaign", "report.html")),
    "retained campaigns are a sibling of captures/ and must survive");
});

test("a run still being written is left alone however old its name looks", () => {
  const { root } = fixture({ "ios-live": { ageDays: 0 } });
  assert.equal(keepReason(path.join(root, "ios-live"), { cutoffMs: Date.now() }), "still active");
  assert.deepEqual(pruneEvidence({ env: {}, root }).removed, []);
});

test("retention can be switched off, and a nonsense value does not delete more than asked", () => {
  for (const off of ["0", "off", "never", "forever"]) {
    const { root } = fixture({ "ios-ancient": { ageDays: 400 } });
    const result = pruneEvidence({ env: { TAPP_KEEP_EVIDENCE_DAYS: off }, root });
    assert.equal(result.enabled, false, `${off} should disable pruning`);
    assert.deepEqual(result.removed, []);
    assert.ok(fs.existsSync(path.join(root, "ios-ancient")));
  }
  assert.equal(keepDays({ TAPP_KEEP_EVIDENCE_DAYS: "not-a-number" }), DEFAULT_KEEP_DAYS);
  assert.equal(keepDays({ TAPP_KEEP_EVIDENCE_DAYS: "-5" }), DEFAULT_KEEP_DAYS);
  assert.equal(keepDays({}), DEFAULT_KEEP_DAYS);
  assert.equal(keepDays({ TAPP_KEEP_EVIDENCE_DAYS: "30" }), 30);
});

test("doctor can say what is held: how much, how many and the oldest", () => {
  const { root } = fixture({ "a": { ageDays: 9, bytes: 100 }, "b": { ageDays: 2, bytes: 100 } });
  const usage = evidenceUsage({ root });
  assert.equal(usage.runs, 2);
  assert.ok(usage.bytes >= 200, `expected the files to be counted, got ${usage.bytes}`);
  assert.ok(Date.now() - usage.oldestMs >= 8 * DAY, "the oldest run drives the age shown");
  assert.match(formatAge(9 * DAY), /9 days ago/);
  assert.match(formatAge(2 * 60 * 60 * 1000), /2 hours ago/);
  assert.equal(formatAge(60 * 1000), "just now");
});

test("a missing or empty captures directory is not an error", () => {
  const empty = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tapp-retention-none-")), "captures");
  assert.deepEqual(evidenceUsage({ root: empty }), { root: empty, runs: 0, bytes: 0, oldestMs: null });
  assert.deepEqual(pruneEvidence({ env: {}, root: empty }).removed, []);
});

test("the captures root follows TAPP_HOME", () => {
  assert.equal(captureRootFor({ TAPP_HOME: "/tmp/elsewhere" }), path.join("/tmp/elsewhere", "captures"));
  assert.equal(captureRootFor({}), path.join(os.homedir(), ".tapp", "captures"));
});

// Linux's review of 2f69800: honouring .tapp-keep was useless while nothing wrote it, so a run a
// saved report pointed at aged out like any other. These cover each kind of kept evidence.

test("marking a run keeps it past the window, and the mark records why", () => {
  const { root } = fixture({ "ios-old": { ageDays: 40 } });
  const marked = markKeep("ios-old", "saved as report.json", { root });
  assert.equal(marked.kept, true);
  assert.match(fs.readFileSync(path.join(root, "ios-old", KEEP_MARKER), "utf8"), /saved as report\.json/);
  assert.deepEqual(pruneEvidence({ env: {}, root }).removed, [], "a marked run survives");
});

test("a saved report marks the run it came from, in the shape tapp really produces", () => {
  const { root } = fixture({ "flow-run": { ageDays: 40 }, "explore-run": { ageDays: 40 }, "id-only": { ageDays: 40 } });
  // Exploration publishes `capture` as an OBJECT. Reading it as a string is the bug Linux caught
  // in 6d02b68: the mark was never written for any real report, and the old test passed because it
  // fed { capture: "explore-run" }, a shape tapp never produces.
  const exploreReport = {
    platform: "web",
    capture: {
      id: "explore-run",
      path: path.join(root, "explore-run"),
      relativePath: path.join("captures", "explore-run"),
      provenance: { surface: "cli" },
    },
  };
  assert.equal(keepRunFor(exploreReport, "saved", { root }).kept, true);
  // Flow runs are the other real shape.
  assert.equal(keepRunFor({ evidenceDir: path.join(root, "flow-run") }, "saved", { root }).kept, true);
  // Some error paths carry only the id, which resolves under the captures root.
  assert.equal(keepRunFor({ capture: { id: "id-only" } }, "saved", { root }).kept, true);
  assert.deepEqual(pruneEvidence({ env: {}, root }).removed, []);
  // Nothing usable on the report is a no-op, not a crash.
  for (const empty of [{}, null, { capture: {} }, { capture: { relativePath: "captures/x" } }]) {
    assert.equal(keepRunFor(empty, "saved", { root }).kept, false, `${JSON.stringify(empty)} should be a no-op`);
  }
});

// The guard that would have caught the shape mistake instead of a hand-rolled fixture: every
// `capture:` record a report publishes must offer a path or an id for the run to be findable. If
// someone changes that shape, this fails here rather than silently stopping evidence being kept.
test("every report's capture record still carries something runDirOf can use", () => {
  const sources = ["mcp-server/src/index.js", "mcp-server/src/browser-product.js"];
  let checked = 0;
  for (const rel of sources) {
    const text = fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    // Only the records that publish a run: `capture: { ... }` object literals, not schema
    // declarations (`capture: { type: "string" ... }`).
    // `(?<![A-Za-z0-9_])` so the alias map's `tapp_capture: { tool, hint }` is not mistaken for a
    // published capture record.
    for (const match of text.matchAll(/(?<![A-Za-z0-9_])capture: \{([^{}]*)\}/g)) {
      const body = match[1];
      if (/\btype:\s*"/.test(body)) continue;   // a tool-schema declaration, not a run record
      checked += 1;
      assert.ok(/\b(path|id)\s*:/.test(body),
        `${rel}: a published capture record offers neither path nor id — runDirOf could not keep its run: capture: {${body}}`);
    }
  }
  assert.ok(checked >= 5, `expected to inspect the real capture records, inspected ${checked}`);
  // And the object shape really is what runDirOf prefers.
  assert.equal(runDirOf({ capture: { id: "x", path: "/a/b" } }), "/a/b");
  assert.equal(runDirOf({ capture: { id: "x" } }), "x");
  assert.equal(runDirOf({ evidenceDir: "/a/c" }), "/a/c");
  assert.equal(runDirOf({ capture: { relativePath: "captures/x" } }), "");
});

test("marking refuses anything outside the evidence folder", () => {
  const { home, root } = fixture({ "a": { ageDays: 1 } });
  for (const escape of [path.join(home, "validation", "a-campaign"), "../validation/a-campaign", "/tmp", home]) {
    const result = markKeep(escape, "nope", { root });
    assert.equal(result.kept, false, `${escape} must be refused`);
    assert.match(result.why, /not a run inside the evidence folder|not a run directory/);
  }
  assert.ok(!fs.existsSync(path.join(home, "validation", "a-campaign", KEEP_MARKER)),
    "a bad caller must not be able to write outside captures/");
});

test("a person is told how to keep a run by hand", () => {
  assert.match(keepHint("/x/captures/ios-1"), /\.tapp-keep/);
});

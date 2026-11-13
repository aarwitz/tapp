// Evidence does not live for ever (TM-630).
//
// Every run writes a directory under `TAPP_HOME/captures` and nothing ever removed one. On the
// machine that prompted this story that was 853 runs and 3.4 GB going back three months, on a disk
// at 93% — and `tapp doctor` reported the free space without mentioning that Tapp itself was
// holding the missing GiB. Anyone who uses Tapp for a few months gets the same.
//
// Two rules decide everything here:
//
//   • Only ever inside `captures/`. Retained campaigns (`TAPP_HOME/validation/`), accounts, actors
//     and app builds are siblings of that directory, so confining the walk is what protects them —
//     not a list of exceptions that someone has to remember to extend.
//   • Deleting evidence someone is relying on is far worse than keeping bytes. So a run is removed
//     only when every reason to keep it is absent, and anything unrecognised is kept.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Evidence older than this is removed once a run finishes. */
export const DEFAULT_KEEP_DAYS = 14;

/** A run that says "keep me" is never pruned, whatever its age. */
export const KEEP_MARKER = ".tapp-keep";

// A directory touched this recently is treated as live even if its name looks old: a run still
// writing to it, or a second tapp process alongside this one, must not have its evidence removed
// underneath it.
const ACTIVE_GRACE_MS = 60 * 60 * 1000;

export function captureRootFor(env = process.env) {
  return path.join((env.TAPP_HOME || "").trim() || path.join(os.homedir(), ".tapp"), "captures");
}

/**
 * How long evidence is kept, from `TAPP_KEEP_EVIDENCE_DAYS`.
 * `0`, `off`, `never` or `infinite` switch pruning off entirely; anything unparseable falls back to
 * the default rather than guessing a number that deletes more than the author meant.
 */
export function keepDays(env = process.env) {
  const raw = String(env.TAPP_KEEP_EVIDENCE_DAYS ?? "").trim().toLowerCase();
  if (!raw) return DEFAULT_KEEP_DAYS;
  if (["0", "off", "never", "infinite", "forever"].includes(raw)) return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_KEEP_DAYS;
}

/** "3 days ago", for a person reading `tapp doctor` rather than a timestamp. */
export function formatAge(ms) {
  const days = Math.floor(Number(ms || 0) / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} ago`;
  const hours = Math.floor(Number(ms || 0) / (60 * 60 * 1000));
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return "just now";
}

function directorySize(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += directorySize(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    } catch { /* vanished mid-walk: it is not occupying space we can report on */ }
  }
  return total;
}

/**
 * Why this run must be kept, or null when it may be removed.
 * Exported so the decision can be tested one reason at a time, and so a caller can explain itself.
 */
export function keepReason(dir, { now = Date.now(), cutoffMs } = {}) {
  let stats;
  try { stats = fs.statSync(dir); } catch { return "unreadable"; }
  if (!stats.isDirectory()) return "not a run directory";
  if (fs.existsSync(path.join(dir, KEEP_MARKER))) return "marked to keep";
  if (now - stats.mtimeMs < ACTIVE_GRACE_MS) return "still active";
  if (!(stats.mtimeMs < cutoffMs)) return "within the window";
  return null;
}

/**
 * Report what Tapp is holding: how many runs, how much, and the oldest.
 * `tapp doctor` prints this beside the free-space line it already has, so the tool accounts for its
 * own disk use instead of only the machine's.
 */
export function evidenceUsage({ env = process.env, root = null } = {}) {
  const dir = root || captureRootFor(env);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {
    return { root: dir, runs: 0, bytes: 0, oldestMs: null };
  }
  let runs = 0;
  let bytes = 0;
  let oldestMs = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    runs += 1;
    bytes += directorySize(full);
    try {
      const { mtimeMs } = fs.statSync(full);
      if (oldestMs === null || mtimeMs < oldestMs) oldestMs = mtimeMs;
    } catch { /* ignore */ }
  }
  return { root: dir, runs, bytes, oldestMs };
}

/**
 * Remove evidence past the retention window. Called as part of a run's own teardown, so it costs
 * nothing extra and needs no new command (ADR-0007 keeps the verb list fixed).
 *
 * Never throws: a run must not be reported as failed because tidying up afterwards did not work.
 */
export function pruneEvidence({ env = process.env, root = null, now = Date.now(), dryRun = false } = {}) {
  const days = keepDays(env);
  const dir = root || captureRootFor(env);
  const result = { root: dir, enabled: days > 0, keepDays: days, removed: [], freedBytes: 0, kept: 0, errors: [] };
  if (days <= 0) return result;

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return result; }

  const cutoffMs = now - days * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    const reason = keepReason(full, { now, cutoffMs });
    if (reason) { result.kept += 1; continue; }
    const size = directorySize(full);
    if (dryRun) { result.removed.push(entry.name); result.freedBytes += size; continue; }
    try {
      fs.rmSync(full, { recursive: true, force: true });
      result.removed.push(entry.name);
      result.freedBytes += size;
    } catch (error) {
      result.errors.push(`${entry.name}: ${error.message || String(error)}`);
    }
  }
  return result;
}

/**
 * Mark a run as one to keep, for ever (TM-630).
 *
 * Honouring `.tapp-keep` was not enough: nothing wrote it, so a run someone was relying on aged
 * out like any other (Linux's review of 2f69800). Tapp writes the mark itself at every point where
 * it knows a run is being relied on — a report the author saved, a capture cited in filed feedback
 * — and `keepHint()` tells a person how to mark one where Tapp cannot know, such as a path quoted
 * in a note somewhere else.
 *
 * Refuses anything outside the captures root, so a bad caller cannot drop files into a repository
 * or a home directory. Never throws: marking is a courtesy, not the point of the run.
 */
export function markKeep(target, reason = "", { env = process.env, root = null } = {}) {
  const captures = root || captureRootFor(env);
  const raw = String(target || "").trim();
  if (!raw) return { kept: false, why: "no run given" };
  const dir = path.isAbsolute(raw) ? path.resolve(raw) : path.join(captures, raw);
  // Confined the same way pruning is: inside captures/, and nowhere else.
  // Must be a run INSIDE captures/, not the captures root itself (Linux's review of 6d02b68:
  // marking the root wrote .tapp-keep at the top of the evidence folder).
  if (!dir.startsWith(`${captures}${path.sep}`)) {
    return { kept: false, why: `not a run inside the evidence folder: ${dir}` };
  }
  try {
    if (!fs.statSync(dir).isDirectory()) return { kept: false, why: "not a run directory" };
    fs.writeFileSync(
      path.join(dir, KEEP_MARKER),
      `${reason || "kept"}\n${new Date().toISOString()}\n`
    );
    return { kept: true, dir, reason };
  } catch (error) {
    return { kept: false, why: error.message || String(error) };
  }
}

/**
 * The run directory a finished report came from, or "" when it carries none.
 *
 * Exploration publishes `capture` as an OBJECT — `{ id, path, relativePath, provenance }` — at
 * every producer (index.js web/android/macos/ios, browser-product.js journeys). My first version
 * read `capture` as a string, so it never matched a real report and the mark was never written;
 * the test passed only because it fed a shape tapp does not produce (Linux's review of 6d02b68).
 * Flow runs are the other shape: they carry `evidenceDir`.
 */
export function runDirOf(structured) {
  if (!structured || typeof structured !== "object") return "";
  const capture = structured.capture;
  if (capture && typeof capture === "object") {
    if (typeof capture.path === "string" && capture.path) return capture.path;
    // Some error paths carry only the id; it resolves under the captures root.
    if (typeof capture.id === "string" && capture.id) return capture.id;
    return "";
  }
  for (const value of [structured.evidenceDir, structured.captureDir, capture]) {
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/** Mark the run a finished report came from, whichever shape that report is. */
export function keepRunFor(structured, reason = "", options = {}) {
  const candidate = runDirOf(structured);
  if (!candidate) return { kept: false, why: "no run directory on the report" };
  return markKeep(candidate, reason, options);
}

/** How to keep a run by hand, for the cases Tapp cannot know about. */
export function keepHint(dir) {
  return `To keep this run when old evidence is cleared out: touch ${path.join(dir || "<run>", KEEP_MARKER)}`;
}

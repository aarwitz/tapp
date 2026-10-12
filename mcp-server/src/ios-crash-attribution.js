// Who actually crashed.
//
// The iOS harness reports `crash` when the app under test stops running mid-run. That is the
// right observation and the wrong attribution whenever a *simulator system process* died —
// SpringBoard respawning takes every foreground app with it — and xcodebuild prints the full
// system crash trace for any simulator-hosted process that dies, not just the app (public
// issue #30). The desktop app has had a cross-check against the real crash reports in
// ~/Library/Logs/DiagnosticReports since a false-CRITICAL incident in the field
// (ExplorationService.findRealCrashReport); this is that check for the CLI/MCP path.
//
// The rules are the ones verified against real reports there:
// - bundleID lives in the header for genuine app crashes, in the body for EXC_GUARD/XPC faults,
//   and in bundleInfo.CFBundleIdentifier sometimes — check all three;
// - launch-throttle crash variants omit the bundle id entirely; a report whose procPath is in
//   THIS simulator's user-app container is the app, unless it is the XCUITest runner, whose own
//   death is instrumentation failure and never an app crash;
// - EXC_GUARD is not an app crash.
import fs from "fs";
import os from "os";
import path from "path";

export const DEFAULT_REPORTS_DIR = path.join(os.homedir(), "Library", "Logs", "DiagnosticReports");
export const ATTRIBUTION_FILE = "crash-attribution.json";

function parseIps(raw) {
  const nl = raw.indexOf("\n");
  if (nl < 0) return null;
  let header; let body;
  try { header = JSON.parse(raw.slice(0, nl)); } catch { return null; }
  try { body = JSON.parse(raw.slice(nl + 1)); } catch { body = {}; }
  if (!header || typeof header !== "object") return null;
  return { header, body: body && typeof body === "object" ? body : {} };
}

export function classifyCrashReport({ header, body }, { bundleId, simulatorUdid } = {}) {
  const matchedBundle = (typeof body.bundleID === "string" && body.bundleID)
    || (typeof header.bundleID === "string" && header.bundleID)
    || (body.bundleInfo && typeof body.bundleInfo.CFBundleIdentifier === "string" ? body.bundleInfo.CFBundleIdentifier : null)
    || null;
  const procPath = typeof body.procPath === "string" ? body.procPath : "";
  const procName = String(body.procName || header.name || header.app_name || "").trim();
  const lower = procName.toLowerCase();
  const isTestRunner = lower.endsWith("-runner") || procPath.includes("-Runner.app") || procPath.includes(".xctrunner");
  const inOurSimulator = simulatorUdid ? procPath.includes(`/Devices/${simulatorUdid}/`) : false;
  const inOurAppContainer = inOurSimulator && procPath.includes("/data/Containers/Bundle/Application/") && !isTestRunner;
  const exceptionType = body.exception && typeof body.exception.type === "string" ? body.exception.type : null;
  const isApp = bundleId ? (matchedBundle === bundleId || (matchedBundle == null && inOurAppContainer)) : inOurAppContainer;
  return {
    procName: procName || "(unknown process)",
    bundleId: matchedBundle,
    exceptionType,
    isTestRunner,
    inOurSimulator,
    kind: isTestRunner ? "test-runner" : exceptionType === "EXC_GUARD" ? "guard-fault" : isApp ? "app" : inOurSimulator ? "simulator-system" : "other",
  };
}

// Reports written at or after `since` (ms epoch), classified. ExcUserFault_* files are user-fault
// notices, not crashes.
export function findCrashReports({ since, bundleId, simulatorUdid, dir = DEFAULT_REPORTS_DIR } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return { app: [], simulatorSystem: [], other: [] }; }
  const out = { app: [], simulatorSystem: [], other: [] };
  for (const name of names) {
    if (!name.endsWith(".ips") || name.startsWith("ExcUserFault_")) continue;
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (Number.isFinite(since) && stat.mtimeMs < since) continue;
    let parsed;
    try { parsed = parseIps(fs.readFileSync(full, "utf8")); } catch { continue; }
    if (!parsed) continue;
    const c = classifyCrashReport(parsed, { bundleId, simulatorUdid });
    const entry = { path: full, modifiedAt: new Date(stat.mtimeMs).toISOString(), procName: c.procName, bundleId: c.bundleId, exceptionType: c.exceptionType };
    if (c.kind === "app") out.app.push(entry);
    else if (c.kind === "simulator-system") out.simulatorSystem.push(entry);
    else if (c.kind === "other" || c.kind === "test-runner") out.other.push({ ...entry, kind: c.kind });
    // guard faults are dropped: not a crash of anything
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt));
  return out;
}

// Replace a raw crash trace in captured tool output with one line that says whose it was, so a
// SpringBoard trace does not read as the app under test blowing up. The full text stays in
// full-output.txt; this is for anything shown to a person or an agent.
const TRACE_START = /^(?:Crash Report|Process:\s+\S+\s+\[\d+\]|Incident Identifier:|-{10,}\s*$|Thread \d+ (?:Crashed|name):)/;
const TRACE_END = /^(?:Binary Images:|EOF|-{10,}\s*$)/;
export function summarizeCrashTraces(text = "") {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const looksLikeTrace = /^Process:\s+(\S+)\s+\[\d+\]/.test(line) || /^Crash Report/.test(line) || /quit unexpectedly/i.test(line);
    if (!looksLikeTrace) { out.push(line); i += 1; continue; }
    let proc = (line.match(/^Process:\s+(\S+)/) || line.match(/^(\S+) quit unexpectedly/i) || [])[1] || "";
    let exc = "";
    let j = i;
    let consumed = 0;
    for (; j < lines.length && consumed < 400; j += 1, consumed += 1) {
      const l = lines[j];
      if (!proc) proc = (l.match(/^Process:\s+(\S+)/) || [])[1] || proc;
      if (!exc) exc = (l.match(/^Exception Type:\s+(.+)$/) || [])[1] || exc;
      if (consumed > 2 && TRACE_END.test(l)) { j += 1; break; }
    }
    out.push(`[crash trace of ${proc || "a simulator process"}${exc ? ` — ${exc.trim()}` : ""} omitted here; full text in full-output.txt]`);
    i = j;
  }
  return out.join("\n");
}

// What a report consumer needs to decide: did the app crash, or did something else take it down?
export function attributeRunCrash({ since, bundleId, simulatorUdid, dir } = {}) {
  const reports = findCrashReports({ since, bundleId, simulatorUdid, dir });
  const verdict = reports.app.length
    ? "app"
    : reports.simulatorSystem.length
      ? "simulator-system"
      : reports.other.some((r) => r.kind === "test-runner")
        ? "test-runner"
        : "no-report";
  return { schemaVersion: 1, since: Number.isFinite(since) ? new Date(since).toISOString() : null, bundleId: bundleId || null, simulatorUdid: simulatorUdid || null, verdict, reports };
}

export function writeAttribution(captureDir, attribution) {
  fs.writeFileSync(path.join(captureDir, ATTRIBUTION_FILE), JSON.stringify(attribution, null, 2));
  return path.join(captureDir, ATTRIBUTION_FILE);
}

export function readAttribution(captureDir) {
  try { return JSON.parse(fs.readFileSync(path.join(captureDir, ATTRIBUTION_FILE), "utf8")); } catch { return null; }
}

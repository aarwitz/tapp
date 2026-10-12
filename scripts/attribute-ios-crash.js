#!/usr/bin/env node
// Called by quick-capture.sh after an iOS run whose markers contain a crash: decide from the real
// crash reports whether the app under test crashed or a simulator system process took it down,
// write crash-attribution.json into the capture, and print one line for the terminal.
//
//   node scripts/attribute-ios-crash.js <capture-dir> <bundle-id> <simulator-udid> <run-start-epoch-seconds>
import path from "path";
import { fileURLToPath } from "url";
import { attributeRunCrash, writeAttribution } from "../mcp-server/src/ios-crash-attribution.js";

const [captureDir, bundleId, simulatorUdid, startSeconds] = process.argv.slice(2);
if (!captureDir || !bundleId) {
  console.error(`usage: ${path.basename(fileURLToPath(import.meta.url))} <capture-dir> <bundle-id> [simulator-udid] [run-start-epoch-seconds]`);
  process.exit(2);
}
// Reports can be written a few seconds after the process dies; look back a little before the run
// started so a crash at launch is not missed, and never miss one written after we checked.
const since = Number(startSeconds) > 0 ? Number(startSeconds) * 1000 - 15_000 : Date.now() - 3_600_000;
const attribution = attributeRunCrash({ since, bundleId, simulatorUdid: simulatorUdid || undefined });
writeAttribution(path.resolve(captureDir), attribution);
const r = attribution.reports;
const line = attribution.verdict === "app"
  ? `Crash attribution: ${bundleId} crashed (${r.app[0].exceptionType || "see report"}) — ${r.app[0].path}`
  : attribution.verdict === "simulator-system"
    ? `Crash attribution: simulator system process ${r.simulatorSystem[0].procName} crashed (${r.simulatorSystem[0].exceptionType || "see report"}) and took the app with it — NOT attributed to ${bundleId}; ${r.simulatorSystem[0].path}`
    : attribution.verdict === "test-runner"
      ? `Crash attribution: the XCUITest runner died (instrumentation failure, not ${bundleId})`
      : `Crash attribution: no crash report found for this run window; the harness observation stands unverified`;
console.log(line);

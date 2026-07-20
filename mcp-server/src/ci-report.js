#!/usr/bin/env node
// AutoTap CI gate — the report/verdict half of scripts/ci-gate.sh.
//
// Takes the OCQA markers a CI exploration produced (plus, optionally, a stored baseline and any
// flow replay logs), and turns them into: a human-readable console report, a GitHub Actions step
// summary (when GITHUB_STEP_SUMMARY is set), a machine-readable JSON report, and — the point —
// an exit code CI can gate a merge on.
//
//   node src/ci-report.js --markers <ocqa-markers.txt>
//                         [--baseline <baseline.json>]      # prior run's findings[] (or a full report)
//                         [--flow-log <log> ...]            # run-flow.sh logs (repeatable)
//                         [--json-out <report.json>]        # full report incl. findings for the next baseline
//                         [--md-out <report.md>]            # rendered markdown (for a PR comment)
//                         [--fail-on <gate|blocked|any>]    # default: gate
//
// Gate policy (--fail-on):
//   gate     fail when the run introduced NEW high/critical findings vs. the baseline
//            (no baseline ⇒ falls back to `blocked`), or when any flow failed. The default:
//            pre-existing debt doesn't block, regressions and broken flows do.
//   blocked  fail when the verdict is blocked/inconclusive, or when any flow failed.
//   any      fail on any finding at all, or any flow failure. Strictest.
import fs from "fs";
import { buildQaReport, computeRegression } from "./report.js";

function parseArgs(argv) {
  const args = { flowLogs: [], failOn: "gate" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--markers") args.markers = argv[++i];
    else if (a === "--baseline") args.baseline = argv[++i];
    else if (a === "--flow-log") args.flowLogs.push(argv[++i]);
    else if (a === "--json-out") args.jsonOut = argv[++i];
    else if (a === "--md-out") args.mdOut = argv[++i];
    else if (a === "--fail-on") args.failOn = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!args.markers) {
    console.error("Required: --markers <ocqa-markers.txt>");
    process.exit(2);
  }
  if (!["gate", "blocked", "any"].includes(args.failOn)) {
    console.error(`--fail-on must be gate|blocked|any, got: ${args.failOn}`);
    process.exit(2);
  }
  return args;
}

// Port of flow_lib.py report() / FlowRunnerService.parseReport — kept in sync deliberately.
function parseFlowLog(logPath) {
  const name = logPath.split("/").pop().replace(/\.log$/, "");
  if (!fs.existsSync(logPath)) return { name, passed: false, total: 0, failed: 0, steps: [], missing: true };
  const steps = [];
  let total = 0, failed = 0, passed = false, sawResult = false, flowName = null;
  for (const raw of fs.readFileSync(logPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("OCQA_FLOW_STEP:{")) {
      try {
        const o = JSON.parse(line.slice("OCQA_FLOW_STEP:".length));
        steps.push({ status: o.status || "?", action: o.action || "", target: o.target || "", detail: o.detail || "" });
      } catch { /* ignore malformed */ }
    } else if (line.startsWith("OCQA_FLOW_RESULT:{")) {
      try {
        const o = JSON.parse(line.slice("OCQA_FLOW_RESULT:".length));
        total = o.total ?? steps.length;
        failed = o.failed ?? steps.filter((s) => s.status === "fail").length;
        passed = o.passed ?? (failed === 0 && steps.length > 0);
        if (o.name) flowName = o.name;
        sawResult = true;
      } catch { /* ignore malformed */ }
    }
  }
  if (!sawResult) {
    total = steps.length;
    failed = steps.filter((s) => s.status === "fail").length;
    passed = steps.length > 0 && failed === 0;
  }
  return { name: flowName || name, passed, total, failed, steps };
}

function loadBaseline(baselinePath) {
  if (!baselinePath) return null;
  if (!fs.existsSync(baselinePath)) return null; // first run: no baseline yet is not an error
  const parsed = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  // Accept either a bare findings[] or a full report JSON (as written by --json-out).
  return Array.isArray(parsed) ? parsed : parsed.findings || [];
}

const VERDICT_BADGE = { ready: "🟢 SHIP-READY", caution: "🟡 CAUTION", blocked: "🔴 BLOCKED" };
const SEV_ICON = { critical: "🟥", high: "🟧", medium: "🟨", low: "🟩" };

function renderMarkdown(report, regression, flows, gate) {
  const lines = [];
  lines.push(`## AutoTap release check — ${VERDICT_BADGE[report.verdict] || report.verdict}`);
  lines.push("");
  lines.push(report.headline);
  lines.push("");
  lines.push(`**${report.confidence}% confidence** · ${report.screensExplored} screens · ${report.actionsPerformed} actions · ${report.findingCounts.total} finding(s)`);
  if (report.findings.length) {
    lines.push("");
    lines.push("| | Severity | Finding | Screen |");
    lines.push("|---|---|---|---|");
    for (const f of report.findings) {
      lines.push(`| ${SEV_ICON[f.severity] || ""} | ${f.severity} | ${f.title} | ${f.screen ?? "—"} |`);
    }
  }
  if (regression) {
    const g = regression.gate;
    lines.push("");
    lines.push(`### Since baseline — ${g.failed ? "🔴 regression gate FAILED" : "🟢 regression gate passed"}`);
    lines.push(`+${regression.counts.new} new · ${regression.counts.persisting} persisting · ${regression.counts.resolved} resolved` +
      (g.failed ? ` — **${g.newCritical} new critical, ${g.newHigh} new high**` : ""));
    for (const f of regression.newFindings) {
      lines.push(`- NEW ${SEV_ICON[f.severity] || ""} ${f.severity}: ${f.title} (${f.screen ?? "—"})`);
    }
  }
  if (flows.length) {
    lines.push("");
    const failedFlows = flows.filter((f) => !f.passed);
    lines.push(`### Flows — ${failedFlows.length ? `🔴 ${failedFlows.length}/${flows.length} failed` : `🟢 ${flows.length}/${flows.length} passed`}`);
    for (const f of flows) {
      const firstFail = f.steps.find((s) => s.status === "fail");
      lines.push(`- ${f.passed ? "✅" : "❌"} **${f.name}** — ${f.steps.filter((s) => s.status === "pass").length}/${f.total} steps` +
        (firstFail ? ` — failed at \`${firstFail.action} ${firstFail.target}\`${firstFail.detail ? `: ${firstFail.detail}` : ""}` : "") +
        (f.missing ? " — log missing (flow did not run)" : ""));
    }
  }
  lines.push("");
  lines.push(`**Gate (${gate.policy}): ${gate.failed ? "🔴 FAIL" : "🟢 PASS"}**${gate.reasons.length ? " — " + gate.reasons.join("; ") : ""}`);
  return lines.join("\n");
}

const args = parseArgs(process.argv.slice(2));
const report = buildQaReport(args.markers);
if (!report) {
  console.error(`No OCQA markers found at ${args.markers} — the exploration did not run.`);
  process.exit(1);
}
const baseline = loadBaseline(args.baseline);
const regression = computeRegression(report.findings, baseline);
const flows = args.flowLogs.map(parseFlowLog);

const reasons = [];
const failedFlows = flows.filter((f) => !f.passed);
if (failedFlows.length) reasons.push(`${failedFlows.length} flow(s) failed`);
if (args.failOn === "any") {
  if (report.findingCounts.total > 0) reasons.push(`${report.findingCounts.total} finding(s) (fail-on: any)`);
} else if (args.failOn === "blocked" || (args.failOn === "gate" && !regression)) {
  if (report.verdict === "blocked") reasons.push("verdict is blocked");
  if (report.inconclusive) reasons.push("run was inconclusive (coverage floor not met)");
} else if (regression?.gate.failed) {
  reasons.push(`${regression.gate.newCritical} new critical + ${regression.gate.newHigh} new high vs. baseline`);
}
const gate = { policy: args.failOn, failed: reasons.length > 0, reasons };

const md = renderMarkdown(report, regression, flows, gate);
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}
if (args.mdOut) {
  fs.writeFileSync(args.mdOut, md + "\n");
}
if (args.jsonOut) {
  fs.writeFileSync(args.jsonOut, JSON.stringify({ ...report, regression, flows, gate }, null, 2) + "\n");
}
process.exit(gate.failed ? 1 : 0);

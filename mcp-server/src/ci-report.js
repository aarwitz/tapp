#!/usr/bin/env node
// tapp CI gate — the report/verdict half of scripts/ci-gate.sh.
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
//                         [--html-dir <capture-dir>]        # self-contained evidence index in the capture
//                         [--label <app-or-run-label>]      # label shown in the HTML report
//                         [--pr-plan <plan.json>]           # selected PR contract execution manifest
//                         [--project-dir <repo> --maintenance-url <url>]
//                                                           # optional disposable web patch replay
//                         [--fail-on <gate|blocked|any>]    # default: gate
//
// Gate policy (--fail-on):
//   gate     fail when the run introduced NEW high/critical findings vs. the baseline
//            (no baseline ⇒ falls back to `blocked`), or when any flow failed. The default:
//            pre-existing debt doesn't block, regressions and broken flows do.
//   blocked  fail when the verdict is blocked/inconclusive, or when any flow failed.
//   any      fail on any finding at all, or any flow failure. Strictest.
import fs from "fs";
import path from "node:path";
import { buildQaReport, computeRegression, computeContentCollapse, computeReachabilityLoss, verdictBadge } from "./report.js";
import { writeHtmlReport } from "./html-report.js";
import { buildUiMapFromMarkers, writeUiMap } from "./ui-map.js";
import { proposeSelectorMaintenance, validateWebMaintenanceProposal } from "./maintenance-proposal.js";
import { isBusinessUiMapNode, releasePlanCandidateFromUiMapNode } from "./application-model.js";
import { existingProjectArtifactPath } from "./project-paths.js";

function parseArgs(argv) {
  const args = { flowLogs: [], failOn: "gate" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--markers") args.markers = argv[++i];
    else if (a === "--baseline") args.baseline = argv[++i];
    else if (a === "--flow-log" || a === "--scenario-log" || a === "--contract-log") args.flowLogs.push(argv[++i]);
    else if (a === "--json-out") args.jsonOut = argv[++i];
    else if (a === "--md-out") args.mdOut = argv[++i];
    else if (a === "--html-dir") args.htmlDir = argv[++i];
    else if (a === "--label") args.label = argv[++i];
    else if (a === "--platform") args.platform = argv[++i];
    else if (a === "--target-key") args.targetKey = argv[++i];
    else if (a === "--fail-on") args.failOn = argv[++i];
    else if (a === "--pr-plan") args.prPlan = argv[++i];
    else if (a === "--project-dir") args.projectDir = argv[++i];
    else if (a === "--maintenance-url") args.maintenanceUrl = argv[++i];
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

async function validateMaintenancePlan(plan, args) {
  if (!plan || plan.platform !== "web" || !args.projectDir || !args.maintenanceUrl) return plan;
  let remaining = 3;
  for (const candidate of plan.maintenanceCandidates || []) {
    if (candidate.proposal?.kind !== "task-maintenance-patch") continue;
    if (remaining <= 0) {
      candidate.proposal.validation = { status: "not-run", passed: false, reason: "Per-run disposable maintenance validation limit (3) reached" };
      continue;
    }
    remaining -= 1;
    try {
      const validation = await validateWebMaintenanceProposal({
        proposal: candidate.proposal,
        projectDir: args.projectDir,
        url: args.maintenanceUrl,
        evidenceDir: args.htmlDir ? path.join(args.htmlDir, "maintenance") : "",
      });
      if (args.htmlDir && validation.evidence?.screenshotDir) {
        validation.evidence.artifactPath = path.relative(args.htmlDir, validation.evidence.screenshotDir).replaceAll(path.sep, "/");
      }
      candidate.proposal = {
        ...candidate.proposal,
        status: validation.passed ? "validated-awaiting-review" : "validation-failed",
        validation,
      };
    } catch (error) {
      candidate.proposal.validation = { status: "not-run", passed: false, reason: error.message || String(error) };
    }
  }
  return plan;
}

// Port of flow_lib.py report() / FlowRunnerService.parseReport — kept in sync deliberately.
function parseFlowLog(logPath) {
  const name = logPath.split("/").pop().replace(/\.log$/, "");
  if (!fs.existsSync(logPath)) return { name, passed: false, total: 0, failed: 0, steps: [], missing: true };
  const steps = [];
  let total = 0, executed = 0, failed = 0, passed = false, sawResult = false, flowName = null, kind = "flow", contract = "", criticality = "";
  for (const raw of fs.readFileSync(logPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("OCQA_FLOW_STEP:{")) {
      try {
        const o = JSON.parse(line.slice("OCQA_FLOW_STEP:".length));
        steps.push({ status: o.status || "?", action: o.action || "", target: o.target || "", detail: o.detail || "", ...(o.actor ? { actor: o.actor } : {}), ...(o.task ? { task: o.task } : {}), ...(o.contract ? { contract: o.contract } : {}) });
      } catch { /* ignore malformed */ }
    } else if (line.startsWith("OCQA_FLOW_RESULT:{")) {
      try {
        const o = JSON.parse(line.slice("OCQA_FLOW_RESULT:".length));
        total = o.total ?? steps.length;
        executed = o.executed ?? steps.length;
        failed = o.failed ?? steps.filter((s) => s.status === "fail").length;
        passed = o.passed ?? (failed === 0 && steps.length > 0);
        if (o.name) flowName = o.name;
        if (o.kind) kind = o.kind;
        if (o.contract) contract = o.contract;
        if (o.criticality) criticality = o.criticality;
        sawResult = true;
      } catch { /* ignore malformed */ }
    }
  }
  if (!sawResult) {
    total = steps.length;
    executed = steps.length;
    failed = steps.filter((s) => s.status === "fail").length;
    passed = steps.length > 0 && failed === 0;
  }
  return { name: flowName || name, kind, ...(contract ? { contract, criticality } : {}), passed, total, executed, failed, steps };
}

function loadBaseline(baselinePath) {
  if (!baselinePath) return null;
  if (!fs.existsSync(baselinePath)) return null; // first run: no baseline yet is not an error
  const parsed = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  // Accept either a bare findings[] or a full report JSON (as written by --json-out).
  // Keep the full report when available — the gate needs the baseline's inconclusive flag.
  if (Array.isArray(parsed)) return { findings: parsed, inconclusive: false, screenElementCounts: null, screens: null, actionsPerformed: 0 };
  return {
    findings: parsed.findings || [],
    inconclusive: !!parsed.inconclusive,
    screenElementCounts: parsed.screenElementCounts || null,
    screens: parsed.screens || null,
    actionsPerformed: parsed.actionsPerformed || 0,
    platform: parsed.baselineIdentity?.platform || parsed.platform || null,
    targetKey: parsed.baselineIdentity?.targetId || parsed.targetKey || null,
  };
}

function loadPrPlan(planPath) {
  if (!planPath) return null;
  if (!fs.existsSync(planPath)) throw new Error(`PR plan not found: ${planPath}`);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  if (plan?.schemaVersion !== 1 || !Array.isArray(plan.selected) || !Array.isArray(plan.changedFiles)) {
    throw new Error("PR plan must be a UI-aware Tapp PR plan v1");
  }
  return plan;
}

function prTargetMarkers(markersPath) {
  const markers = new Map();
  if (!markersPath || !fs.existsSync(markersPath)) return markers;
  for (const line of fs.readFileSync(markersPath, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^OCQA_PR_TARGET:(\{.*\})$/);
    if (!match) continue;
    try {
      const value = JSON.parse(match[1]);
      if (!["observed", "failed"].includes(value.status)) continue;
      if (typeof value.targetId === "string" && value.targetId) markers.set(`id:${value.targetId}`, value);
      if (typeof value.route === "string" && value.route) markers.set(`route:${value.route}`, value);
    } catch {}
  }
  return markers;
}

function controlKeys(control) {
  return new Set([control?.id, control?.semanticKey, control?.label, ...(control?.selectors || []).map((selector) => selector.value)]
    .filter(Boolean).map((value) => String(value).toLowerCase()));
}

function sameControl(left, right) {
  const leftKeys = controlKeys(left);
  return [...controlKeys(right)].some((key) => leftKeys.has(key));
}

function targetCoverageDisposition(target, currentNode, projectDir = "") {
  if (!currentNode || !isBusinessUiMapNode(currentNode)) return {};
  const item = releasePlanCandidateFromUiMapNode(currentNode, [target.platform], "customer");
  item.groundedBy.push({
    type: "pr-exploration",
    targetId: target.id,
    changedFiles: target.changedFiles || [],
    route: target.navigation?.route || "",
    navigationMode: target.navigation?.mode || (target.navigation?.route ? "route" : "unknown"),
    edgeIds: (target.navigation?.steps || []).map((step) => step.edgeId),
    provenance: "runtime-observed",
  });
  if (projectDir) {
    const releasePlanPath = existingProjectArtifactPath(path.resolve(projectDir), "release-plan.json");
    try {
      const releasePlan = JSON.parse(fs.readFileSync(releasePlanPath, "utf8"));
      const existing = (releasePlan.items || []).find((candidate) => candidate.id === item.id || candidate.name === item.name ||
        (candidate.groundedBy || []).some((ground) => ground.type === "ui-map-node" && ground.id === currentNode.id));
      if (existing) return {
        existingReleasePlanItem: {
          path: ".tapp/release-plan.json",
          id: existing.id,
          name: existing.name,
          decision: existing.decision,
          origin: existing.origin,
          detail: "The repository release plan already records this grounded UI Map coverage decision; Tapp preserved it instead of proposing a duplicate.",
        },
        coverageProposal: {
          kind: "release-plan-item-proposal",
          status: "matches-existing-release-plan",
          autoApply: false,
          targetPath: ".tapp/release-plan.json",
          operation: { op: "reconcile-item", item },
          reason: "Fresh PR runtime and changed-file evidence can be attached to the existing grounded item only through explicit adoption; its current human decision is preserved.",
          requiredValidation: "After explicit evidence reconciliation, keep the normal review, generation, deterministic replay, and promotion requirements.",
        },
      };
    } catch {}
  }
  return { coverageProposal: {
    kind: "release-plan-item-proposal",
    status: "awaiting-explicit-adoption",
    autoApply: false,
    targetPath: ".tapp/release-plan.json",
    operation: { op: "add-item", item },
    reason: `The changed ${currentNode.name} surface was observed in this PR run but is not covered by a selected release contract.`,
    requiredValidation: "Explicitly adopt and review this item, generate reusable UI-Map-backed Tasks, then replay the resulting contract against the real target before promotion.",
  } };
}

function enrichExplorationTargets(plan, currentUiMap, markersPath, projectDir = "") {
  const markers = prTargetMarkers(markersPath);
  return (plan.explorationTargets || []).map((target) => {
    if (target.navigation?.status !== "replayable") return { ...target, status: "blocked", execution: { status: "blocked", conclusive: false, reason: target.navigation?.reason || "No replayable navigation reference" } };
    const marker = markers.get(`id:${target.id}`) || (target.navigation.route ? markers.get(`route:${target.navigation.route}`) : null);
    if (!marker) return { ...target, status: "not-reached", execution: { status: "not-reached", conclusive: false, reason: "The bounded exploration run did not observe its planned UI Map target" } };
    if (marker.status === "failed") return { ...target, status: "failed", execution: { status: "failed", conclusive: false, error: marker.error || "Navigation failed" } };
    const currentNode = (currentUiMap?.nodes || []).find((node) => node.id === target.node?.id) || (currentUiMap?.nodes || []).find((node) =>
      (node.routes || []).some((route) => route.platform === target.platform && route.path === target.navigation.route) ||
      node.semanticKey === target.node?.semanticKey || node.name === marker.screen);
    const baselineControls = target.baselineControls || [];
    const currentControls = currentNode?.controls || [];
    const notObserved = baselineControls.filter((baseline) => !currentControls.some((current) => sameControl(baseline, current)));
    const added = currentControls.filter((current) => !baselineControls.some((baseline) => sameControl(baseline, current)));
    const coverageDisposition = target.coverage?.status === "not-covered-by-selected-contract" ? targetCoverageDisposition(target, currentNode, projectDir) : {};
    return {
      ...target,
      status: "observed",
      execution: {
        status: "observed",
        conclusive: true,
        navigation: {
          mode: target.navigation.mode || (target.navigation.route ? "route" : "unknown"),
          ...(target.navigation.route ? { route: target.navigation.route } : {}),
          edgeIds: (target.navigation.steps || []).map((step) => step.edgeId),
        },
        screen: marker.screen || currentNode?.name || target.node?.name,
        currentNodeId: currentNode?.id || null,
        evidence: { marker: "OCQA_PR_TARGET", uiMapArtifact: currentUiMap ? "ui-map.json" : null },
        controls: {
          baseline: baselineControls.length,
          current: currentControls.length,
          retained: baselineControls.length - notObserved.length,
          notObserved: notObserved.map((control) => ({ id: control.id, label: control.label })),
          added: added.map((control) => ({ id: control.id, label: control.label })),
        },
      },
      ...coverageDisposition,
    };
  });
}

function enrichPrPlan(plan, contracts, currentUiMap = null, markersPath = "", projectDir = "") {
  if (!plan) return null;
  const results = new Map(contracts.map((contract) => [contract.contract, contract]));
  const selected = plan.selected.map((item) => {
    const result = results.get(item.name);
    const firstFailure = result?.steps?.find((step) => step.status === "fail");
    return {
      ...item,
      execution: result ? {
        status: result.passed ? "passed" : "failed",
        passed: result.passed,
        executed: result.executed,
        total: result.total,
        ...(firstFailure ? { firstFailure } : {}),
      } : { status: "not-run", passed: false, executed: 0, total: 0 },
    };
  });
  const selectedByName = new Map(selected.map((item) => [item.name, item]));
  const maintenanceCandidates = (plan.maintenanceCandidates || []).map((candidate) => {
    const selectedContract = selectedByName.get(candidate.contract);
    const status = selectedContract?.execution?.status || "not-run";
    const selectorPatch = status === "failed" ? proposeSelectorMaintenance({ candidate, execution: selectedContract?.execution, currentMap: currentUiMap, platform: plan.platform }) : null;
    return {
      ...candidate,
      disposition: status === "passed" ? "not-required" : status === "failed" ? "review-required" : "execution-missing",
      replayEvidence: selectedContract?.execution || { status: "not-run", passed: false, executed: 0, total: 0 },
      proposal: selectorPatch || (status === "failed" ? {
        kind: "task-maintenance-candidate",
        status: "unclassified",
        editablePaths: candidate.taskPaths || [],
        preservedIntent: [candidate.contract],
        reason: "A changed Task-owned surface and the unchanged contract both have failure evidence. Determine whether this is an intentional UI change or a product regression before authoring a patch.",
        requiredValidation: "Replay the unchanged business contract after the reviewed Task-only patch; do not weaken or silently rewrite contract assertions.",
      } : null),
    };
  });
  const explorationTargets = enrichExplorationTargets(plan, currentUiMap, markersPath, projectDir);
  const counts = {
    selected: selected.length,
    passed: selected.filter((item) => item.execution.status === "passed").length,
    failed: selected.filter((item) => item.execution.status === "failed").length,
    notRun: selected.filter((item) => item.execution.status === "not-run").length,
    skipped: plan.skipped?.length || 0,
    unknownFiles: plan.uncoveredChangedFiles?.length || 0,
    mappedCoverageGaps: (plan.uncoveredUiMap?.nodes?.length || 0) + (plan.uncoveredUiMap?.edges?.length || 0),
    explorationPlanned: explorationTargets.length,
    explorationObserved: explorationTargets.filter((target) => target.execution?.status === "observed").length,
    explorationFailed: explorationTargets.filter((target) => ["failed", "not-reached"].includes(target.execution?.status)).length,
    explorationBlocked: explorationTargets.filter((target) => target.execution?.status === "blocked").length,
    coverageProposals: explorationTargets.filter((target) => target.coverageProposal?.status === "awaiting-explicit-adoption").length,
    evidenceReconciliations: explorationTargets.filter((target) => target.coverageProposal?.status === "matches-existing-release-plan").length,
    existingPlanItems: explorationTargets.filter((target) => target.existingReleasePlanItem).length,
  };
  return { ...plan, selected, explorationTargets, maintenanceCandidates, execution: counts };
}

const SEV_ICON = { critical: "🟥", high: "🟧", medium: "🟨", low: "🟩" };

function renderMarkdown(report, regression, flows, scenarios, contracts, prPlan, gate) {
  const lines = [];
  lines.push(`## tapp release check — ${verdictBadge(report)}`);
  lines.push("");
  lines.push(report.headline);
  lines.push("");
  lines.push(`**release score ${report.confidence}/100** · ${report.screensExplored} screens · ${report.actionsPerformed} actions · ${report.findingCounts.total} finding(s)`);
  if (report.uiMap) lines.push(`**UI Map:** ${report.uiMap.nodeCount} states · ${report.uiMap.edgeCount} transitions · ${report.uiMap.controlCount} semantic controls`);
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
  } else if (gate.policy === "gate") {
    lines.push("");
    lines.push("### Baseline — 🟡 not active yet");
    lines.push("No baseline was supplied, so this run used the blocked/inconclusive fallback. Save this report as a baseline—or run the GitHub Action on the default branch—to activate new-regression gating.");
  }
  if (prPlan) {
    lines.push("");
    const counts = prPlan.execution;
    lines.push(`### PR release plan — ${counts.failed || counts.notRun ? "🔴 incomplete" : "🟢 executed"}`);
    lines.push(`${counts.selected} selected · ${counts.skipped} skipped · ${counts.unknownFiles} unknown changed file(s) · ${counts.mappedCoverageGaps} mapped coverage gap(s)`);
    for (const contract of prPlan.selected) {
      const icon = contract.execution.status === "passed" ? "✅" : contract.execution.status === "failed" ? "❌" : "⚠️";
      lines.push(`- ${icon} **${contract.name}** — ${contract.execution.status}; ${contract.reasons.map((reason) => reason.type).join(", ")}`);
    }
    for (const file of prPlan.uncoveredChangedFiles || []) lines.push(`- ⚠️ Unknown ownership: \`${file}\``);
    for (const node of prPlan.uncoveredUiMap?.nodes || []) lines.push(`- ⚠️ Changed mapped state lacks a selected contract: \`${node}\``);
    for (const edge of prPlan.uncoveredUiMap?.edges || []) lines.push(`- ⚠️ Changed mapped transition lacks a selected contract: \`${edge}\``);
    for (const target of prPlan.explorationTargets || []) {
      const icon = target.execution?.status === "observed" ? "🔎" : target.execution?.status === "blocked" ? "⚠️" : "❌";
      const navigation = target.navigation?.route
        ? ` at \`${target.navigation.route}\``
        : target.navigation?.mode === "ui-map-path" ? ` through ${(target.navigation.steps || []).length} observed map edge(s)` : "";
      lines.push(`- ${icon} PR exploration **${target.node?.name || target.id}** — ${target.execution?.status || target.status}${navigation}`);
      if (target.coverageProposal?.status === "awaiting-explicit-adoption") lines.push(`  - Reviewable coverage proposal ready; never auto-applied. Next: \`tapp pr adopt <pr-plan.json> --item ${target.id} --project-dir .\``);
      if (target.existingReleasePlanItem) {
        lines.push(`  - Existing release-plan item \`${target.existingReleasePlanItem.name}\` remains ${target.existingReleasePlanItem.decision}; no duplicate or decision change was made.`);
        lines.push(`  - Optional explicit evidence reconciliation: \`tapp pr adopt <pr-plan.json> --item ${target.id} --project-dir .\``);
      }
    }
    for (const candidate of prPlan.maintenanceCandidates || []) {
      if (candidate.disposition === "review-required") {
        const patch = candidate.proposal?.kind === "task-maintenance-patch" ? candidate.proposal.operations?.[0] : null;
        lines.push(`- 🛠️ **${candidate.contract}** — Task maintenance review required; existing contract remains failed and unchanged`);
        if (patch) {
          const validation = candidate.proposal.validation;
          const proof = validation?.passed
            ? `validated ${validation.executed}/${validation.total} in a disposable real-target replay${validation.evidence?.artifactPath ? ` (evidence: \`${validation.evidence.artifactPath}\`)` : ""}; awaiting review and never auto-applied`
            : `unvalidated and never auto-applied`;
          lines.push(`  - Proposed Task-only selector patch: \`${patch.taskPath}${patch.pointer}\` · \`${patch.before}\` → \`${patch.after}\` (${patch.selector.kind}); ${proof}`);
        }
      }
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
  if (scenarios.length) {
    lines.push("");
    const failedScenarios = scenarios.filter((scenario) => !scenario.passed);
    lines.push(`### Multi-actor Scenarios — ${failedScenarios.length ? `🔴 ${failedScenarios.length}/${scenarios.length} failed` : `🟢 ${scenarios.length}/${scenarios.length} passed`}`);
    for (const scenario of scenarios) {
      const firstFail = scenario.steps.find((step) => step.status === "fail");
      const actors = [...new Set(scenario.steps.map((step) => step.actor).filter((actor) => actor && !["setup", "teardown"].includes(actor)))];
      lines.push(`- ${scenario.passed ? "✅" : "❌"} **${scenario.name}** — ${actors.length} isolated actor(s) · ${scenario.executed}/${scenario.total} steps executed` +
        (firstFail ? ` — failed for **${firstFail.actor || "scenario"}** at \`${firstFail.action} ${firstFail.target}\`${firstFail.detail ? `: ${firstFail.detail}` : ""}` : ""));
    }
  }
  if (contracts.length) {
    lines.push("");
    const failedContracts = contracts.filter((contract) => !contract.passed);
    lines.push(`### Release Contracts — ${failedContracts.length ? `🔴 ${failedContracts.length}/${contracts.length} failed` : `🟢 ${contracts.length}/${contracts.length} passed`}`);
    for (const contract of contracts) {
      const firstFail = contract.steps.find((step) => step.status === "fail");
      const actors = [...new Set(contract.steps.map((step) => step.actor).filter((actor) => actor && !["setup", "teardown"].includes(actor)))];
      lines.push(`- ${contract.passed ? "✅" : "❌"} **${contract.name}** — ${contract.criticality || "unspecified"} · ${actors.length || 1} actor(s) · ${contract.executed}/${contract.total} steps executed` +
        (firstFail ? ` — failed${firstFail.actor ? ` for **${firstFail.actor}**` : ""} at \`${firstFail.action} ${firstFail.target}\`${firstFail.task ? ` (Task \`${firstFail.task}\`)` : ""}${firstFail.detail ? `: ${firstFail.detail}` : ""}` : ""));
    }
  }
  lines.push("");
  lines.push(`**Gate (${gate.policy}): ${gate.failed ? "🔴 FAIL" : "🟢 PASS"}**${gate.reasons.length ? " — " + gate.reasons.join("; ") : ""}`);
  return lines.join("\n");
}

const args = parseArgs(process.argv.slice(2));
const report = buildQaReport(args.markers, { platform: args.platform || "ios" });
if (!report) {
  console.error(`No OCQA markers found at ${args.markers} — the exploration did not run.`);
  process.exit(1);
}
let currentUiMap = null;
if (args.htmlDir) {
  try {
    const map = buildUiMapFromMarkers({ markersPath: args.markers, platform: args.platform || "ios", target: args.label || "", runId: path.basename(args.htmlDir) });
    currentUiMap = map;
    const mapPath = writeUiMap(path.join(args.htmlDir, "ui-map.json"), map);
    report.uiMap = {
      schemaVersion: map.schemaVersion,
      path: mapPath,
      nodeCount: map.nodes.length,
      edgeCount: map.edges.length,
      controlCount: map.nodes.reduce((total, node) => total + node.controls.length, 0),
    };
  } catch (error) {
    report.uiMap = { error: error.message || String(error) };
  }
}
const baseline = loadBaseline(args.baseline);
if (baseline?.platform && baseline.platform !== (args.platform || "ios")) {
  console.error(`Baseline platform '${baseline.platform}' does not match current platform '${args.platform || "ios"}'`);
  process.exit(2);
}
if (baseline?.targetKey && baseline.targetKey !== args.targetKey) {
  console.error(`Baseline target '${baseline.targetKey}' does not match current target '${args.targetKey || "unspecified"}'; pass the application-model target id with --target-key`);
  process.exit(2);
}
if (args.targetKey) report.targetKey = args.targetKey;
// Content-collapse findings are cross-run by nature — merge them into the current findings
// BEFORE the regression diff so they count as new-vs-baseline and drive the gate normally.
const collapsed = [
  ...computeContentCollapse(report.screenElementCounts, baseline?.screenElementCounts),
  ...computeReachabilityLoss(report, baseline),
];
if (collapsed.length) {
  report.findings.push(...collapsed);
  report.findingCounts.high += collapsed.length;
  report.findingCounts.total += collapsed.length;
  // Keep the displayed verdict consistent with the merged findings (same scoring as report.js:
  // high costs 10 confidence; any high caps the verdict at caution).
  report.confidence = Math.max(0, report.confidence - collapsed.length * 10);
  report.releaseScore = report.confidence;
  if (report.verdict === "ready") report.verdict = report.confidence < 50 ? "blocked" : "caution";
  report.headline = `Proceed with caution — ${collapsed.length} screen(s) regressed vs. baseline (content collapsed or became unreachable).`;
}
const regression = computeRegression(report.findings, baseline?.findings ?? null);
const runs = args.flowLogs.map(parseFlowLog);
const contracts = runs.filter((run) => run.kind === "release-contract");
const flows = runs.filter((run) => !["scenario", "release-contract"].includes(run.kind));
const scenarios = runs.filter((run) => run.kind === "scenario");
let prPlan;
try {
  prPlan = enrichPrPlan(loadPrPlan(args.prPlan), contracts, currentUiMap, args.markers, args.projectDir || "");
  prPlan = await validateMaintenancePlan(prPlan, args);
  if (prPlan && args.prPlan) fs.writeFileSync(args.prPlan, JSON.stringify(prPlan, null, 2) + "\n");
} catch (error) {
  console.error(`Could not load PR plan: ${error.message || String(error)}`);
  process.exit(2);
}

const reasons = [];
const failedFlows = flows.filter((f) => !f.passed);
if (failedFlows.length) reasons.push(`${failedFlows.length} flow(s) failed`);
const failedScenarios = scenarios.filter((scenario) => !scenario.passed);
if (failedScenarios.length) reasons.push(`${failedScenarios.length} multi-actor scenario(s) failed`);
const failedContracts = contracts.filter((contract) => !contract.passed);
if (failedContracts.length) reasons.push(`${failedContracts.length} release contract(s) failed`);
if (prPlan?.execution.notRun) reasons.push(`${prPlan.execution.notRun} selected release contract(s) did not run`);
if (prPlan?.execution.explorationFailed) reasons.push(`${prPlan.execution.explorationFailed} planned PR exploration target(s) failed or were not reached`);
if (args.failOn === "any") {
  if (report.findingCounts.total > 0) reasons.push(`${report.findingCounts.total} finding(s) (fail-on: any)`);
} else if (args.failOn === "blocked" || (args.failOn === "gate" && !regression)) {
  if (report.verdict === "blocked") reasons.push("verdict is blocked");
  if (report.inconclusive) reasons.push("run was inconclusive (coverage floor not met)");
} else {
  if (regression?.gate.failed) {
    reasons.push(`${regression.gate.newCritical} new critical + ${regression.gate.newHigh} new high vs. baseline`);
  }
  // A regression gate must also catch regressions in EXPLORABILITY, not just in findings:
  // a change that makes the app crash at launch (or reintroduces a login wall) produces an
  // inconclusive run with zero new findings — that must never pass. (Found via corpus
  // bug-seeding: a seeded crash-at-startup sailed through on the findings diff alone.)
  if (report.verdict === "blocked") reasons.push("verdict is blocked");
  if (report.inconclusive && !baseline.inconclusive) {
    reasons.push("run became inconclusive vs. baseline (app may no longer launch/explore)");
  }
}
const gate = { policy: args.failOn, failed: reasons.length > 0, reasons };

const md = renderMarkdown(report, regression, flows, scenarios, contracts, prPlan, gate);
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}
if (args.mdOut) {
  fs.writeFileSync(args.mdOut, md + "\n");
}
if (args.jsonOut) {
  fs.writeFileSync(args.jsonOut, JSON.stringify({ ...report, regression, flows, scenarios, contracts, ...(prPlan ? { prPlan } : {}), gate }, null, 2) + "\n");
}
if (args.htmlDir) {
  const html = writeHtmlReport(args.htmlDir, { report, label: args.label || "CI run" });
  if (html) console.log(`\nEvidence report: ${html}`);
}
process.exit(gate.failed ? 1 : 0);

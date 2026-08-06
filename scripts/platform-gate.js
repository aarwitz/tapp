#!/usr/bin/env node
// CI orchestration for the platform drivers that do not need Xcode. The report,
// baseline, Flow, and merge-gate behavior is the same ci-report.js used by iOS.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runQaAndroid, runQaWeb, startManagedWebTarget, stopManagedWebTarget } from "../mcp-server/src/index.js";
import { runAndroidFlow } from "../mcp-server/src/android-flow.js";
import { inferFlowPlatform, loadFlowFile } from "../mcp-server/src/flow-runtime.js";
import { runWebFlow } from "../mcp-server/src/web-flow.js";
import { runWebScenario, validateScenario } from "../mcp-server/src/scenario-runtime.js";
import { compileReleaseContract, loadReleaseContractFile } from "../mcp-server/src/release-contract.js";
import { prExplorationTargetsFromPlan } from "../mcp-server/src/pr-selection.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = { flows: [], scenarios: [], contracts: [], actions: 40, timeout: 600, failOn: "gate" };
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  const value = process.argv[++i];
  if (key === "--flow") args.flows.push(value);
  else if (key === "--scenario") args.scenarios.push(value);
  else if (key === "--contract") args.contracts.push(value);
  else if (key === "--platform") args.platform = value;
  else if (key === "--url") args.url = value;
  else if (key === "--project-dir") args.projectDir = value;
  else if (key === "--web-target") args.webTarget = value;
  else if (key === "--target-key") args.targetKey = value;
  else if (key === "--app-id") args.appId = value;
  else if (key === "--apk") args.apk = value;
  else if (key === "--serial") args.serial = value;
  else if (key === "--actions") args.actions = Number(value);
  else if (key === "--timeout") args.timeout = Number(value);
  else if (key === "--baseline") args.baseline = value;
  else if (key === "--fail-on") args.failOn = value;
  else if (key === "--json-out") args.jsonOut = value;
  else if (key === "--md-out") args.mdOut = value;
  else if (key === "--pr-plan") args.prPlan = value;
  else throw new Error(`Unknown argument: ${key}`);
}
if (!["web", "android"].includes(args.platform)) throw new Error("--platform must be web|android");
if (args.platform === "web" && !args.url && !args.projectDir) throw new Error("Web gate requires --url or --project-dir for managed build/start");
if (args.platform === "android" && !args.appId) throw new Error("Android gate requires --app-id");
if (args.projectDir) {
  args.projectDir = fs.realpathSync(path.resolve(args.projectDir));
  if (!fs.statSync(args.projectDir).isDirectory()) throw new Error(`Project directory not found: ${args.projectDir}`);
}

// Parse and platform-filter before launching a browser/device so a typo cannot
// spend the entire CI budget and then silently run zero committed tests.
const selectedFlows = args.flows.map((flowPath) => ({ flowPath, flow: loadFlowFile(flowPath) }))
  .filter(({ flow }) => inferFlowPlatform(flow) === args.platform);
if (args.flows.length && selectedFlows.length === 0) {
  console.error(`❌ None of the supplied Flows target platform '${args.platform}'`);
  process.exit(2);
}
const selectedScenarios = args.scenarios.map((scenarioPath) => ({ scenarioPath, scenario: loadFlowFile(scenarioPath) }));
for (const { scenarioPath, scenario } of selectedScenarios) {
  const errors = validateScenario({ ...scenario, platform: scenario.platform || args.platform });
  if (errors.length) {
    console.error(`❌ Invalid Scenario ${scenarioPath}: ${errors.join("; ")}`);
    process.exit(2);
  }
  if (args.platform !== "web") {
    console.error(`❌ Multi-actor Scenario ${scenarioPath} requires platform 'web'; ${args.platform} actor isolation is not implemented`);
    process.exit(2);
  }
}
const selectedContracts = [];
for (const contractPath of args.contracts) {
  let contract;
  try { contract = await loadReleaseContractFile(contractPath); }
  catch (error) { console.error(`❌ Invalid Release Contract ${contractPath}: ${error.message}`); process.exit(2); }
  if (!contract.platforms.includes(args.platform)) continue;
  try {
    selectedContracts.push({ contractPath, contract, execution: compileReleaseContract(contract, { platform: args.platform, sourcePath: contractPath }) });
  } catch (error) {
    console.error(`❌ Could not compile Release Contract ${contractPath}: ${error.message}`);
    process.exit(2);
  }
}

let prPlan = null;
let prExplorationTargets = [];
if (args.prPlan) {
  try {
    prPlan = JSON.parse(fs.readFileSync(path.resolve(args.prPlan), "utf8"));
    prExplorationTargets = prExplorationTargetsFromPlan(prPlan, args.platform);
  } catch (error) {
    console.error(`❌ Could not read PR plan ${args.prPlan}: ${error.message || error}`);
    process.exit(2);
  }
}

let managedRuntime = null;
let exitCode = 1;
try {
  if (args.platform === "web" && !args.url) {
    const started = await startManagedWebTarget({
      root: args.projectDir,
      requestedTarget: args.webTarget || "",
      timeout: args.timeout,
      onStatus: (status) => console.error(`⏳ ${status}`),
    });
    if (started.error) {
      console.error(`❌ ${started.error}`);
      if (started.details?.remediation) console.error(`   ${started.details.remediation}`);
      process.exitCode = 1;
    } else {
      managedRuntime = started;
      args.url = started.url;
      console.error(`🎯 Managed web target ready at ${args.url}; it will be stopped after the gate.`);
    }
  }
  if (args.platform === "web" && !args.url) {
    exitCode = 1;
  } else {
    const qa = args.platform === "web"
      ? await runQaWeb({ url: args.url, maxActions: args.actions, timeout: args.timeout, testEmail: process.env.OCQA_TEST_EMAIL, testPassword: process.env.OCQA_TEST_PASSWORD, seedTargets: prExplorationTargets })
      : await runQaAndroid({ appId: args.appId, apkPath: args.apk, serial: args.serial, maxActions: args.actions, timeout: args.timeout,
          testEmail: process.env.OCQA_TEST_EMAIL, testPassword: process.env.OCQA_TEST_PASSWORD, seedTargets: prExplorationTargets });
    if (qa.error) {
      console.error(`❌ ${qa.error}`);
      exitCode = 1;
    } else {
      const captureDir = qa.structured.capture.path;
      const markers = path.join(captureDir, "ocqa-markers.txt");
      const flowLogs = [];
      for (const { flowPath, flow } of selectedFlows) {
  const logPath = path.join(os.tmpdir(), `tapp-ci-${args.platform}-${path.basename(flowPath).replace(/\.ya?ml$/i, "")}-${Date.now()}.log`);
  const evidenceDir = path.join(captureDir, "flows", path.basename(flowPath).replace(/\.ya?ml$/i, ""));
  try {
    if (args.platform === "web") await runWebFlow({ flow, url: args.url, logPath, screenshotDir: evidenceDir });
    else await runAndroidFlow({ flow, appId: args.appId, apkPath: undefined, serial: args.serial, logPath, screenshotDir: evidenceDir });
  } catch (error) {
    fs.writeFileSync(logPath, `OCQA_FLOW_RESULT:${JSON.stringify({ passed: false, total: flow.steps.length, failed: 1, error: error.message || String(error) })}\n`);
  }
        flowLogs.push({ kind: "flow", path: logPath });
      }
      for (const { scenarioPath, scenario } of selectedScenarios) {
  const logPath = path.join(os.tmpdir(), `tapp-ci-scenario-${path.basename(scenarioPath).replace(/\.ya?ml$/i, "")}-${Date.now()}.log`);
  const evidenceDir = path.join(captureDir, "scenarios", path.basename(scenarioPath).replace(/\.ya?ml$/i, ""));
  try {
    await runWebScenario({ scenario, url: args.url, logPath, screenshotDir: evidenceDir });
  } catch (error) {
    fs.writeFileSync(logPath, `OCQA_FLOW_RESULT:${JSON.stringify({ passed: false, name: scenario.name, kind: "scenario", total: scenario.steps.length, executed: 0, failed: 1, error: error.message || String(error) })}\n`);
  }
        flowLogs.push({ kind: "scenario", path: logPath });
      }
      for (const { contractPath, contract, execution } of selectedContracts) {
  const stem = path.basename(contractPath).replace(/\.contract\.(?:ts|mts|mjs|js|json)$/i, "");
  const logPath = path.join(os.tmpdir(), `tapp-ci-contract-${stem}-${Date.now()}.log`);
  const evidenceDir = path.join(captureDir, "contracts", stem);
  try {
    if (execution.kind === "scenario") await runWebScenario({ scenario: execution, url: args.url, logPath, screenshotDir: evidenceDir });
    else if (args.platform === "web") await runWebFlow({ flow: execution, url: args.url, logPath, screenshotDir: evidenceDir });
    else await runAndroidFlow({ flow: execution, appId: args.appId, apkPath: undefined, serial: args.serial, logPath, screenshotDir: evidenceDir });
  } catch (error) {
    fs.writeFileSync(logPath, `OCQA_FLOW_RESULT:${JSON.stringify({ passed: false, name: contract.title, kind: "release-contract", contract: contract.name, criticality: contract.criticality, total: execution.steps.length, executed: 0, failed: 1, error: error.message || String(error) })}\n`);
  }
        flowLogs.push({ kind: "contract", path: logPath });
      }

      const reportArgs = [path.join(root, "mcp-server", "src", "ci-report.js"), "--markers", markers, "--platform", args.platform,
        "--fail-on", args.failOn, "--html-dir", captureDir, "--label", args.url || args.appId];
      if (args.targetKey) reportArgs.push("--target-key", args.targetKey);
      if (args.baseline) reportArgs.push("--baseline", args.baseline);
      if (args.jsonOut) reportArgs.push("--json-out", args.jsonOut);
      if (args.mdOut) reportArgs.push("--md-out", args.mdOut);
      if (args.prPlan) reportArgs.push("--pr-plan", args.prPlan);
      if (args.prPlan && args.platform === "web" && args.projectDir) {
        reportArgs.push("--project-dir", args.projectDir, "--maintenance-url", args.url);
      }
      for (const log of flowLogs) reportArgs.push(log.kind === "contract" ? "--contract-log" : log.kind === "scenario" ? "--scenario-log" : "--flow-log", log.path);
      const report = spawnSync(process.execPath, reportArgs, { stdio: "inherit" });
      exitCode = report.status ?? 1;
    }
  }
} finally {
  if (managedRuntime) {
    await stopManagedWebTarget(managedRuntime);
    console.error("🧹 Managed web target stopped.");
  }
}
process.exit(exitCode);

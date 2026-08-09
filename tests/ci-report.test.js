// Process-level tests for the actual CI contract: markdown/report artifacts and exit codes.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateWebMaintenanceProposal } from "../mcp-server/src/maintenance-proposal.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportBin = path.join(root, "mcp-server", "src", "ci-report.js");
const cleanMarkers = [
  'OCQA_STATE:{"screen":"Home","elements":30}',
  'OCQA_ACTION:{"type":"tap","target":"Settings"}',
  'OCQA_ACTION:{"type":"tap","target":"Profile"}',
  'OCQA_ACTION:{"type":"tap","target":"Back"}',
  'OCQA_STATE:{"screen":"Settings","elements":20}',
  'OCQA_COMPLETE:{"actions":3,"states":2,"issues":0,"screens":"Home,Settings"}',
];

function runGate({ markers = cleanMarkers, baseline, flowLog, scenarioLog, contractLog, prPlan, platform, targetKey, projectDir } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-ci-report-"));
  const markersPath = path.join(dir, "markers.txt");
  const jsonPath = path.join(dir, "report.json");
  const mdPath = path.join(dir, "report.md");
  fs.writeFileSync(markersPath, markers.join("\n") + "\n");
  const htmlPath = path.join(dir, "report.html");
  const args = [reportBin, "--markers", markersPath, "--json-out", jsonPath, "--md-out", mdPath, "--html-dir", dir, "--label", "fixture"];
  if (platform) args.push("--platform", platform);
  if (targetKey) args.push("--target-key", targetKey);
  if (projectDir) args.push("--project-dir", projectDir);
  if (baseline !== undefined) {
    const baselinePath = path.join(dir, "baseline.json");
    fs.writeFileSync(baselinePath, JSON.stringify(baseline));
    args.push("--baseline", baselinePath);
  }
  if (flowLog !== undefined) {
    const flowPath = path.join(dir, "smoke.log");
    fs.writeFileSync(flowPath, flowLog);
    args.push("--flow-log", flowPath);
  }
  if (scenarioLog !== undefined) {
    const scenarioPath = path.join(dir, "social.log");
    fs.writeFileSync(scenarioPath, scenarioLog);
    args.push("--scenario-log", scenarioPath);
  }
  if (contractLog !== undefined) {
    const contractPath = path.join(dir, "contract.log");
    fs.writeFileSync(contractPath, contractLog);
    args.push("--contract-log", contractPath);
  }
  let prPlanPath;
  if (prPlan !== undefined) {
    prPlanPath = path.join(dir, "pr-plan.json");
    fs.writeFileSync(prPlanPath, JSON.stringify(prPlan));
    args.push("--pr-plan", prPlanPath);
  }
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  return {
    ...result,
    report: fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, "utf8")) : null,
    markdown: fs.existsSync(mdPath) ? fs.readFileSync(mdPath, "utf8") : "",
    html: fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, "utf8") : "",
    prPlan: prPlanPath && fs.existsSync(prPlanPath) ? JSON.parse(fs.readFileSync(prPlanPath, "utf8")) : null,
  };
}

function planFor(name = "socialSystemWorks") {
  return {
    schemaVersion: 1,
    platform: "web",
    changedFiles: ["src/feed.ts"],
    selected: [{ name, title: name, criticality: "critical", path: `.tapp/contracts/${name}.contract.ts`, tasks: ["observePost"], taskPaths: [".tapp/tasks/observe-post.yml"], reasons: [{ type: "task-source", task: "observePost", files: ["src/feed.ts"] }] }],
    skipped: [],
    impactedUiMap: { nodes: ["screen_feed"], edges: [] },
    uncoveredUiMap: { nodes: [], edges: [] },
    uncoveredChangedFiles: [],
    maintenanceCandidates: [{ contract: name, tasks: ["observePost"], taskPaths: [".tapp/tasks/observe-post.yml"], changedFiles: ["src/feed.ts"], reason: "Task implementation or its owned UI surface changed", nextAction: "Replay first" }],
    policy: {},
  };
}

test("disposable maintenance validation rejects stale digests before touching the source checkout", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-maintenance-digest-"));
  const taskPath = path.join(project, ".tapp", "tasks", "open-home.yml");
  const contractPath = path.join(project, ".tapp", "contracts", "home.contract.ts");
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(taskPath, "kind: task\nversion: 1\nname: openHome\nsteps:\n  - tap: Home\n");
  fs.writeFileSync(contractPath, "unchanged contract intent\n");
  const before = fs.readFileSync(taskPath, "utf8");
  await assert.rejects(validateWebMaintenanceProposal({
    projectDir: project,
    url: "http://127.0.0.1:1",
    proposal: {
      kind: "task-maintenance-patch",
      contractIntent: { name: "homeWorks", path: ".tapp/contracts/home.contract.ts", sha256: "stale-contract" },
      operations: [{ op: "replace", taskPath: ".tapp/tasks/open-home.yml", taskSha256: "stale-task", pointer: "/steps/0/tap", before: "Home", after: "home" }],
    },
  }), /Task digest changed/);
  assert.equal(fs.readFileSync(taskPath, "utf8"), before);
});

test("automatic maintenance replay refuses a stateful contract without controlled lifecycle", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-maintenance-lifecycle-"));
  const taskPath = path.join(project, ".tapp", "tasks", "open-home.yml");
  const contractPath = path.join(project, ".tapp", "contracts", "home.contract.ts");
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(taskPath, "kind: task\nversion: 1\nname: openHome\nsteps:\n  - tap: Home\n");
  fs.writeFileSync(contractPath, `import { defineContract } from "@aarwitz/tapp/contracts";
export default defineContract({name:"homeWorks",title:"Home works",businessValue:"navigation",criticality:"high",platforms:["web"],actors:{customer:{}},steps:[{actor:"customer",task:"openHome"}]});\n`);
  const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const before = fs.readFileSync(taskPath, "utf8");
  await assert.rejects(validateWebMaintenanceProposal({
    projectDir: project,
    url: "http://127.0.0.1:1",
    proposal: {
      kind: "task-maintenance-patch",
      contractIntent: { name: "homeWorks", path: ".tapp/contracts/home.contract.ts", sha256: hash(contractPath) },
      operations: [{ op: "replace", taskPath: ".tapp/tasks/open-home.yml", taskSha256: hash(taskPath), pointer: "/steps/0/tap", before: "Home", after: "home" }],
    },
  }), /requires controlled contract setup and teardown/);
  assert.equal(fs.readFileSync(taskPath, "utf8"), before);
});

test("first run passes clean evidence but states that regression gating is not active", () => {
  const r = runGate();
  assert.equal(r.status, 0, `${r.stderr}\n${JSON.stringify(r.report?.gate)}`);
  assert.equal(r.report.gate.failed, false);
  assert.match(r.markdown, /Baseline — .*not active yet/);
  assert.match(r.markdown, /blocked\/inconclusive fallback/);
  assert.match(r.html, /release score 100\/100/);
  assert.match(r.html, /fixture/);
});

test("new high finding against a baseline exits non-zero and writes both artifacts", () => {
  const current = [
    ...cleanMarkers.slice(0, -1),
    'OCQA_ISSUE:{"type":"error_message","severity":"high","title":"Save failed","screen":"Settings"}',
    'OCQA_COMPLETE:{"actions":3,"states":2,"issues":1,"screens":"Home,Settings"}',
  ];
  const r = runGate({ baseline: { findings: [], inconclusive: false }, markers: current });
  assert.equal(r.status, 1);
  assert.equal(r.report.regression.gate.newHigh, 1);
  assert.equal(r.report.gate.failed, true);
  assert.match(r.markdown, /regression gate FAILED/);
  assert.match(r.markdown, /Gate \(gate\): .*FAIL/);
});

test("target-scoped baselines reject cross-platform or cross-target comparisons", () => {
  const scoped = {
    ...runGate().report,
    baselineIdentity: { schemaVersion: 1, platform: "web", targetId: "target_web_store" },
  };
  const wrongPlatform = runGate({ baseline: scoped, platform: "ios", targetKey: "target_web_store" });
  assert.equal(wrongPlatform.status, 2);
  assert.match(wrongPlatform.stderr, /platform 'web'.*platform 'ios'/);
  const wrongTarget = runGate({ baseline: scoped, platform: "web", targetKey: "target_web_admin" });
  assert.equal(wrongTarget.status, 2);
  assert.match(wrongTarget.stderr, /target 'target_web_store'.*target 'target_web_admin'/);
  const matching = runGate({ baseline: scoped, platform: "web", targetKey: "target_web_store" });
  assert.equal(matching.status, 0, matching.stderr);
  assert.equal(matching.report.targetKey, "target_web_store");
});

test("a failed Flow blocks an otherwise clean run", () => {
  const flowLog = [
    'OCQA_FLOW_STEP:{"status":"fail","action":"assert_screen","target":"Checkout","detail":"screen not reached"}',
    'OCQA_FLOW_RESULT:{"name":"checkout","passed":false,"total":1,"failed":1}',
  ].join("\n");
  const r = runGate({ baseline: { findings: [], inconclusive: false }, flowLog });
  assert.equal(r.status, 1);
  assert.equal(r.report.flows[0].passed, false);
  assert.deepEqual(r.report.gate.reasons, ["1 flow(s) failed"]);
  assert.match(r.markdown, /checkout.*failed at/);
});

test("a failed multi-actor Scenario names the actor and blocks the gate", () => {
  const scenarioLog = [
    'OCQA_FLOW_STEP:{"status":"pass","action":"request","target":"POST /reset","actor":"setup"}',
    'OCQA_FLOW_STEP:{"status":"fail","action":"assert_exists","target":"shared post","detail":"not found","actor":"bob"}',
    'OCQA_FLOW_RESULT:{"name":"social system","kind":"scenario","passed":false,"total":12,"executed":2,"failed":1}',
  ].join("\n");
  const r = runGate({ baseline: { findings: [], inconclusive: false }, scenarioLog });
  assert.equal(r.status, 1);
  assert.equal(r.report.scenarios[0].kind, "scenario");
  assert.deepEqual(r.report.gate.reasons, ["1 multi-actor scenario(s) failed"]);
  assert.match(r.markdown, /Multi-actor Scenarios/);
  assert.match(r.markdown, /failed for \*\*bob\*\*/);
});

test("a failed release contract is first-class, names its Task and actor, and blocks the gate", () => {
  const contractLog = [
    'OCQA_FLOW_STEP:{"index":1,"action":"assert_exists","target":"shared post","status":"fail","detail":"not found","actor":"bob","task":"observePost","contract":"socialSystemWorks"}',
    'OCQA_FLOW_RESULT:{"name":"Social system works","kind":"release-contract","contract":"socialSystemWorks","criticality":"critical","passed":false,"total":20,"executed":1,"failed":1}',
  ].join("\n");
  const r = runGate({ baseline: { findings: [], inconclusive: false }, contractLog });
  assert.equal(r.status, 1);
  assert.equal(r.report.contracts[0].contract, "socialSystemWorks");
  assert.equal(r.report.contracts[0].criticality, "critical");
  assert.deepEqual(r.report.gate.reasons, ["1 release contract(s) failed"]);
  assert.match(r.markdown, /Task `observePost`/);
  assert.match(r.markdown, /for \*\*bob\*\*/);
});

test("PR selection is joined to replay evidence and emits a constrained maintenance candidate", () => {
  const contractLog = [
    'OCQA_FLOW_STEP:{"index":1,"action":"assert_exists","target":"shared post","status":"fail","detail":"not found","actor":"bob","task":"observePost","contract":"socialSystemWorks"}',
    'OCQA_FLOW_RESULT:{"name":"Social system works","kind":"release-contract","contract":"socialSystemWorks","criticality":"critical","passed":false,"total":20,"executed":1,"failed":1}',
  ].join("\n");
  const r = runGate({ baseline: { findings: [], inconclusive: false }, contractLog, prPlan: planFor() });
  assert.equal(r.status, 1);
  assert.equal(r.report.prPlan.selected[0].execution.status, "failed");
  assert.equal(r.report.prPlan.maintenanceCandidates[0].disposition, "review-required");
  assert.deepEqual(r.report.prPlan.maintenanceCandidates[0].proposal.editablePaths, [".tapp/tasks/observe-post.yml"]);
  assert.deepEqual(r.report.prPlan.maintenanceCandidates[0].proposal.preservedIntent, ["socialSystemWorks"]);
  assert.match(r.markdown, /PR release plan/);
  assert.match(r.markdown, /existing contract remains failed and unchanged/);
  assert.equal(r.prPlan.execution.failed, 1);
});

test("a failed selector with stable map identity produces one unvalidated Task-only patch", () => {
  const markers = [
    'OCQA_STATE:{"screen":"Feed","role":"screen","elements":3,"controls":[{"kind":"button","label":"Post","id":"publish","cssId":"publish"}]}',
    'OCQA_ACTION:{"type":"tap","target":"Post","screen":"Feed"}',
    'OCQA_STATE:{"screen":"Messages","role":"screen","elements":2,"controls":[]}',
    'OCQA_COMPLETE:{"actions":3,"states":2,"issues":0,"screens":"Feed,Messages"}',
  ];
  const contractLog = [
    'OCQA_FLOW_STEP:{"index":1,"action":"tap","target":"Publish","status":"fail","detail":"could not find ‘Publish’","task":"createPost","contract":"socialSystemWorks"}',
    'OCQA_FLOW_RESULT:{"name":"Social system works","kind":"release-contract","contract":"socialSystemWorks","criticality":"critical","passed":false,"total":20,"executed":1,"failed":1}',
  ].join("\n");
  const plan = planFor();
  plan.selected[0].tasks = ["createPost"];
  plan.selected[0].taskPaths = [".tapp/tasks/create-post.yml"];
  plan.maintenanceCandidates[0] = {
    contract: "socialSystemWorks",
    contractPath: ".tapp/contracts/social-system.contract.ts",
    contractIntentSha256: "contract-digest",
    tasks: ["createPost"],
    taskPaths: [".tapp/tasks/create-post.yml"],
    changedFiles: ["src/feed.ts"],
    selectorReferences: [{
      task: "createPost", taskPath: ".tapp/tasks/create-post.yml", taskSha256: "task-digest",
      platform: "web", action: "tap", target: "Publish", pointer: "/implementations/web/steps/1/tap",
      baselineControls: [{
        nodeId: "old-feed-id", nodeSemanticKey: "feed", nodeName: "Feed", controlId: "old-publish",
        label: "Publish", selectors: [{ kind: "cssId", value: "publish" }, { kind: "label", value: "Publish" }],
      }],
    }],
    reason: "Task surface changed", nextAction: "Replay first",
  };
  const r = runGate({ markers, baseline: { findings: [], inconclusive: false }, contractLog, prPlan: plan, platform: "web" });
  assert.equal(r.status, 1, "a maintenance proposal never converts the current failure into a pass");
  const proposal = r.report.prPlan.maintenanceCandidates[0].proposal;
  assert.equal(proposal.kind, "task-maintenance-patch");
  assert.equal(proposal.status, "proposed-unvalidated");
  assert.equal(proposal.autoApply, false);
  assert.deepEqual(proposal.contractIntent, { name: "socialSystemWorks", path: ".tapp/contracts/social-system.contract.ts", sha256: "contract-digest" });
  assert.deepEqual(proposal.operations[0], {
    op: "replace",
    task: "createPost",
    taskPath: ".tapp/tasks/create-post.yml",
    taskSha256: "task-digest",
    pointer: "/implementations/web/steps/1/tap",
    before: "Publish",
    after: "publish",
    selector: { kind: "cssId", value: "publish" },
    evidence: {
      nodeId: proposal.operations[0].evidence.nodeId,
      nodeSemanticKey: "feed",
      baselineLabel: "Publish",
      currentLabel: "Post",
      baselineControlId: "old-publish",
      currentControlId: proposal.operations[0].evidence.currentControlId,
    },
  });
  assert.match(r.markdown, /`Publish` → `publish` \(cssId\); unvalidated and never auto-applied/);
  assert.equal(r.report.gate.reasons.includes("1 release contract(s) failed"), true);
});

test("a selected release contract that did not execute blocks the merge", () => {
  const r = runGate({ baseline: { findings: [], inconclusive: false }, prPlan: planFor("mustRun") });
  assert.equal(r.status, 1);
  assert.deepEqual(r.report.gate.reasons, ["1 selected release contract(s) did not run"]);
  assert.equal(r.report.prPlan.selected[0].execution.status, "not-run");
});

test("observed bounded PR exploration records control evidence and emits a review-only coverage proposal", () => {
  const markers = [
    'OCQA_ACTION:{"type":"open","target":"/","via":"/"}',
    'OCQA_STATE:{"screen":"Home","url":"/","role":"screen","elements":1,"controls":[{"kind":"link","label":"Pricing","id":"pricing-link"}]}',
    'OCQA_ACTION:{"type":"open","target":"/pricing.html","via":"PR target /pricing.html"}',
    'OCQA_STATE:{"screen":"Pricing","url":"/pricing.html","role":"screen","elements":2,"controls":[{"kind":"button","label":"Start plan","id":"start-plan"},{"kind":"link","label":"Home","id":"home-link"}]}',
    'OCQA_PR_TARGET:{"route":"/pricing.html","status":"observed","screen":"Pricing"}',
    'OCQA_ACTION:{"type":"tap","target":"Start plan","screen":"Pricing"}',
    'OCQA_COMPLETE:{"actions":3,"states":2,"issues":0,"screens":"Home,Pricing"}',
  ];
  const plan = planFor("mustRun");
  plan.selected = [];
  plan.maintenanceCandidates = [];
  plan.uncoveredUiMap.nodes = ["screen_pricing"];
  plan.explorationTargets = [{
    id: "explore_pricing", platform: "web", status: "planned",
    node: { id: "screen_pricing", semanticKey: "pricing", name: "Pricing" },
    changedFiles: ["pricing.html"],
    navigation: { status: "replayable", route: "/pricing.html", provenance: "observed-ui-map" },
    baselineControls: [{ id: "old-start", semanticKey: "start", kind: "button", label: "Start", selectors: [{ kind: "label", value: "Start" }] }],
    coverage: { status: "not-covered-by-selected-contract", tasks: [], contracts: [] },
  }];
  const r = runGate({ markers, baseline: { findings: [], inconclusive: false }, prPlan: plan, platform: "web" });
  assert.equal(r.status, 0, r.stderr);
  const target = r.report.prPlan.explorationTargets[0];
  assert.equal(target.execution.status, "observed");
  assert.equal(target.execution.conclusive, true);
  assert.equal(target.execution.controls.notObserved[0].label, "Start");
  assert.equal(target.execution.controls.added.some((control) => control.label === "Start plan"), true);
  assert.equal(target.coverageProposal.kind, "release-plan-item-proposal");
  assert.equal(target.coverageProposal.autoApply, false);
  assert.equal(target.coverageProposal.operation.item.origin, "deterministic-ui-map-proposal");
  assert.equal(target.coverageProposal.operation.item.decision, "pending");
  assert.equal(target.coverageProposal.operation.item.groundedBy.some((item) => item.type === "pr-exploration"), true);
  assert.match(r.markdown, /Reviewable coverage proposal ready; never auto-applied/);
});

test("a planned replayable PR exploration target that was not reached blocks the gate as inconclusive", () => {
  const plan = planFor("mustRun");
  plan.selected = [];
  plan.maintenanceCandidates = [];
  plan.explorationTargets = [{
    id: "explore_pricing", platform: "web", status: "planned",
    node: { id: "screen_pricing", semanticKey: "pricing", name: "Pricing" },
    changedFiles: ["pricing.html"], navigation: { status: "replayable", route: "/pricing.html" },
    baselineControls: [], coverage: { status: "not-covered-by-selected-contract" },
  }];
  const r = runGate({ baseline: { findings: [], inconclusive: false }, prPlan: plan, platform: "web" });
  assert.equal(r.status, 1);
  assert.equal(r.report.prPlan.explorationTargets[0].execution.status, "not-reached");
  assert.deepEqual(r.report.gate.reasons, ["1 planned PR exploration target(s) failed or were not reached"]);
});

test("native UI Map path evidence is joined by target identity rather than a web route", () => {
  const markers = [
    'OCQA_NAVIGATION_ROOT:{"screen":"Home","role":"screen","controls":[{"kind":"button","label":"Settings","identifier":"settings_button"}]}',
    'OCQA_STATE:{"screen":"Home","role":"screen","elements":1,"controls":[{"kind":"button","label":"Settings","identifier":"settings_button"}]}',
    'OCQA_ACTION:{"type":"tap","target":"Settings","screen":"Home","reason":"pr_ui_map_path"}',
    'OCQA_TRANSITION_RESOLVED:{"from":"Home","to":"Settings","action":"Settings"}',
    'OCQA_STATE:{"screen":"Settings","role":"settings","elements":1,"controls":[{"kind":"toggle","label":"Notifications"}]}',
    'OCQA_PR_TARGET:{"targetId":"explore_settings","status":"observed","screen":"Settings"}',
    'OCQA_ACTION:{"type":"tap","target":"Notifications","screen":"Settings"}',
    'OCQA_ACTION:{"type":"tap","target":"Back","screen":"Settings"}',
    'OCQA_COMPLETE:{"actions":3,"states":2,"issues":0,"screens":"Home,Settings"}',
  ];
  const plan = planFor();
  plan.platform = "ios";
  plan.selected = [];
  plan.maintenanceCandidates = [];
  plan.uncoveredUiMap.nodes = ["screen_settings"];
  plan.explorationTargets = [{
    id: "explore_settings", platform: "ios", status: "planned",
    node: { id: "screen_settings", semanticKey: "settings", name: "Settings" },
    changedFiles: ["Sources/SettingsView.swift"],
    navigation: { status: "replayable", mode: "ui-map-path", entryNodeId: "screen_home", targetNodeId: "screen_settings", steps: [{ edgeId: "edge_settings", action: { type: "tap", target: "Settings" } }] },
    baselineControls: [], coverage: { status: "not-covered-by-selected-contract", tasks: [], contracts: [] },
  }];
  const r = runGate({ markers, baseline: { findings: [], inconclusive: false }, prPlan: plan, platform: "ios" });
  assert.equal(r.status, 0, `${r.stderr}\n${JSON.stringify(r.report?.gate)}`);
  const target = r.report.prPlan.explorationTargets[0];
  assert.equal(target.execution.status, "observed");
  assert.deepEqual(target.execution.navigation, { mode: "ui-map-path", edgeIds: ["edge_settings"] });
  assert.equal(target.coverageProposal.operation.item.groundedBy.find((item) => item.type === "pr-exploration").navigationMode, "ui-map-path");
  assert.match(r.markdown, /through 1 observed map edge/);
});

test("observed PR exploration preserves an existing human release-plan decision instead of proposing a duplicate", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-ci-existing-plan-"));
  fs.mkdirSync(path.join(project, ".tapp"), { recursive: true });
  fs.writeFileSync(path.join(project, ".tapp", "release-plan.json"), JSON.stringify({
    schemaVersion: 1, kind: "tapp-release-plan", items: [{
      id: "proposal_pricing", name: "pricingReachable", decision: "deferred", origin: "deterministic-ui-map-proposal",
      groundedBy: [{ type: "ui-map-node", id: "screen_pricing" }],
    }],
  }));
  const markers = [
    'OCQA_STATE:{"screen":"Home","url":"/","elements":1}',
    'OCQA_ACTION:{"type":"open","target":"/pricing.html"}',
    'OCQA_STATE:{"screen":"Pricing","url":"/pricing.html","elements":2,"controls":[{"kind":"button","label":"Start plan"}]}',
    'OCQA_PR_TARGET:{"route":"/pricing.html","status":"observed","screen":"Pricing"}',
    'OCQA_ACTION:{"type":"tap","target":"Start plan"}',
    'OCQA_COMPLETE:{"actions":3,"states":2,"issues":0}',
  ];
  const plan = planFor();
  plan.selected = [];
  plan.maintenanceCandidates = [];
  plan.explorationTargets = [{
    id: "explore_pricing", platform: "web", status: "planned",
    node: { id: "screen_pricing", semanticKey: "pricing", name: "Pricing" }, changedFiles: ["pricing.html"],
    navigation: { status: "replayable", route: "/pricing.html" }, baselineControls: [],
    coverage: { status: "not-covered-by-selected-contract" },
  }];
  const r = runGate({ markers, baseline: { findings: [], inconclusive: false }, prPlan: plan, platform: "web", projectDir: project });
  const target = r.report.prPlan.explorationTargets[0];
  assert.equal(target.coverageProposal.status, "matches-existing-release-plan");
  assert.equal(target.coverageProposal.operation.op, "reconcile-item");
  assert.deepEqual(target.existingReleasePlanItem, {
    path: ".tapp/release-plan.json", id: "proposal_pricing", name: "pricingReachable", decision: "deferred", origin: "deterministic-ui-map-proposal",
    detail: "The repository release plan already records this grounded UI Map coverage decision; Tapp preserved it instead of proposing a duplicate.",
  });
  assert.match(r.markdown, /remains deferred; no duplicate or decision change was made/);
  assert.match(r.markdown, /Optional explicit evidence reconciliation/);
});

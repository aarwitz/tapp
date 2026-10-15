// One portable workflow definition above existing Flows, contracts and backend hooks.
// Discovery proposes scope; only recorded execution can supply observations.
import { createHash } from "node:crypto";

export const BUSINESS_WORKFLOW_PATH = ".tapp/business-workflows.json";
const idPattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/;
const flowPattern = /^\.tapp\/flows\/[a-zA-Z0-9_-]+\.(yml|yaml|json)$/;
const object = value => value && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 1000) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
export function workflowFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function emptyBusinessWorkflows() {
  return { kind: "tapp-business-workflows", schemaVersion: 1, revision: 0, description: "", workflows: [] };
}
export function validateBusinessWorkflows(document) {
  const errors = [];
  if (!object(document)) return ["Workflow map must be an object"];
  if (document.kind !== "tapp-business-workflows" || document.schemaVersion !== 1) errors.push("Unsupported workflow map format");
  if (!Number.isSafeInteger(document.revision) || document.revision < 0) errors.push("Invalid map revision");
  if (typeof document.description !== "string" || document.description.length > 2000) errors.push("Business description must be at most 2000 characters");
  if (!Array.isArray(document.workflows) || document.workflows.length > 30) return [...errors, "Use at most 30 workflows"];
  const ids = new Set();
  for (const workflow of document.workflows) {
    if (!object(workflow)) { errors.push("Invalid workflow"); continue; }
    if (!text(workflow.id,80) || !idPattern.test(workflow.id) || ids.has(workflow.id)) errors.push("Workflow IDs must be unique names");
    ids.add(workflow.id);
    if (!text(workflow.title, 160) || !text(workflow.outcome)) errors.push(`${workflow.id}: describe the workflow and expected business outcome`);
    if (!["critical", "high", "normal"].includes(workflow.priority)) errors.push(`${workflow.id}: invalid priority`);
    if (!["proposed", "confirmed", "deferred"].includes(workflow.decision)) errors.push(`${workflow.id}: invalid review decision`);
    if (!Array.isArray(workflow.steps) || !workflow.steps.length || workflow.steps.length > 20) { errors.push(`${workflow.id}: use 1–20 steps`); continue; }
    const steps = new Set();
    for (const step of workflow.steps) {
      if (!object(step)) { errors.push(`${workflow.id}: invalid step`); continue; }
      if (!text(step.id,80) || !idPattern.test(step.id) || steps.has(step.id)) errors.push(`${workflow.id}: step IDs must be unique names`);
      steps.add(step.id);
      if (!text(step.title, 160) || !text(step.outcome)) errors.push(`${workflow.id}/${step.id}: describe the step and expected outcome`);
      if (!["flow", "capability", "contract", "manual"].includes(step.kind)) errors.push(`${step.id}: invalid proof type`);
      if (step.kind !== "manual" && !text(step.ref, 500)) errors.push(`${step.id}: select a proof reference`);
      if (step.kind === "flow" && !flowPattern.test(step.ref)) errors.push(`${step.id}: select a saved .tapp/flows artifact`);
      if (step.actor !== undefined && !idPattern.test(step.actor)) errors.push(`${step.id}: invalid account name`);
      if (step.targetId !== undefined && !text(step.targetId, 300)) errors.push(`${step.id}: invalid target`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(document)) > 64000) errors.push("Workflow map must be 64 KB or smaller");
  return errors;
}

// Copy only declarative fields. Caller-provided evidence, verification status and
// approval metadata can never be smuggled into a persisted definition.
export function normalizeBusinessWorkflows(document) {
  const errors = validateBusinessWorkflows(document);
  if (errors.length) throw new Error(errors.join("; "));
  return { kind: "tapp-business-workflows", schemaVersion: 1, revision: document.revision,
    description: document.description.trim(), workflows: document.workflows.map(workflow => ({
      id: workflow.id, title: workflow.title.trim(), outcome: workflow.outcome.trim(), priority: workflow.priority,
      decision: workflow.decision,
      steps: workflow.steps.map(step => ({ id: step.id, title: step.title.trim(), outcome: step.outcome.trim(), kind: step.kind,
        ...(step.ref ? { ref: step.ref } : {}), ...(step.actor ? { actor: step.actor } : {}), ...(step.targetId ? { targetId: step.targetId } : {}) })),
    })) };
}

export function discoverBusinessWorkflows(project = {}, connection = {}) {
  const targets = project.targets || [];
  const sole = targets.length === 1 ? targets[0] : null;
  const flows = project.flows || [];
  const contracts = project.model?.artifacts?.contracts || [];
  const actors = connection.actors || project.actors || [];
  const capabilities = connection.capabilities || [];
  const surfaces = (project.map?.nodes || []).slice(0, 100).map(node => ({ id: String(node.id), name: String(node.stateLabel || node.name || "Observed screen"), basis: "runtime-observed" }));
  const proposals = [];
  for (const contract of contracts.slice(0, 15)) proposals.push({
    id: `journey_${workflowFingerprint(contract.path).slice(0, 16)}`, title: contract.name,
    outcome: (project.model?.criticalJourneys || []).find(journey => journey.contract === contract.name)?.businessValue || `Check the assertions in ${contract.name}`,
    priority: "high", decision: "proposed",
    steps: [{ id: "contract", title: contract.name, outcome: "The existing reviewed contract's assertions hold on the selected target.", kind: "contract", ref: contract.path }],
  });
  for (const flow of flows.slice(0, 15)) proposals.push({
    id: `journey_${workflowFingerprint(flow.path).slice(0, 16)}`, title: flow.name || flow.path,
    outcome: "Confirm which business outcome this recorded flow is intended to protect.", priority: "normal", decision: "proposed",
    steps: [{ id: "flow", title: flow.name || "Recorded flow", outcome: "The recorded flow's explicit assertions hold.", kind: "flow", ref: flow.path,
      ...(sole ? { targetId: sole.id } : {}) }],
  });
  for (const surface of surfaces.slice(0, Math.max(0, 30 - proposals.length))) proposals.push({
    id: `surface_${workflowFingerprint(surface.id).slice(0, 16)}`, title: `Check ${surface.name}`.slice(0,160),
    outcome: "Confirm the business outcome and relevant failure cases for this observed surface.", priority: "normal", decision: "proposed",
    steps: [{ id: "outcome", title: surface.name.slice(0,160), outcome: "Define what must happen here and how to observe the result.", kind: "manual" }],
  });
  return { targets, actors, flows, contracts, capabilities, surfaces, proposals,
    questions: ["What outcome matters most to your business?", "Who takes part, and what should each person see?", "What must happen after submission, including failures or cancellation?"],
    scope: "Proposals come from available artifacts and observed screens. They are not a complete inventory of your business; confirm omitted systems, roles and exception paths." };
}

export function planBusinessWorkflow(document, workflowId, project = {}, connection = {}) {
  const map = normalizeBusinessWorkflows(document);
  const workflow = map.workflows.find(item => item.id === workflowId);
  if (!workflow) throw new Error("Workflow not found");
  const inventory = discoverBusinessWorkflows(project, connection);
  const blockers = [];
  if (workflow.decision !== "confirmed") blockers.push({ code: "review-required", message: "Confirm the workflow's outcomes and steps before running it." });
  if (connection.environment !== "test") blockers.push({ code: "test-environment-required", message: "Select a suitable test environment in app connections before automatic workflow execution. The label alone does not create a sandbox." });
  let lastPhase = -1;
  const steps = workflow.steps.map(step => {
    const missing = [];
    let phase = "exercise";
    let sha256;
    let target;
    if (step.kind === "manual") missing.push("Record a flow, connect a verifier, or attach an existing contract for this outcome.");
    if (step.kind === "contract") {
      if (!inventory.contracts.some(item => item.path === step.ref)) missing.push("The referenced contract is unavailable.");
      missing.push("Run this contract through the existing repository release gate; automatic business workflow execution currently supports web Flows and backend capabilities.");
    }
    if (step.kind === "flow") {
      const flow = inventory.flows.find(item => item.path === step.ref);
      sha256 = flow?.sha256;
      if (!flow) missing.push("Record or import this flow first.");
      if (!/^[a-f0-9]{64}$/.test(sha256 || "")) missing.push("Refresh project inspection to fingerprint this saved flow.");
      target = inventory.targets.find(item => item.id === step.targetId);
      if (!target) missing.push("Choose an available application target.");
      else if (target.platform !== "web" || (flow?.platform && flow.platform !== "web")) missing.push("Automatic business workflow execution currently requires a web target; native flows remain available through their existing tools.");
      if (!step.actor) missing.push("Choose the account for this step, or explicitly choose public access.");
      else if (step.actor !== "public" && !inventory.actors.some(actor => actor.name === step.actor && actor.status === "configured")) missing.push(`Connect the ${step.actor} account needed for this step.`);
    }
    if (step.kind === "capability") {
      const capability = inventory.capabilities.find(item => item.name === step.ref);
      phase = capability?.phase || "verify";
      if (!capability || capability.status !== "configured") missing.push(`Connect the ${step.ref} backend capability.`);
    }
    const phaseOrder = { prepare: 0, exercise: 1, verify: 2, cleanup: 3 }[phase];
    if (phaseOrder === undefined || phaseOrder < lastPhase) missing.push("Order steps as preparation, app activity, backend verification, then cleanup.");
    lastPhase = phaseOrder ?? lastPhase;
    for (const message of missing) blockers.push({ code: "step-setup-required", stepId: step.id, message });
    return { ...step, phase, ...(sha256 ? { sha256 } : {}), ...(target ? { platform: target.platform } : {}), missing };
  });
  const hasBackendVerification = steps.some(step => step.kind === "capability" && step.phase === "verify");
  if (!steps.some(step => step.kind === "flow" || (step.kind === "capability" && step.phase === "verify"))) {
    blockers.push({code:"verification-required",message:"Include an app flow or backend verification; setup acknowledgements alone cannot check a workflow."});
  }
  if (steps.some(step => step.kind === "capability" && step.phase === "prepare") && !steps.some(step => step.kind === "capability" && step.phase === "cleanup")) {
    blockers.push({ code: "cleanup-required", message: "Add a cleanup capability for the prepared test data." });
  }
  const bindingFingerprint = workflowFingerprint({ workflow, targets: inventory.targets, flows: inventory.flows,
    configuration: connection.configuration || {}, accessRevision:connection.accessRevision || "", actors: inventory.actors, capabilities: inventory.capabilities });
  return { kind: "tapp-business-workflow-plan", workflowId, revision: map.revision, title: workflow.title,
    outcome: workflow.outcome, bindingFingerprint, ready: !blockers.length, steps, blockers,
    correlationVariable: "TEST_RUN_ID", requiresCorrelation: hasBackendVerification,
    scope: "Runs only the confirmed steps and their explicit assertions. Success is an observation of those checks, not a release verdict or proof of complete business coverage." };
}

export function businessWorkflowCoverage(document, project = {}, connection = {}, runs = []) {
  const map = normalizeBusinessWorkflows(document);
  const workflows = map.workflows.map(workflow => {
    const plan = planBusinessWorkflow(map, workflow.id, project, connection);
    const run = runs.find(item => item.workflowId === workflow.id && item.revision === map.revision && item.bindingFingerprint === plan.bindingFingerprint);
    const status = workflow.decision === "deferred" ? "deferred" : workflow.decision !== "confirmed" ? "needs-confirmation"
      : !plan.ready ? "blocked" : !run ? "unverified" : run.status === "observed" ? "observed" : run.status === "failed" ? "failed" : "inconclusive";
    return { id: workflow.id, title: workflow.title, priority: workflow.priority, status, blockers: plan.blockers,
      steps: plan.steps.map(step => ({ id: step.id, title: step.title, outcome: step.outcome,
        status: step.missing.length ? "blocked" : run?.steps?.find(item => item.id === step.id)?.status || "unverified" })),
      ...(run ? { lastRun: run } : {}) };
  });
  return { kind: "tapp-business-workflow-coverage", revision: map.revision, workflows,
    counts: Object.fromEntries(["needs-confirmation", "blocked", "unverified", "observed", "failed", "inconclusive", "deferred"].map(status => [status, workflows.filter(item => item.status === status).length])),
    scope: "Coverage of the explicitly listed workflows only. Unlisted workflows, roles, surfaces and failure cases remain unknown. Previous runs describe their recorded time and environment; they do not establish current health." };
}

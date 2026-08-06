import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { semanticUiKey } from "./ui-map.js";
import { compileReleaseContract, loadReleaseContractFile } from "./release-contract.js";
import { loadTaskFile } from "./task-runtime.js";
import { runWebFlow } from "./web-flow.js";

const STABLE_SELECTOR_PRIORITY = ["testId", "accessibilityId", "resourceId", "cssId"];

function sameNode(nodes, baseline) {
  return (nodes || []).find((node) => node.id === baseline.nodeId)
    || (nodes || []).find((node) => semanticUiKey(node.semanticKey || node.name) === semanticUiKey(baseline.nodeSemanticKey || baseline.nodeName));
}

function stableIntersection(before, after) {
  for (const kind of STABLE_SELECTOR_PRIORITY) {
    const oldValues = new Set((before.selectors || []).filter((selector) => selector.kind === kind).map((selector) => selector.value));
    const match = (after.selectors || []).find((selector) => selector.kind === kind && oldValues.has(selector.value));
    if (match) return match;
  }
  return null;
}

function currentStillMatchesTarget(control, target) {
  return [control.id, control.semanticKey, control.label, ...(control.selectors || []).map((selector) => selector.value)]
    .some((value) => String(value || "") === String(target || ""));
}

export function proposeSelectorMaintenance({ candidate, execution, currentMap, platform = "" } = {}) {
  const failure = execution?.firstFailure;
  if (!candidate || execution?.status !== "failed" || !failure || !["tap", "type"].includes(failure.action) || !failure.task || !currentMap?.nodes) return null;
  const references = (candidate.selectorReferences || []).filter((reference) =>
    reference.task === failure.task
    && reference.action === failure.action
    && semanticUiKey(reference.target) === semanticUiKey(failure.target)
    && (!platform || reference.platform === platform || reference.platform === "shared"));
  const operations = [];
  for (const reference of references) for (const baseline of reference.baselineControls || []) {
    const node = sameNode(currentMap.nodes, baseline);
    if (!node) continue;
    for (const control of node.controls || []) {
      const shared = stableIntersection(baseline, control);
      if (!shared || currentStillMatchesTarget(control, reference.target) || shared.value === reference.target) continue;
      operations.push({
        op: "replace",
        task: reference.task,
        taskPath: reference.taskPath,
        taskSha256: reference.taskSha256,
        pointer: reference.pointer,
        before: reference.target,
        after: shared.value,
        selector: shared,
        evidence: {
          nodeId: node.id,
          nodeSemanticKey: node.semanticKey,
          baselineLabel: baseline.label,
          currentLabel: control.label,
          baselineControlId: baseline.controlId,
          currentControlId: control.id,
        },
      });
    }
  }
  const unique = [...new Map(operations.map((operation) => [`${operation.taskPath}|${operation.pointer}|${operation.after}`, operation])).values()];
  if (unique.length !== 1) return null;
  return {
    kind: "task-maintenance-patch",
    schemaVersion: 1,
    status: "proposed-unvalidated",
    classification: "stable-selector-maintenance-candidate",
    deterministic: true,
    autoApply: false,
    contractIntent: { name: candidate.contract, path: candidate.contractPath, sha256: candidate.contractIntentSha256 },
    failureEvidence: failure,
    operations: unique,
    reason: "The unchanged contract failed on a Task selector. The baseline and current UI Maps preserve one non-label selector on the same semantic state while the visible label changed.",
    requiredReview: "Confirm the UI rename is intentional. The patch may change only the cited Task selector and must preserve the contract digest.",
    requiredValidation: "Apply in a review branch or disposable checkout, replay the unchanged contract on the real target, and accept only with passing evidence. The current gate remains failed.",
  };
}

function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function pointerParts(pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) throw new Error("maintenance operation has an invalid pointer");
  return pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function applyOperation(document, operation) {
  if (operation?.op !== "replace") throw new Error("only a replace maintenance operation can be validated");
  const parts = pointerParts(operation.pointer);
  let parent = document;
  for (const part of parts.slice(0, -1)) {
    if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, part)) throw new Error(`maintenance pointer does not resolve at '${part}'`);
    parent = parent[part];
  }
  const key = parts.at(-1);
  if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key)) throw new Error("maintenance pointer does not resolve to a Task value");
  if (parent[key] !== operation.before) throw new Error("Task value no longer matches the digest-pinned maintenance proposal");
  parent[key] = operation.after;
}

function copyReviewedTasks(sourceDir, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$|\.json$/i.test(entry.name)) continue;
    fs.copyFileSync(path.join(sourceDir, entry.name), path.join(destinationDir, entry.name));
  }
}

// Validate a proposal against the still-running changed web application while
// keeping the repository read-only. Only reviewed Task documents are copied;
// contract intent is loaded from, hashed in, and never rewritten in the source
// checkout. A passing replay remains advisory until the user accepts the patch.
export async function validateWebMaintenanceProposal({ proposal, projectDir, url, evidenceDir = "" } = {}) {
  if (proposal?.kind !== "task-maintenance-patch" || proposal.operations?.length !== 1) throw new Error("validation requires exactly one constrained Task maintenance operation");
  if (!projectDir || !url) throw new Error("web maintenance validation requires projectDir and the running target URL");
  const root = fs.realpathSync(path.resolve(projectDir));
  const operation = proposal.operations[0];
  const taskRoot = fs.realpathSync(path.join(root, ".autotap", "tasks"));
  const sourceTask = fs.realpathSync(path.resolve(root, operation.taskPath));
  const sourceContract = fs.realpathSync(path.resolve(root, proposal.contractIntent.path));
  if (!inside(taskRoot, sourceTask)) throw new Error("maintenance Task must be a regular reviewed file under .autotap/tasks");
  if (!inside(root, sourceContract)) throw new Error("maintenance contract must remain inside the project");
  if (digest(sourceTask) !== operation.taskSha256) throw new Error("Task digest changed after the proposal was created");
  if (digest(sourceContract) !== proposal.contractIntent.sha256) throw new Error("release-contract intent digest changed after the proposal was created");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-maintenance-validation-"));
  const tempTasks = path.join(tempRoot, ".autotap", "tasks");
  const stem = String(proposal.contractIntent.name || "contract").replace(/[^A-Za-z0-9._-]/g, "-");
  const outputDir = evidenceDir ? path.resolve(evidenceDir, stem) : path.join(tempRoot, "evidence");
  const logPath = path.join(outputDir, "validation.log");
  try {
    copyReviewedTasks(taskRoot, tempTasks);
    const tempTask = path.join(tempTasks, path.basename(sourceTask));
    if (digest(tempTask) !== operation.taskSha256) throw new Error("Task changed while the disposable validation registry was being prepared");
    const loadedTask = loadTaskFile(tempTask);
    const { __path: _taskPath, ...taskDocument } = loadedTask;
    applyOperation(taskDocument, operation);
    fs.writeFileSync(tempTask, JSON.stringify(taskDocument, null, 2) + "\n");

    const contract = await loadReleaseContractFile(sourceContract);
    if (digest(sourceContract) !== proposal.contractIntent.sha256) throw new Error("release-contract intent changed while validation was being prepared");
    if (Object.keys(contract.actors || {}).length !== 1) throw new Error("automatic disposable maintenance validation currently requires a single-actor web contract");
    if (!(contract.setup || []).length || !(contract.teardown || []).length) {
      throw new Error("automatic disposable maintenance validation requires controlled contract setup and teardown");
    }
    const pseudoContractPath = path.join(tempRoot, ".autotap", "contracts", path.basename(sourceContract));
    const execution = compileReleaseContract(contract, { platform: "web", sourcePath: pseudoContractPath });
    const result = await runWebFlow({ flow: execution, url, logPath, screenshotDir: outputDir });
    const contractUnchanged = digest(sourceContract) === proposal.contractIntent.sha256;
    const taskUnchanged = digest(sourceTask) === operation.taskSha256;
    return {
      status: result.passed && contractUnchanged && taskUnchanged ? "passed" : "failed",
      passed: result.passed && contractUnchanged && taskUnchanged,
      platform: "web",
      disposable: true,
      autoApplied: false,
      sourceArtifactsUnchanged: contractUnchanged && taskUnchanged,
      contractIntentSha256: proposal.contractIntent.sha256,
      taskBeforeSha256: operation.taskSha256,
      executed: result.executed,
      total: result.total,
      failed: result.failed,
      evidence: { logPath, screenshotDir: outputDir },
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

// Repository-native reusable tasks. A task centralizes semantic navigation and
// assertions once, then deterministically compiles into the existing shared
// Flow execution contract. Replay stays keyless and every expanded step keeps
// task provenance for evidence/review.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { semanticUiKey } from "./ui-map.js";
import { isProjectArtifactDirectory, projectArtifactDirectory } from "./project-paths.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function rawSpec(specPath) {
  const helper = path.join(packageRoot, "scripts", "flow_lib.py");
  const parsed = spawnSync("python3", [helper, "raw-json", specPath], { encoding: "utf8" });
  if (parsed.status !== 0) throw new Error((parsed.stderr || parsed.stdout || `Could not parse ${specPath}`).trim());
  return JSON.parse(parsed.stdout);
}

function taskAction(step) {
  if (!step || typeof step !== "object" || Array.isArray(step)) return "";
  if (typeof step.action === "string") return step.action.toLowerCase();
  return String(Object.keys(step)[0] || "").toLowerCase();
}

function implementationSteps(task, platform) {
  if (Array.isArray(task.steps)) return { name: "shared", steps: task.steps };
  const implementations = task.implementations || {};
  const selected = implementations[platform] || implementations.shared || implementations.default;
  if (Array.isArray(selected)) return { name: implementations[platform] ? platform : implementations.shared ? "shared" : "default", steps: selected };
  if (Array.isArray(selected?.steps)) return { name: implementations[platform] ? platform : implementations.shared ? "shared" : "default", steps: selected.steps };
  const available = Object.keys(implementations);
  if (!platform && available.length === 1) {
    const only = implementations[available[0]];
    return { name: available[0], steps: Array.isArray(only) ? only : only?.steps };
  }
  return null;
}

export function validateTaskDefinition(task) {
  const errors = [];
  if (!task || typeof task !== "object" || Array.isArray(task)) return ["Task must be an object"];
  if (task.kind !== "task") errors.push("kind must be 'task'");
  if (task.version !== 1) errors.push("version must be 1");
  if (!/^[a-z][A-Za-z0-9]*$/.test(String(task.name || ""))) errors.push("name must be lower camelCase");
  if (task.inputs !== undefined && (!task.inputs || typeof task.inputs !== "object" || Array.isArray(task.inputs))) errors.push("inputs must be an object");
  if (task.outputs !== undefined && (!task.outputs || typeof task.outputs !== "object" || Array.isArray(task.outputs))) errors.push("outputs must be an object");
  if (!Array.isArray(task.steps) && (!task.implementations || typeof task.implementations !== "object" || Array.isArray(task.implementations))) {
    errors.push("steps or implementations must define deterministic steps");
  }
  const variants = Array.isArray(task.steps) ? [task.steps] : Object.values(task.implementations || {}).map((value) => Array.isArray(value) ? value : value?.steps);
  for (const [variantIndex, steps] of variants.entries()) {
    if (!Array.isArray(steps) || steps.length === 0) { errors.push(`implementation ${variantIndex + 1} must have steps`); continue; }
    for (const [stepIndex, step] of steps.entries()) {
      const action = taskAction(step);
      if (!action) errors.push(`implementation ${variantIndex + 1} step ${stepIndex + 1} has no action`);
      if (action === "wait") errors.push(`implementation ${variantIndex + 1} step ${stepIndex + 1} uses a fixed wait; use wait_for`);
      if (action === "assert_ai") errors.push(`implementation ${variantIndex + 1} step ${stepIndex + 1} uses assert_ai; tasks must replay deterministically`);
    }
  }
  for (const phase of ["preconditions", "postconditions"]) {
    if (task[phase] !== undefined && !Array.isArray(task[phase])) errors.push(`${phase} must be an array`);
  }
  if (task.coverage !== undefined && (!task.coverage || typeof task.coverage !== "object" || Array.isArray(task.coverage))) {
    errors.push("coverage must be an object");
  } else if (task.coverage?.sourceSymbols !== undefined) {
    if (!Array.isArray(task.coverage.sourceSymbols)) errors.push("coverage.sourceSymbols must be an array");
    else for (const [index, owner] of task.coverage.sourceSymbols.entries()) {
      if (!owner || typeof owner !== "object" || Array.isArray(owner) || typeof owner.path !== "string" || !owner.path.trim()) {
        errors.push(`coverage.sourceSymbols[${index}] must define a path`);
      }
      if (!Array.isArray(owner?.symbols) || !owner.symbols.length || owner.symbols.some((symbol) => typeof symbol !== "string" || !/^[A-Za-z_$][\w$]*$/.test(symbol))) {
        errors.push(`coverage.sourceSymbols[${index}].symbols must contain named code symbols`);
      }
    }
  }
  return errors;
}

export function loadTaskFile(taskPath) {
  const task = rawSpec(taskPath);
  const errors = validateTaskDefinition(task);
  if (errors.length) throw new Error(`Invalid Task ${taskPath}: ${errors.join("; ")}`);
  return { ...task, __path: path.resolve(taskPath) };
}

function findTappDir(sourcePath, explicitProjectDir = "") {
  if (explicitProjectDir) {
    const root = path.resolve(explicitProjectDir);
    return path.join(root, projectArtifactDirectory(root));
  }
  let current = path.dirname(path.resolve(sourcePath));
  while (current !== path.dirname(current)) {
    if (isProjectArtifactDirectory(path.basename(current))) return current;
    const candidate = path.join(current, projectArtifactDirectory(current));
    if (fs.existsSync(candidate)) return candidate;
    current = path.dirname(current);
  }
  return "";
}

export function loadTaskRegistry({ sourcePath, projectDir = "", taskFiles = [] }) {
  const tappDir = findTappDir(sourcePath, projectDir);
  const taskDir = tappDir ? path.join(tappDir, "tasks") : "";
  const reviewed = taskDir && fs.existsSync(taskDir)
    ? fs.readdirSync(taskDir).filter((name) => /\.ya?ml$|\.json$/i.test(name)).map((name) => path.join(taskDir, name))
    : [];
  // Draft contracts generated under `.tapp/proposals/contracts` may compile
  // against sibling untrusted Task drafts. Ordinary committed contracts never
  // see this directory, so a proposal cannot silently enter the release gate.
  const proposalSource = [".tapp", ".autotap"].some((directory) => String(path.resolve(sourcePath || "")).includes(`${path.sep}${directory}${path.sep}proposals${path.sep}`));
  const proposalDir = proposalSource && tappDir ? path.join(tappDir, "proposals", "tasks") : "";
  const proposed = proposalDir && fs.existsSync(proposalDir)
    ? fs.readdirSync(proposalDir).filter((name) => /\.ya?ml$|\.json$/i.test(name)).map((name) => path.join(proposalDir, name))
    : [];
  const registry = new Map();
  for (const taskPath of [...reviewed, ...proposed, ...taskFiles.map((item) => path.resolve(item))]) {
    const task = loadTaskFile(taskPath);
    if (registry.has(task.name)) throw new Error(`Duplicate Task name '${task.name}'`);
    registry.set(task.name, task);
  }
  return registry;
}

function conditionStep(condition) {
  if (typeof condition === "string") return { assert_screen: condition };
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) throw new Error("Task conditions must be strings or objects");
  if (condition.screen) return { action: "assert_screen", target: condition.screen, timeoutMs: condition.timeoutMs };
  if (condition.exists) return { action: "assert_exists", target: condition.exists, timeoutMs: condition.timeoutMs };
  if (condition.absent) return { action: "assert_absent", target: condition.absent };
  if (condition.text) return { action: "assert_text", ...(typeof condition.text === "object" ? condition.text : { target: condition.text }), timeoutMs: condition.timeoutMs };
  throw new Error(`Unsupported Task condition: ${JSON.stringify(condition)}`);
}

function substituteTemplates(value, locals) {
  if (typeof value === "string") return value.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (match, key) => {
    if (!Object.hasOwn(locals, key)) throw new Error(`Unknown Task input '{{${key}}}'`);
    return String(locals[key]);
  });
  if (Array.isArray(value)) return value.map((item) => substituteTemplates(item, locals));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteTemplates(item, locals)]));
  return value;
}

function taskCall(step) {
  if (step?.task && typeof step.task === "string") return { wrapper: null, call: step };
  if (step?.actor && step.do?.task && typeof step.do.task === "string") return { wrapper: step.actor, call: step.do };
  return null;
}

function inputValues(task, call) {
  const supplied = call.with || {};
  const definitions = task.inputs || {};
  const unknown = Object.keys(supplied).filter((key) => !Object.hasOwn(definitions, key));
  if (unknown.length) throw new Error(`Task '${task.name}' received unknown inputs: ${unknown.join(", ")}`);
  const values = {};
  for (const [key, rawDefinition] of Object.entries(definitions)) {
    const definition = rawDefinition && typeof rawDefinition === "object" && !Array.isArray(rawDefinition) ? rawDefinition : { default: rawDefinition };
    if (Object.hasOwn(supplied, key)) values[key] = supplied[key];
    else if (Object.hasOwn(definition, "default")) values[key] = definition.default;
    else if (definition.required !== false) throw new Error(`Task '${task.name}' requires input '${key}'`);
    if (definition.secret && Object.hasOwn(values, key) && !/^\$[A-Z][A-Z0-9_]*$/.test(String(values[key]))) {
      throw new Error(`Task '${task.name}' secret input '${key}' must reference an environment variable such as $TEST_PASSWORD`);
    }
  }
  return values;
}

export function compileTaskSteps({ steps, registry, platform = "", flowVars = {}, stack = [], plan = [] }) {
  const expanded = [];
  for (const step of steps || []) {
    const invocation = taskCall(step);
    if (!invocation) { expanded.push(step); continue; }
    const task = registry.get(invocation.call.task);
    if (!task) throw new Error(`Task '${invocation.call.task}' was not found in .tapp/tasks`);
    if (stack.includes(task.name)) throw new Error(`Task cycle detected: ${[...stack, task.name].join(" -> ")}`);
    const implementation = implementationSteps(task, platform);
    if (!implementation?.steps) throw new Error(`Task '${task.name}' has no '${platform || "shared"}' implementation`);
    const locals = inputValues(task, invocation.call);
    const rawSteps = [
      ...(task.preconditions || []).map(conditionStep),
      ...implementation.steps,
      ...(task.postconditions || []).map(conditionStep),
    ].map((item) => substituteTemplates(item, locals));
    const nested = compileTaskSteps({ steps: rawSteps, registry, platform, flowVars, stack: [...stack, task.name], plan });
    const annotated = nested.steps.map((item, index) => ({
      ...item,
      __tappTask: item.__tappTask
        ? { ...item.__tappTask, parents: [task.name, ...(item.__tappTask.parents || [])] }
        : { name: task.name, version: task.version, implementation: implementation.name, step: index + 1 },
    }));
    expanded.push(...(invocation.wrapper ? annotated.map((item) => ({ actor: invocation.wrapper, do: item })) : annotated));

    const inputEvidence = Object.fromEntries(Object.entries(locals).map(([key, value]) => {
      const definition = task.inputs?.[key];
      return [key, definition?.secret ? "<secret>" : value];
    }));
    plan.push({ name: task.name, version: task.version, implementation: implementation.name, inputs: inputEvidence, coverage: task.coverage || { nodes: [], edges: [] }, source: task.__path });
    for (const [outputName, definition] of Object.entries(task.outputs || {})) {
      const saveAs = invocation.call.save?.[outputName];
      if (!saveAs) continue;
      const output = definition?.fromInput ? locals[definition.fromInput] : substituteTemplates(definition?.value ?? definition, locals);
      flowVars[saveAs] = output;
    }
  }
  return { steps: expanded, vars: flowVars, plan };
}

export function compileFlowTasksFromRepository({ flow, sourcePath, platform = "", projectDir = "", taskFiles = [] }) {
  if (!(flow.steps || []).some(taskCall)) return flow;
  const registry = loadTaskRegistry({ sourcePath, projectDir, taskFiles });
  const vars = { ...(flow.vars || {}) };
  const plan = [];
  const compiled = compileTaskSteps({ steps: flow.steps, registry, platform: platform || flow.platform || (flow.kind === "scenario" ? "web" : ""), flowVars: vars, plan });
  return { ...flow, steps: compiled.steps, vars: compiled.vars, taskPlan: plan, sourceSteps: flow.steps };
}

function referencedNodes(task, map) {
  const references = task.coverage?.nodes || [];
  return references.map((reference) => map.nodes.find((node) =>
    node.id === reference || semanticUiKey(node.semanticKey) === semanticUiKey(reference) || node.name === reference
  )).filter(Boolean);
}

export function validateTaskAgainstUiMap(task, map, platform = "") {
  const errors = validateTaskDefinition(task);
  const warnings = [];
  if (!map || map.schemaVersion !== 1) return { errors: [...errors, "A UI Map v1 is required"], warnings };
  const requestedNodes = task.coverage?.nodes || [];
  const nodes = referencedNodes(task, map);
  if (nodes.length !== requestedNodes.length) errors.push("coverage.nodes contains states not present in the UI Map");
  const edgeIds = new Set(map.edges.map((edge) => edge.id));
  for (const edge of task.coverage?.edges || []) if (!edgeIds.has(edge)) errors.push(`coverage edge '${edge}' is not present in the UI Map`);
  const implementation = implementationSteps(task, platform);
  if (!implementation?.steps) errors.push(`Task has no '${platform || "shared"}' implementation`);
  const controls = (nodes.length ? nodes : map.nodes).flatMap((node) => node.controls || []);
  const controlKeys = new Set(controls.flatMap((control) => [control.semanticKey, semanticUiKey(control.label), ...(control.selectors || []).map((selector) => semanticUiKey(selector.value))]));
  for (const step of implementation?.steps || []) {
    const action = taskAction(step);
    if (!["tap", "type"].includes(action)) continue;
    const body = typeof step.action === "string" ? step : step[action];
    const target = typeof body === "object" ? body.target || body.field : body;
    if (target && !String(target).includes("{{") && !controlKeys.has(semanticUiKey(target))) warnings.push(`'${target}' was not observed on the Task's covered states`);
  }
  if (!(task.coverage?.edges || []).length) warnings.push("Task does not yet cite any observed UI Map edges");
  return { errors, warnings };
}

export function applyTaskCoverage(map, task) {
  const next = structuredClone(map);
  const nodes = referencedNodes(task, next);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(task.coverage?.edges || []);
  next.coverage ||= { tasks: [], contracts: [], uncoveredNodeIds: [], uncoveredEdgeIds: [] };
  next.coverage.tasks = [...new Set([...(next.coverage.tasks || []), task.name])].sort();
  for (const node of next.nodes) {
    if (!nodeIds.has(node.id)) continue;
    node.coveredBy ||= { tasks: [], contracts: [] };
    node.coveredBy.tasks = [...new Set([...(node.coveredBy.tasks || []), task.name])].sort();
  }
  for (const edge of next.edges) {
    if (!edgeIds.has(edge.id)) continue;
    edge.coveredBy ||= { tasks: [], contracts: [] };
    edge.coveredBy.tasks = [...new Set([...(edge.coveredBy.tasks || []), task.name])].sort();
  }
  next.coverage.uncoveredNodeIds = next.nodes.filter((node) => !(node.coveredBy?.tasks || []).length && !(node.coveredBy?.contracts || []).length).map((node) => node.id).sort();
  next.coverage.uncoveredEdgeIds = next.edges.filter((edge) => !(edge.coveredBy?.tasks || []).length && !(edge.coveredBy?.contracts || []).length).map((edge) => edge.id).sort();
  return next;
}

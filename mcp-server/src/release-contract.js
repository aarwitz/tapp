// Business-level release contracts compile to the same deterministic Flow or
// isolated Scenario runtime already used by every platform. TypeScript is an
// authoring/type-checking surface only; it never participates in replay.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { compileFlowTasksFromRepository } from "./task-runtime.js";
import { semanticUiKey } from "./ui-map.js";

const PLATFORMS = new Set(["ios", "android", "web"]);
const CRITICALITIES = new Set(["low", "medium", "high", "critical"]);
const CONTRACT_AUTHORING_SPECIFIERS = new Set(["@aarwitz/tapp/contracts", "runtapp/contracts", "tapp-mcp/contracts"]);
const CONTRACT_AUTHORING_IMPORT = /(["'])(?:@aarwitz\/tapp|runtapp|tapp-mcp)\/contracts\1/g;
const authoringUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "contract-authoring.js")).href;

function expectationAction(expectation) {
  const timeoutMs = Number(expectation.eventually?.timeoutMs || 6000);
  if (expectation.screen) return { action: "assert_screen", target: expectation.screen, timeoutMs };
  if (expectation.exists) return { action: "assert_exists", target: expectation.exists, timeoutMs };
  if (expectation.absent) return { action: "assert_absent", target: expectation.absent, timeoutMs };
  if (expectation.text) return { action: "assert_text", of: expectation.text.of, contains: expectation.text.contains, timeoutMs };
  throw new Error("Contract expectation must define screen, exists, absent, or text");
}

function validateRequestPhases(contract, errors) {
  for (const phase of ["setup", "teardown"]) {
    if (contract[phase] !== undefined && !Array.isArray(contract[phase])) errors.push(`${phase} must be an array`);
    for (const [index, step] of (contract[phase] || []).entries()) {
      if (!step?.request || typeof step.request !== "object") errors.push(`${phase}[${index}] must be a request step`);
      else if (!step.request.path) errors.push(`${phase}[${index}].request.path is required`);
    }
  }
}

export function validateReleaseContract(contract) {
  const errors = [];
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return ["Release contract must be an object"];
  if (contract.kind !== "release-contract") errors.push("kind must be 'release-contract'");
  if (contract.version !== 1) errors.push("version must be 1");
  if (!/^[a-z][A-Za-z0-9]*$/.test(String(contract.name || ""))) errors.push("name must be lower camelCase");
  if (!String(contract.title || "").trim()) errors.push("title is required");
  if (!String(contract.businessValue || "").trim()) errors.push("businessValue is required");
  if (!CRITICALITIES.has(contract.criticality)) errors.push("criticality must be low|medium|high|critical");
  if (!Array.isArray(contract.platforms) || contract.platforms.length === 0) errors.push("platforms must be a non-empty array");
  else for (const platform of contract.platforms) if (!PLATFORMS.has(platform)) errors.push(`unsupported platform '${platform}'`);

  const actorNames = contract.actors && typeof contract.actors === "object" && !Array.isArray(contract.actors)
    ? Object.keys(contract.actors) : [];
  if (!actorNames.length) errors.push("actors must define at least one named actor");
  if (actorNames.length > 1) {
    for (const actor of actorNames) if ((contract.actors[actor].session || "isolated") !== "isolated") errors.push(`actor '${actor}' must use an isolated session in a multi-actor contract`);
  }

  if (!Array.isArray(contract.steps) || contract.steps.length === 0) errors.push("steps must be a non-empty array");
  let taskCount = 0;
  for (const [index, step] of (contract.steps || []).entries()) {
    if (!step || typeof step !== "object" || Array.isArray(step)) { errors.push(`steps[${index}] must be an object`); continue; }
    if (!actorNames.includes(step.actor)) errors.push(`steps[${index}].actor must name a defined actor`);
    if (typeof step.task === "string") {
      taskCount += 1;
      if (step.expect !== undefined) errors.push(`steps[${index}] cannot define both task and expect`);
    } else if (step.expect && typeof step.expect === "object") {
      const keys = ["screen", "exists", "absent", "text"].filter((key) => step.expect[key] !== undefined);
      if (keys.length !== 1) errors.push(`steps[${index}].expect must define exactly one exact assertion`);
      const eventual = step.expect.eventually;
      if (eventual) {
        const timeout = Number(eventual.timeoutMs);
        const poll = Number(eventual.pollMs || 250);
        if (!(timeout > 0 && timeout <= 120000)) errors.push(`steps[${index}].expect.eventually.timeoutMs must be 1..120000`);
        if (!(poll >= 50 && poll <= timeout)) errors.push(`steps[${index}].expect.eventually.pollMs must be between 50 and timeoutMs`);
      }
    } else {
      errors.push(`steps[${index}] must call a Task or define an exact expectation`);
    }
  }
  if (!taskCount) errors.push("a release contract must compose at least one reusable Task");
  validateRequestPhases(contract, errors);
  return errors;
}

function rewriteAuthoringImport(source, contractPath) {
  if (/\bimport\s*\(/.test(source) || /\brequire\s*\(/.test(source)) {
    throw new Error("Release contracts cannot use dynamic import or require");
  }
  const imports = [...source.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)].map((match) => match[1]);
  const unsupported = imports.filter((specifier) => !CONTRACT_AUTHORING_SPECIFIERS.has(specifier));
  if (unsupported.length) throw new Error(`Release contract imports are limited to @aarwitz/tapp/contracts (legacy runtapp/contracts and tapp-mcp/contracts are also accepted; found ${unsupported.join(", ")})`);
  const output = ts.transpileModule(source, {
    fileName: contractPath,
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
    reportDiagnostics: true,
  });
  const diagnostics = (output.diagnostics || []).filter((item) => item.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length) throw new Error(diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, " ")).join("; "));
  return output.outputText.replace(CONTRACT_AUTHORING_IMPORT, JSON.stringify(authoringUrl));
}

export async function loadReleaseContractFile(contractPath) {
  const absolute = path.resolve(contractPath);
  if (!fs.existsSync(absolute)) throw new Error(`Release contract not found: ${absolute}`);
  const extension = path.extname(absolute).toLowerCase();
  let contract;
  if (extension === ".json") {
    contract = JSON.parse(fs.readFileSync(absolute, "utf8"));
  } else if ([".ts", ".mts", ".js", ".mjs"].includes(extension)) {
    const source = fs.readFileSync(absolute, "utf8");
    const code = extension === ".ts" || extension === ".mts" ? rewriteAuthoringImport(source, absolute)
      : source.replace(CONTRACT_AUTHORING_IMPORT, JSON.stringify(authoringUrl));
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-contract-"));
    const modulePath = path.join(tempDir, "contract.mjs");
    try {
      fs.writeFileSync(modulePath, code);
      contract = (await import(`${pathToFileURL(modulePath).href}?v=${Date.now()}`)).default;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } else {
    throw new Error("Release contracts must be .contract.ts, .mts, .mjs, .js, or .json");
  }
  const normalized = { ...contract, kind: contract?.kind || "release-contract", version: contract?.version ?? 1, __path: absolute };
  const errors = validateReleaseContract(normalized);
  if (errors.length) throw new Error(`Invalid Release Contract: ${errors.join("; ")}`);
  return normalized;
}

function compiledActors(contract) {
  return Object.fromEntries(Object.entries(contract.actors).map(([name, actor]) => {
    const { credentials = {}, ...publicActor } = actor;
    return [name, {
      ...publicActor,
      vars: {
        ...(actor.vars || {}),
        ...(credentials.email ? { EMAIL: credentials.email } : {}),
        ...(credentials.password ? { PASSWORD: credentials.password } : {}),
      },
    }];
  }));
}

export function compileReleaseContract(contract, { platform = "", sourcePath = contract.__path || "" } = {}) {
  const errors = validateReleaseContract(contract);
  if (errors.length) throw new Error(`Invalid Release Contract: ${errors.join("; ")}`);
  const selected = String(platform || (contract.platforms.length === 1 ? contract.platforms[0] : "")).toLowerCase();
  if (!selected) throw new Error("A platform is required when a release contract applies to multiple platforms");
  if (!contract.platforms.includes(selected)) throw new Error(`Release contract '${contract.name}' does not apply to ${selected}`);
  const actorNames = Object.keys(contract.actors);
  if (actorNames.length > 1 && selected !== "web") throw new Error("isolated multi-actor release contracts currently run on web; iOS and Android isolation remain unsupported");
  const multiActor = actorNames.length > 1;
  if (!multiActor && selected !== "web" && ((contract.setup || []).length || (contract.teardown || []).length)) {
    throw new Error("single-actor request setup/teardown currently runs on web; use target-native reset for iOS or Android");
  }
  const onlyActor = contract.actors[actorNames[0]];
  const singleActorVars = multiActor ? {} : {
    ...(onlyActor.vars || {}),
    ...(onlyActor.credentials?.email ? { EMAIL: onlyActor.credentials.email } : {}),
    ...(onlyActor.credentials?.password ? { PASSWORD: onlyActor.credentials.password } : {}),
  };
  const sourceSteps = contract.steps.map((step) => {
    const body = step.task
      ? { task: step.task, ...(step.with ? { with: step.with } : {}), ...(step.save ? { save: step.save } : {}) }
      : expectationAction(step.expect);
    return multiActor ? { actor: step.actor, do: body } : body;
  });
  const execution = {
    name: contract.title,
    kind: multiActor ? "scenario" : "flow",
    platform: selected,
    ...(contract.url ? { url: contract.url } : {}),
    ...(contract.app ? { app: contract.app } : {}),
    timeoutMs: Number(contract.timeoutMs) || 6000,
    vars: { ...(contract.variables || {}), ...singleActorVars },
    ...(multiActor ? { actors: compiledActors(contract) } : {}),
    setup: contract.setup || [],
    steps: sourceSteps,
    teardown: contract.teardown || [],
    releaseContract: {
      name: contract.name,
      title: contract.title,
      businessValue: contract.businessValue,
      criticality: contract.criticality,
      policy: contract.policy || {},
      platforms: contract.platforms,
      coverage: contract.coverage || {},
      source: sourcePath,
    },
  };
  return compileFlowTasksFromRepository({ flow: execution, sourcePath, platform: selected });
}

function referencedNodes(contract, map) {
  return (contract.coverage?.nodes || []).map((reference) => map.nodes.find((node) =>
    node.id === reference || semanticUiKey(node.semanticKey) === semanticUiKey(reference) || node.name === reference)).filter(Boolean);
}

export function validateReleaseContractAgainstUiMap(contract, map) {
  const errors = validateReleaseContract(contract);
  const warnings = [];
  if (!map || map.schemaVersion !== 1) return { errors: [...errors, "A UI Map v1 is required"], warnings };
  const nodes = referencedNodes(contract, map);
  if (nodes.length !== (contract.coverage?.nodes || []).length) errors.push("coverage.nodes contains states not present in the UI Map");
  const edges = new Set(map.edges.map((edge) => edge.id));
  for (const edge of contract.coverage?.edges || []) if (!edges.has(edge)) errors.push(`coverage edge '${edge}' is not present in the UI Map`);
  if (!(contract.coverage?.nodes || []).length) warnings.push("release contract does not yet cite UI Map states");
  return { errors, warnings };
}

export function applyReleaseContractCoverage(map, contract) {
  const next = structuredClone(map);
  const nodeIds = new Set(referencedNodes(contract, next).map((node) => node.id));
  const edgeIds = new Set(contract.coverage?.edges || []);
  next.coverage = next.coverage || { tasks: [], contracts: [], uncoveredNodeIds: [], uncoveredEdgeIds: [] };
  next.coverage.contracts = [...new Set([...(next.coverage.contracts || []), contract.name])].sort();
  for (const node of next.nodes) if (nodeIds.has(node.id)) {
    node.coveredBy ||= { tasks: [], contracts: [] };
    node.coveredBy.contracts = [...new Set([...(node.coveredBy.contracts || []), contract.name])].sort();
  }
  for (const edge of next.edges) if (edgeIds.has(edge.id)) {
    edge.coveredBy ||= { tasks: [], contracts: [] };
    edge.coveredBy.contracts = [...new Set([...(edge.coveredBy.contracts || []), contract.name])].sort();
  }
  next.coverage.uncoveredNodeIds = next.nodes.filter((node) => !(node.coveredBy?.tasks || []).length && !(node.coveredBy?.contracts || []).length).map((node) => node.id).sort();
  next.coverage.uncoveredEdgeIds = next.edges.filter((edge) => !(edge.coveredBy?.tasks || []).length && !(edge.coveredBy?.contracts || []).length).map((edge) => edge.id).sort();
  return next;
}

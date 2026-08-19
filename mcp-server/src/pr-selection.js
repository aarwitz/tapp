// Deterministic PR-to-contract relevance. This layer consumes only reviewed
// source ownership, Task composition, and UI Map coverage; it does not guess
// product intent or let AI decide what gates a merge.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { loadReleaseContractFile } from "./release-contract.js";
import { loadTaskRegistry } from "./task-runtime.js";
import { replayableUiMapNavigation, semanticUiKey } from "./ui-map.js";
import { existingProjectArtifactPath, isProjectArtifactDirectory } from "./project-paths.js";

function posix(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function wildcard(pattern) {
  return new RegExp(`^${posix(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("**", "§§").replaceAll("*", "[^/]*").replaceAll("§§", ".*")}(?:/.*)?$`);
}

export function sourcePathMatches(changedFile, ownershipPath) {
  const file = posix(changedFile);
  const owner = posix(ownershipPath).replace(/\/$/, "");
  if (!file || !owner) return false;
  if (owner.includes("*")) return wildcard(owner).test(file);
  return file === owner || file.startsWith(owner + "/");
}

function repoRootFor(sourcePath) {
  let current = path.dirname(path.resolve(sourcePath));
  while (current !== path.dirname(current)) {
    if (isProjectArtifactDirectory(path.basename(current))) return path.dirname(current);
    if (fs.existsSync(existingProjectArtifactPath(current))) return current;
    current = path.dirname(current);
  }
  return process.cwd();
}

function relativeSource(sourcePath, repoRoot) {
  const absolute = path.resolve(sourcePath);
  return posix(path.relative(repoRoot, absolute));
}

function mapReferences(items, references) {
  const keys = new Set((references || []).map((item) => semanticUiKey(item)));
  return items.filter((item) => keys.has(semanticUiKey(item.id)) || keys.has(semanticUiKey(item.semanticKey)) || keys.has(semanticUiKey(item.name)));
}

function matchedFiles(changedFiles, ownership) {
  return changedFiles.filter((file) => ownership.some((owner) => sourcePathMatches(file, owner)));
}

function exactStaticRouteFiles(node, changedFiles) {
  const matches = [];
  for (const route of node.routes || []) {
    if (route?.platform !== "web" || route.replayable !== true || typeof route.path !== "string") continue;
    if (route.path.includes("<") || route.path.includes("?")) continue;
    let routeFile = "";
    try { routeFile = posix(decodeURIComponent(route.path)); } catch { continue; }
    if (!routeFile || routeFile.endsWith("/")) continue;
    for (const file of changedFiles) {
      if (posix(file) === routeFile) matches.push({ file, route: route.path });
    }
  }
  return matches;
}

function selectedCoverageFor(contract, relevantTasks, map) {
  if (!map) return { nodes: [], edges: [] };
  const nodes = mapReferences(map.nodes || [], [
    ...(contract.coverage?.nodes || []),
    ...relevantTasks.flatMap((task) => task.coverage?.nodes || []),
  ]).map((node) => node.id);
  const edges = [
    ...(contract.coverage?.edges || []),
    ...relevantTasks.flatMap((task) => task.coverage?.edges || []),
  ].filter((edge) => (map.edges || []).some((item) => item.id === edge));
  return { nodes: [...new Set(nodes)].sort(), edges: [...new Set(edges)].sort() };
}

function explorationTargetForNode({ node, evidence, platform, selectedNodeIds, map }) {
  if (!node || selectedNodeIds.has(node.id)) return null;
  const route = (node.routes || []).find((item) => item.platform === platform && item.replayable === true);
  const mapNavigation = route ? null : replayableUiMapNavigation(map, node.id, platform);
  const changedFiles = [...new Set(evidence.flatMap((item) => item.files || []))].sort();
  const id = `explore_${crypto.createHash("sha256").update(`${platform}|${node.id}|${changedFiles.join("|")}`).digest("hex").slice(0, 16)}`;
  return {
    id,
    platform,
    node: { id: node.id, semanticKey: node.semanticKey, name: node.name },
    changedFiles,
    evidence,
    navigation: route
      ? { status: "replayable", mode: "route", route: route.path, provenance: "observed-ui-map" }
      : mapNavigation,
    baselineControls: (node.controls || []).slice(0, 30).map((control) => ({
      id: control.id,
      semanticKey: control.semanticKey,
      kind: control.kind,
      label: control.label,
      selectors: control.selectors || [],
    })),
    coverage: { status: "not-covered-by-selected-contract", tasks: node.coveredBy?.tasks || [], contracts: node.coveredBy?.contracts || [] },
    budget: { maxTargetRoutes: 1, maxActions: 12 },
    status: "planned",
  };
}

function changedInput(value) {
  if (Array.isArray(value)) return value;
  const raw = String(value || "").trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("changed files JSON must be an array");
    return parsed;
  }
  return raw.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

// Extract only declaration identities, never diff source. This deliberately
// favors an attributable file-level fallback over guessing when a hunk cannot
// be tied to a named function/type.
function declarationsFromLine(value) {
  const line = String(value || "");
  const symbols = [];
  const patterns = [
    /\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /\b(?:func|fun|def)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:class|struct|interface|enum|protocol|extension|actor|record)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
    /^\s*(?:(?:public|private|protected|internal|static|final|abstract|open|override|virtual|sealed|synchronized|native|async|export)\s+)+(?:[A-Za-z_$][\w$<>,.?\[\]:]*\s+)+([A-Za-z_$][\w$]*)\s*\(/g,
  ];
  for (const pattern of patterns) {
    for (const match of line.matchAll(pattern)) symbols.push(match[1]);
  }
  return [...new Set(symbols)];
}

function patchEvidence(file, patch) {
  const hunks = [];
  let active = null;
  for (const line of String(patch || "").split("\n")) {
    if (line.startsWith("@@")) {
      const context = line.match(/^@@[\s\S]*?@@\s*(.*)$/)?.[1] || "";
      active = { symbols: new Set(declarationsFromLine(context)) };
      hunks.push(active);
      continue;
    }
    if (!active || (!line.startsWith("+") && !line.startsWith("-")) || line.startsWith("+++") || line.startsWith("---")) continue;
    for (const symbol of declarationsFromLine(line.slice(1))) active.symbols.add(symbol);
  }
  const symbols = hunks.flatMap((hunk) => [...hunk.symbols]);
  return {
    file: posix(file),
    patchAvailable: typeof patch === "string" && patch.length > 0,
    hunks: hunks.length,
    attributedHunks: hunks.filter((hunk) => hunk.symbols.size > 0).length,
    precise: hunks.length > 0 && hunks.every((hunk) => hunk.symbols.size > 0),
    symbols: [...new Set(symbols)].sort(),
  };
}

function mergeDiffEvidence(items) {
  const byFile = new Map();
  for (const item of items) {
    if (!item?.file) continue;
    const file = posix(item.file);
    const previous = byFile.get(file);
    if (!previous) {
      byFile.set(file, { ...item, file, symbols: [...new Set(item.symbols || [])].sort() });
      continue;
    }
    byFile.set(file, {
      file,
      patchAvailable: previous.patchAvailable || item.patchAvailable,
      hunks: previous.hunks + item.hunks,
      attributedHunks: previous.attributedHunks + item.attributedHunks,
      precise: previous.precise && item.precise,
      symbols: [...new Set([...(previous.symbols || []), ...(item.symbols || [])])].sort(),
    });
  }
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

export function parseChangedDiffEvidence(value) {
  const evidence = [];
  for (const item of changedInput(value)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const file = item.path || item.filename;
    if (!file || typeof item.patch !== "string") continue;
    evidence.push(patchEvidence(file, item.patch));
  }
  return mergeDiffEvidence(evidence);
}

export function parseChangedSymbols(value) {
  return parseChangedDiffEvidence(value).flatMap((item) => item.symbols.map((symbol) => ({
    file: item.file,
    symbol,
    basis: "diff-declaration-or-hunk-context",
  })));
}

function taskCalls(task) {
  const variants = Array.isArray(task.steps)
    ? [task.steps]
    : Object.values(task.implementations || {}).map((value) => Array.isArray(value) ? value : value?.steps);
  return [...new Set(variants.flatMap((steps) => (steps || []).flatMap((step) => {
    if (typeof step?.task === "string") return [step.task];
    if (typeof step?.do?.task === "string") return [step.do.task];
    return [];
  })))];
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function implementationFor(task, platform) {
  if (Array.isArray(task.steps)) return { platform: "shared", steps: task.steps, path: ["steps"] };
  const implementations = task.implementations || {};
  const key = implementations[platform] ? platform : implementations.shared ? "shared" : implementations.default ? "default" : "";
  if (!key) return null;
  const value = implementations[key];
  return Array.isArray(value)
    ? { platform: key, steps: value, path: ["implementations", key] }
    : Array.isArray(value?.steps) ? { platform: key, steps: value.steps, path: ["implementations", key, "steps"] } : null;
}

function selectorStepReference(step, index, prefix) {
  if (!step || typeof step !== "object" || Array.isArray(step)) return null;
  if (typeof step.action === "string") {
    const action = step.action.toLowerCase();
    if (!['tap', 'type'].includes(action)) return null;
    const field = action === "type" && step.field !== undefined ? "field" : "target";
    if (typeof step[field] !== "string") return null;
    return { action, target: step[field], pointer: [...prefix, String(index), field] };
  }
  const [action, body] = Object.entries(step)[0] || [];
  if (!['tap', 'type'].includes(String(action || "").toLowerCase())) return null;
  if (typeof body === "string") return { action: action.toLowerCase(), target: body, pointer: [...prefix, String(index), action] };
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const field = action.toLowerCase() === "type" ? "field" : "target";
  if (typeof body[field] !== "string") return null;
  return { action: action.toLowerCase(), target: body[field], pointer: [...prefix, String(index), action, field] };
}

function controlMatches(control, target) {
  const key = semanticUiKey(target);
  return [control.id, control.semanticKey, control.label, ...(control.selectors || []).map((selector) => selector.value)]
    .some((value) => semanticUiKey(value) === key);
}

function selectorReferences(task, map, platform, root) {
  const implementation = implementationFor(task, platform);
  if (!implementation || !map) return [];
  const nodes = mapReferences(map.nodes || [], task.coverage?.nodes || []);
  if (!nodes.length) return [];
  return implementation.steps.flatMap((step, index) => {
    const reference = selectorStepReference(step, index, implementation.path);
    if (!reference || reference.target.includes("{{")) return [];
    const controls = nodes.flatMap((node) => (node.controls || []).filter((control) => controlMatches(control, reference.target)).map((control) => ({
      nodeId: node.id,
      nodeSemanticKey: node.semanticKey,
      nodeName: node.name,
      controlId: control.id,
      label: control.label,
      selectors: (control.selectors || []).filter((selector) => ["testId", "accessibilityId", "resourceId", "cssId", "label"].includes(selector.kind)),
    })));
    if (!controls.length) return [];
    return [{
      task: task.name,
      taskPath: relativeSource(task.__path, root),
      taskSha256: sha256(task.__path),
      platform: implementation.platform,
      action: reference.action,
      target: reference.target,
      pointer: "/" + reference.pointer.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/"),
      baselineControls: controls,
    }];
  });
}

function transitiveTasks(names, registry) {
  const found = [];
  const visited = new Set();
  const visit = (name) => {
    if (visited.has(name)) return;
    visited.add(name);
    const task = registry.get(name);
    if (!task) return;
    found.push(task);
    for (const child of taskCalls(task)) visit(child);
  };
  for (const name of names) visit(name);
  return found;
}

export function parseChangedFiles(value) {
  const input = changedInput(value);
  if (Array.isArray(input)) {
    const files = input.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (!item || typeof item !== "object") throw new Error("changed files must be strings or change objects");
      return [item.path || item.filename, item.previousPath || item.previous_filename].filter(Boolean);
    });
    return [...new Set(files.map(posix).filter(Boolean))].sort();
  }
  return [];
}

export function webSeedRoutesFromPrPlan(plan, limit = 5) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return [];
  const boundedLimit = Math.max(0, Math.min(5, Number(limit) || 0));
  if (boundedLimit === 0) return [];
  const routes = [];
  for (const target of plan.explorationTargets || []) {
    const route = target?.navigation?.route;
    if (target?.platform !== "web" || target?.status !== "planned" || target?.navigation?.status !== "replayable" || typeof route !== "string" || !route.startsWith("/")) continue;
    if (!routes.includes(route)) routes.push(route);
    if (routes.length >= boundedLimit) break;
  }
  return routes;
}

export function prExplorationTargetsFromPlan(plan, platform, limit = platform === "web" ? 5 : 1) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || !["ios", "android", "web"].includes(platform)) return [];
  const maximum = platform === "web" ? 5 : 1;
  const boundedLimit = Math.max(0, Math.min(maximum, Number(limit) || 0));
  if (boundedLimit === 0) return [];
  const targets = [];
  const ids = new Set();
  for (const candidate of plan.explorationTargets || []) {
    if (candidate?.platform !== platform || candidate?.status !== "planned" || candidate?.navigation?.status !== "replayable") continue;
    if (typeof candidate.id !== "string" || !candidate.id || ids.has(candidate.id) || !candidate.node?.id || !candidate.node?.name) continue;
    const navigation = candidate.navigation;
    let safeNavigation = null;
    if (navigation.mode === "route" || (navigation.mode === undefined && typeof navigation.route === "string")) {
      if (platform !== "web" || typeof navigation.route !== "string" || !navigation.route.startsWith("/") || navigation.route.includes("<")) continue;
      safeNavigation = { status: "replayable", mode: "route", route: navigation.route, provenance: "observed-ui-map" };
    } else if (navigation.mode === "ui-map-path") {
      if (typeof navigation.entryNodeId !== "string" || typeof navigation.targetNodeId !== "string" || navigation.targetNodeId !== candidate.node.id || !Array.isArray(navigation.steps) || navigation.steps.length > 8) continue;
      const steps = [];
      let valid = true;
      for (const step of navigation.steps) {
        const action = step?.action;
        if (!step?.edgeId || !step?.from || !step?.to || !["tap", "back"].includes(action?.type) || typeof action?.target !== "string" || !action.target || /<[^>]+>|\{\{/.test(action.target)) { valid = false; break; }
        steps.push(structuredClone(step));
      }
      if (!valid) continue;
      safeNavigation = {
        status: "replayable", mode: "ui-map-path", provenance: "observed-ui-map",
        entryNodeId: navigation.entryNodeId, targetNodeId: navigation.targetNodeId,
        steps, maxSteps: Math.max(0, Math.min(8, Number(navigation.maxSteps) || 8)),
      };
    }
    if (!safeNavigation) continue;
    ids.add(candidate.id);
    targets.push({
      id: candidate.id,
      platform,
      status: "planned",
      node: { id: candidate.node.id, semanticKey: candidate.node.semanticKey, name: candidate.node.name },
      navigation: safeNavigation,
      budget: structuredClone(candidate.budget || { maxTargetRoutes: 1, maxActions: 12 }),
    });
    if (targets.length >= boundedLimit) break;
  }
  return targets;
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function groundingKey(entry) {
  if (entry?.type === "ui-map-node") return `ui-map-node:${entry.id}`;
  if (entry?.type === "pr-exploration") return `pr-exploration:${entry.targetId}`;
  return JSON.stringify(entry);
}

function mergeGroundingEvidence(existing, incoming) {
  const merged = [];
  const indexByKey = new Map();
  for (const entry of [...(existing || []), ...(incoming || [])]) {
    const key = groundingKey(entry);
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, merged.length);
      merged.push(structuredClone(entry));
      continue;
    }
    const prior = merged[index];
    if (entry.type === "ui-map-node") prior.observationCount = Math.max(Number(prior.observationCount || 0), Number(entry.observationCount || 0));
    else if (entry.type === "pr-exploration") {
      prior.changedFiles = [...new Set([...(prior.changedFiles || []), ...(entry.changedFiles || [])])].sort();
      prior.route ||= entry.route;
      prior.navigationMode ||= entry.navigationMode;
      prior.edgeIds = [...new Set([...(prior.edgeIds || []), ...(entry.edgeIds || [])])].sort();
      prior.provenance ||= entry.provenance;
    }
  }
  return merged;
}

export function adoptPrCoverageProposal({ projectDir, prPlanPath, item, releasePlanPath = ".tapp/release-plan.json" } = {}) {
  const root = fs.realpathSync(path.resolve(projectDir || process.cwd()));
  const source = path.resolve(prPlanPath || "");
  if (!prPlanPath || !fs.existsSync(source)) throw new Error(`PR plan not found: ${source || "(missing path)"}`);
  const targetPath = releasePlanPath === ".tapp/release-plan.json" ? existingProjectArtifactPath(root, "release-plan.json") : path.resolve(root, releasePlanPath);
  if (!inside(root, targetPath)) throw new Error("Release plan path must stay inside the project directory");
  if (!fs.existsSync(targetPath)) throw new Error(`Release plan not found: ${targetPath}; run npx -y @aarwitz/tapp@latest init first`);
  const prPlan = JSON.parse(fs.readFileSync(source, "utf8"));
  if (prPlan?.schemaVersion !== 1 || !Array.isArray(prPlan.explorationTargets)) throw new Error("PR plan must be an executed Tapp PR plan v1");
  const matches = prPlan.explorationTargets.filter((target) => target.id === item);
  if (matches.length !== 1) throw new Error(matches.length ? `PR exploration item is ambiguous: ${item}` : `PR exploration item not found: ${item}`);
  const target = matches[0];
  if (target.execution?.status !== "observed" || target.execution?.conclusive !== true) throw new Error(`PR exploration item '${item}' has no conclusive observed execution evidence`);
  const proposal = target.coverageProposal;
  if (proposal?.kind !== "release-plan-item-proposal" || proposal.autoApply !== false || !["add-item", "reconcile-item"].includes(proposal.operation?.op)) {
    throw new Error(`PR exploration item '${item}' has no reviewable release-plan proposal`);
  }
  const proposed = structuredClone(proposal.operation.item);
  if (proposed?.origin !== "deterministic-ui-map-proposal" || proposed?.decision !== "pending") throw new Error("Coverage proposal is not a pending UI-Map-grounded release-plan item");
  const ground = (proposed.groundedBy || []).find((entry) => entry.type === "ui-map-node");
  const mapPath = existingProjectArtifactPath(root, "ui-map.json");
  if (!ground || !fs.existsSync(mapPath)) throw new Error("Coverage proposal requires the repository's persistent UI Map");
  const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  const node = (map.nodes || []).find((candidate) => candidate.id === ground.id && candidate.status !== "proposed");
  const refreshAdvice = "refresh the persistent UI Map with `npx -y @aarwitz/tapp@latest init --explore --refresh`, rerun `npx -y @aarwitz/tapp@latest pr gate`, then retry `npx -y @aarwitz/tapp@latest pr adopt`";
  if (!node) throw new Error(`Coverage proposal UI Map node is stale or missing: ${ground.id}; ${refreshAdvice}`);
  if (target.navigation?.route && !(node.routes || []).some((route) => route.platform === target.platform && route.path === target.navigation.route && route.replayable === true)) {
    throw new Error(`Coverage proposal route is stale in the persistent UI Map: ${target.navigation.route}; ${refreshAdvice}`);
  }
  if (target.navigation?.mode === "ui-map-path") {
    const currentNavigation = replayableUiMapNavigation(map, node.id, target.platform);
    const expectedEdges = (target.navigation.steps || []).map((step) => step.edgeId);
    const currentEdges = (currentNavigation.steps || []).map((step) => step.edgeId);
    if (currentNavigation.status !== "replayable" || JSON.stringify(expectedEdges) !== JSON.stringify(currentEdges)) {
      throw new Error(`Coverage proposal UI Map path is stale for ${node.name}; ${refreshAdvice}`);
    }
  }
  const releasePlan = JSON.parse(fs.readFileSync(targetPath, "utf8"));
  if (releasePlan?.schemaVersion !== 1 || releasePlan?.kind !== "tapp-release-plan" || !Array.isArray(releasePlan.items)) throw new Error("Target release plan is not a Tapp release plan v1");
  const duplicateIndex = releasePlan.items.findIndex((candidate) => candidate.id === proposed.id || candidate.name === proposed.name);
  const adoption = {
    source: "executed-pr-exploration",
    targetId: target.id,
    changedFiles: target.changedFiles || [],
    adoptedAt: new Date().toISOString(),
  };
  let mode = "added";
  let adopted = proposed;
  let nextItems;
  if (duplicateIndex >= 0) {
    const duplicate = releasePlan.items[duplicateIndex];
    const duplicateGround = (duplicate.groundedBy || []).find((entry) => entry.type === "ui-map-node");
    if (duplicate.origin === "committed" || duplicateGround?.id !== ground.id || (duplicate.id !== proposed.id && duplicate.name !== proposed.name)) {
      throw new Error(`Release plan already contains incompatible '${duplicate.name}' (${duplicate.id}); no existing item was changed`);
    }
    const grounding = mergeGroundingEvidence(duplicate.groundedBy, proposed.groundedBy);
    adopted = { ...duplicate, groundedBy: grounding, adoption };
    nextItems = releasePlan.items.map((candidate, index) => index === duplicateIndex ? adopted : candidate);
    mode = "reconciled-existing";
  } else {
    if (proposal.operation.op === "reconcile-item") throw new Error(`Release plan item '${proposed.name}' disappeared before evidence reconciliation`);
    adopted.adoption = adoption;
    nextItems = [...releasePlan.items, adopted];
  }
  const next = { ...releasePlan, status: nextItems.some((candidate) => candidate.decision === "pending") ? "awaiting-review" : releasePlan.status, items: nextItems };
  const temporary = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(temporary, targetPath);
  return { path: targetPath, item: adopted, plan: next, mode };
}

export function readChangedFilesFile(filePath) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error(`changed-files file not found: ${absolute}`);
  const raw = fs.readFileSync(absolute, "utf8");
  const parsed = changedInput(raw);
  parseChangedFiles(parsed); // Validate before returning bounded patch objects.
  return parsed;
}

// NUL-delimited name-status output preserves spaces and both sides of renames.
// Refs are passed as argv and `--` terminates revision parsing.
export function changedFilesFromGit({ projectDir, base, head = "HEAD" }) {
  if (!base) throw new Error("base ref is required");
  const result = spawnSync("git", ["diff", "--name-status", "-z", "--find-renames", `${base}...${head}`, "--"], {
    cwd: path.resolve(projectDir || process.cwd()),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Could not read git diff ${base}...${head}: ${(result.stderr || result.stdout || "git exited non-zero").trim()}`);
  }
  const fields = result.stdout.split("\0");
  const changes = [];
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++];
    if (/^[RC]/.test(status)) {
      const previousPath = fields[index++];
      const currentPath = fields[index++];
      if (previousPath) changes.push(previousPath);
      if (currentPath) changes.push(currentPath);
    } else {
      const file = fields[index++];
      if (file) changes.push(file);
    }
  }
  return parseChangedFiles(changes);
}

function diffPath(value) {
  let file = String(value || "").trim();
  if (!file || file === "/dev/null") return "";
  if (file.startsWith('"') && file.endsWith('"')) {
    try { file = JSON.parse(file); } catch {}
  }
  return posix(file.replace(/^[ab]\//, ""));
}

export function changedSymbolEvidenceFromGit({ projectDir, base, head = "HEAD" }) {
  if (!base) throw new Error("base ref is required");
  const result = spawnSync("git", ["diff", "--unified=0", "--no-ext-diff", "--find-renames", `${base}...${head}`, "--"], {
    cwd: path.resolve(projectDir || process.cwd()),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Could not read git diff evidence ${base}...${head}: ${(result.stderr || result.stdout || "git exited non-zero").trim()}`);
  }
  const evidence = [];
  let oldFile = "";
  let currentFile = "";
  let patch = [];
  const flush = () => {
    const file = currentFile || oldFile;
    if (file && patch.length) evidence.push(patchEvidence(file, patch.join("\n")));
    oldFile = "";
    currentFile = "";
    patch = [];
  };
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("diff --git ")) { flush(); continue; }
    if (line.startsWith("--- ")) { oldFile = diffPath(line.slice(4)); continue; }
    if (line.startsWith("+++ ")) { currentFile = diffPath(line.slice(4)); continue; }
    if (line.startsWith("@@") || patch.length) patch.push(line);
  }
  flush();
  return mergeDiffEvidence(evidence);
}

function taskSymbolOwnership(task) {
  return (task.coverage?.sourceSymbols || []).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.path !== "string" || !Array.isArray(item.symbols)) return [];
    return [{ path: posix(item.path), symbols: [...new Set(item.symbols.filter((symbol) => typeof symbol === "string" && symbol).map(String))] }];
  });
}

function taskFileImpact(task, file, evidenceByFile) {
  const ownership = taskSymbolOwnership(task).filter((item) => sourcePathMatches(file, item.path));
  if (!ownership.length) return { affected: true, mode: "file" };
  const evidence = evidenceByFile.get(posix(file));
  if (!evidence?.precise) return { affected: true, mode: "file-fallback" };
  const owned = new Set(ownership.flatMap((item) => item.symbols));
  const symbols = evidence.symbols.filter((symbol) => owned.has(symbol));
  return { affected: symbols.length > 0, mode: "symbol", symbols, ownership };
}

export async function buildPrContractPlan({
  projectDir,
  changedFiles,
  changedSymbolEvidence = [],
  platform = "",
  mapPath = "",
  contractPaths = [],
  discoverContracts = true,
} = {}) {
  const root = path.resolve(projectDir || process.cwd());
  const changes = parseChangedFiles(changedFiles);
  if (!changes.length) throw new Error("changedFiles must contain at least one repository-relative path");
  const diffEvidence = mergeDiffEvidence([
    ...parseChangedDiffEvidence(changedFiles),
    ...(Array.isArray(changedSymbolEvidence) ? changedSymbolEvidence : []),
  ]);
  const evidenceByFile = new Map(diffEvidence.map((item) => [item.file, item]));
  const contractDir = existingProjectArtifactPath(root, "contracts");
  const discovered = discoverContracts && fs.existsSync(contractDir)
    ? fs.readdirSync(contractDir).filter((name) => /\.contract\.(?:ts|mts|mjs|js|json)$/i.test(name)).map((name) => path.join(contractDir, name)) : [];
  const files = [...new Set([...discovered, ...contractPaths.map((item) => path.resolve(root, item))])];
  const contracts = [];
  for (const file of files) {
    const contract = await loadReleaseContractFile(file);
    if (!platform || contract.platforms.includes(platform)) contracts.push(contract);
  }

  let tasks = new Map();
  const registrySource = files[0] || existingProjectArtifactPath(root, "contracts", "contract.ts");
  try { tasks = loadTaskRegistry({ sourcePath: registrySource, projectDir: root }); } catch {}
  let map = null;
  const resolvedMapPath = mapPath ? path.resolve(root, mapPath) : existingProjectArtifactPath(root, "ui-map.json");
  if (fs.existsSync(resolvedMapPath)) map = JSON.parse(fs.readFileSync(resolvedMapPath, "utf8"));

  const impactedNodes = map ? map.nodes.filter((node) => matchedFiles(changes, node.sourcePaths || []).length) : [];
  const impactedEdges = map ? map.edges.filter((edge) => matchedFiles(changes, edge.sourcePaths || []).length) : [];
  const routeImpacts = map && (!platform || platform === "web")
    ? map.nodes.flatMap((node) => {
      const matches = exactStaticRouteFiles(node, changes);
      return matches.length ? [{ node, matches }] : [];
    })
    : [];
  const selected = [];
  const skipped = [];
  const allOwnership = [];
  const reviewedTaskSurfaceImpacts = [];
  for (const task of tasks.values()) {
    if (platform && platform !== "all" && !implementationFor(task, platform)) continue;
    const taskRelative = relativeSource(task.__path, root);
    const symbolOwnership = taskSymbolOwnership(task);
    const ownership = [...new Set([...(task.coverage?.sourcePaths || []), ...symbolOwnership.map((item) => item.path)])];
    allOwnership.push(...ownership);
    const sourceFiles = matchedFiles(changes, ownership).filter((file) => taskFileImpact(task, file, evidenceByFile).affected);
    const artifactChanged = changes.includes(taskRelative);
    if (!map || (!sourceFiles.length && !artifactChanged)) continue;
    const nodes = mapReferences(map.nodes || [], task.coverage?.nodes || []);
    for (const node of nodes) reviewedTaskSurfaceImpacts.push({
      node,
      task: task.name,
      taskPath: taskRelative,
      files: [...new Set([...(artifactChanged ? [taskRelative] : []), ...sourceFiles])].sort(),
      ownership,
    });
  }

  for (const contract of contracts) {
    const reasons = [];
    const contractRelative = relativeSource(contract.__path, root);
    if (changes.includes(contractRelative)) reasons.push({ type: "contract-changed", files: [contractRelative] });
    if (contract.criticality === "critical" || contract.policy?.always === true) reasons.push({ type: "always", detail: contract.criticality === "critical" ? "critical contract" : "policy.always" });

    const directOwnership = contract.coverage?.sourcePaths || [];
    allOwnership.push(...directOwnership);
    const direct = matchedFiles(changes, directOwnership);
    if (direct.length) reasons.push({ type: "contract-source", files: direct, ownership: directOwnership });

    const contractTaskNames = [...new Set(contract.steps.filter((step) => step.task).map((step) => step.task))];
    const relevantTasks = transitiveTasks(contractTaskNames, tasks);
    for (const task of relevantTasks) {
      const taskRelative = relativeSource(task.__path, root);
      const symbolOwnership = taskSymbolOwnership(task);
      const taskOwnership = [...new Set([...(task.coverage?.sourcePaths || []), ...symbolOwnership.map((item) => item.path)])];
      allOwnership.push(...taskOwnership);
      const owned = matchedFiles(changes, taskOwnership);
      if (changes.includes(taskRelative)) reasons.push({ type: "task-changed", task: task.name, files: [taskRelative] });
      const sourceFiles = [];
      const symbolFiles = [];
      const symbols = [];
      const fallbackFiles = [];
      for (const file of owned) {
        const impact = taskFileImpact(task, file, evidenceByFile);
        if (!impact.affected) continue;
        if (impact.mode === "symbol") {
          symbolFiles.push(file);
          symbols.push(...impact.symbols);
        } else {
          sourceFiles.push(file);
          if (impact.mode === "file-fallback") fallbackFiles.push(file);
        }
      }
      if (symbolFiles.length) reasons.push({
        type: "task-symbol",
        task: task.name,
        files: [...new Set(symbolFiles)].sort(),
        symbols: [...new Set(symbols)].sort(),
        ownership: symbolOwnership,
      });
      if (sourceFiles.length) reasons.push({
        type: "task-source",
        task: task.name,
        files: [...new Set(sourceFiles)].sort(),
        ownership: taskOwnership,
        ...(fallbackFiles.length ? { precision: "file-fallback", detail: "Diff hunks were unavailable or not fully attributable to reviewed symbols" } : {}),
      });
      if (map) {
        const taskNodes = new Set(mapReferences(map.nodes, task.coverage?.nodes).map((node) => node.id));
        const taskEdges = new Set(task.coverage?.edges || []);
        const nodeHits = impactedNodes.filter((node) => taskNodes.has(node.id) && matchedFiles(changes, node.sourcePaths || []).some((file) => taskFileImpact(task, file, evidenceByFile).affected));
        const edgeHits = impactedEdges.filter((edge) => taskEdges.has(edge.id) && matchedFiles(changes, edge.sourcePaths || []).some((file) => taskFileImpact(task, file, evidenceByFile).affected));
        if (nodeHits.length || edgeHits.length) reasons.push({ type: "task-ui-map", task: task.name, nodes: nodeHits.map((node) => node.id), edges: edgeHits.map((edge) => edge.id) });
      }
    }

    if (map) {
      const coveredNodes = new Set(mapReferences(map.nodes, contract.coverage?.nodes).map((node) => node.id));
      const coveredEdges = new Set(contract.coverage?.edges || []);
      const nodeHits = impactedNodes.filter((node) => coveredNodes.has(node.id));
      const edgeHits = impactedEdges.filter((edge) => coveredEdges.has(edge.id));
      if (nodeHits.length || edgeHits.length) reasons.push({ type: "contract-ui-map", nodes: nodeHits.map((node) => node.id), edges: edgeHits.map((edge) => edge.id) });
    }

    const item = {
      name: contract.name,
      title: contract.title,
      criticality: contract.criticality,
      platforms: contract.platforms,
      path: contractRelative,
      intentSha256: sha256(contract.__path),
      tasks: relevantTasks.map((task) => task.name),
      taskPaths: relevantTasks.map((task) => relativeSource(task.__path, root)),
      coverage: selectedCoverageFor(contract, relevantTasks, map),
      reasons,
    };
    if (reasons.length) selected.push(item);
    else skipped.push({ ...item, reasons: [{ type: "not-relevant", detail: "No reviewed source, Task, or UI Map ownership matched the diff" }] });
  }

  const ownedArtifacts = [
    ...files.map((file) => relativeSource(file, root)),
    ...[...tasks.values()].map((task) => relativeSource(task.__path, root)),
    ...(map ? [relativeSource(resolvedMapPath, root)] : []),
  ];
  const mapOwnership = map ? [...map.nodes, ...map.edges].flatMap((item) => item.sourcePaths || []) : [];
  const routeMappedFiles = new Set(routeImpacts.flatMap((impact) => impact.matches.map((match) => match.file)));
  const uncoveredChangedFiles = changes.filter((file) =>
    ![...allOwnership, ...mapOwnership].some((owner) => sourcePathMatches(file, owner)) && !ownedArtifacts.includes(file) && !routeMappedFiles.has(file));
  const selectedNodeIds = new Set(selected.flatMap((item) => item.coverage.nodes));
  const selectedEdgeIds = new Set(selected.flatMap((item) => item.coverage.edges));
  const derivedNodeIds = new Set(routeImpacts.map((impact) => impact.node.id));
  const uncoveredUiMap = {
    nodes: [...new Set([
      ...impactedNodes.filter((node) => !selectedNodeIds.has(node.id)).map((node) => node.id),
      ...reviewedTaskSurfaceImpacts.filter((impact) => !selectedNodeIds.has(impact.node.id)).map((impact) => impact.node.id),
      ...routeImpacts.filter((impact) => !selectedNodeIds.has(impact.node.id)).map((impact) => impact.node.id),
    ])].sort(),
    edges: impactedEdges.filter((edge) => !selectedEdgeIds.has(edge.id)).map((edge) => edge.id),
  };
  const targetEvidence = new Map();
  for (const node of impactedNodes) {
    targetEvidence.set(node.id, [{
      type: "reviewed-source-ownership",
      provenance: "human-authored-ui-map",
      files: matchedFiles(changes, node.sourcePaths || []),
      ownership: node.sourcePaths || [],
    }]);
  }
  for (const impact of reviewedTaskSurfaceImpacts) {
    const evidence = targetEvidence.get(impact.node.id) || [];
    evidence.push({
      type: "reviewed-task-source-ownership",
      provenance: "human-authored-task",
      task: impact.task,
      taskPath: impact.taskPath,
      files: impact.files,
      ownership: impact.ownership,
    });
    targetEvidence.set(impact.node.id, evidence);
  }
  for (const impact of routeImpacts) {
    const evidence = targetEvidence.get(impact.node.id) || [];
    evidence.push({
      type: "exact-static-route",
      provenance: "source-derived",
      files: [...new Set(impact.matches.map((match) => match.file))].sort(),
      routes: [...new Set(impact.matches.map((match) => match.route))].sort(),
      detail: "An observed replayable web route exactly matches a repository-relative changed file",
    });
    targetEvidence.set(impact.node.id, evidence);
  }
  for (const edge of impactedEdges) {
    const node = map?.nodes.find((candidate) => candidate.id === edge.to);
    if (!node || selectedEdgeIds.has(edge.id)) continue;
    const evidence = targetEvidence.get(node.id) || [];
    evidence.push({
      type: "reviewed-edge-source-ownership",
      provenance: "human-authored-ui-map",
      files: matchedFiles(changes, edge.sourcePaths || []),
      edgeIds: [edge.id],
      ownership: edge.sourcePaths || [],
    });
    targetEvidence.set(node.id, evidence);
  }
  const allExplorationTargets = [...targetEvidence.entries()]
    .map(([nodeId, evidence]) => explorationTargetForNode({
      node: map?.nodes.find((node) => node.id === nodeId), evidence, platform: platform || "all", selectedNodeIds, map,
    }))
    .filter(Boolean)
    .sort((a, b) => `${a.navigation.status}:${a.node.id}`.localeCompare(`${b.navigation.status}:${b.node.id}`));
  const explorationLimit = platform === "web" ? 5 : 1;
  const explorationTargets = allExplorationTargets.slice(0, explorationLimit);
  const maintenanceCandidates = selected.flatMap((item) => {
    const taskReasons = item.reasons.filter((reason) => ["task-changed", "task-symbol", "task-source", "task-ui-map"].includes(reason.type));
    if (!taskReasons.length) return [];
    const affected = new Set(taskReasons.map((reason) => reason.task).filter(Boolean));
    const affectedTasks = [...tasks.values()].filter((task) => affected.has(task.name));
    return [{
      contract: item.name,
      contractPath: item.path,
      contractIntentSha256: item.intentSha256,
      tasks: item.tasks.filter((task) => affected.has(task)),
      taskPaths: item.taskPaths.filter((taskPath, index) => affected.has(item.tasks[index])),
      selectorReferences: affectedTasks.flatMap((task) => selectorReferences(task, map, platform, root)),
      changedFiles: [...new Set(taskReasons.flatMap((reason) => reason.files || []))].sort(),
      reason: "Task implementation or its owned UI surface changed",
      nextAction: "Replay the unchanged contract first; propose a reviewed Task patch only if evidence shows intentional UI maintenance rather than a behavioral regression.",
    }];
  });

  return {
    schemaVersion: 1,
    platform: platform || "all",
    changedFiles: changes,
    changedSymbols: diffEvidence.flatMap((item) => item.symbols.map((symbol) => ({ file: item.file, symbol, basis: "diff-declaration-or-hunk-context" }))),
    diffEvidence: diffEvidence.map(({ symbols: _symbols, ...item }) => item),
    selected,
    skipped,
    impactedUiMap: {
      nodes: [...new Set([...impactedNodes.map((node) => node.id), ...reviewedTaskSurfaceImpacts.map((impact) => impact.node.id)])].sort(),
      edges: impactedEdges.map((edge) => edge.id),
    },
    derivedUiMapImpacts: {
      nodes: [...derivedNodeIds].sort(),
      evidence: routeImpacts.map((impact) => ({
        nodeId: impact.node.id,
        type: "exact-static-route",
        files: [...new Set(impact.matches.map((match) => match.file))].sort(),
        routes: [...new Set(impact.matches.map((match) => match.route))].sort(),
      })),
      advisoryOnly: true,
    },
    uncoveredUiMap,
    uncoveredChangedFiles,
    explorationTargets,
    explorationTargetSummary: { planned: explorationTargets.length, omittedByLimit: allExplorationTargets.length - explorationTargets.length, limit: explorationLimit },
    maintenanceCandidates,
    policy: {
      criticalAlways: true,
      uncertainOwnership: "report-uncovered",
      derivedRouteEvidence: "bounded-exploration-only",
      maintenance: "fail-existing-contract-before-proposing-reviewable-task-change",
    },
  };
}

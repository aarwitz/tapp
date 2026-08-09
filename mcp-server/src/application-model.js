// Deterministic repository import for `tapp init`. This constructs inspectable
// facts and grounded release-plan proposals without launching a target or
// sending source/customer data to a model.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { credentialBindingsFromValue, readProjectConfig } from "./project-config.js";
import { applyReleaseContractCoverage, compileReleaseContract, loadReleaseContractFile, validateReleaseContractAgainstUiMap } from "./release-contract.js";
import { applyTaskCoverage, loadTaskFile, validateTaskAgainstUiMap } from "./task-runtime.js";
import { semanticUiKey } from "./ui-map.js";

const SKIP = new Set([".git", ".build", ".gradle", ".next", ".swiftpm", "Pods", "Carthage", "DerivedData", "build", "dist", "node_modules", "vendor"]);

function posix(value) { return String(value || "").replaceAll("\\", "/"); }
function relative(root, value) { return posix(path.relative(root, value)) || "."; }
function stableId(prefix, value) { return `${prefix}_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)}`; }
function humanize(value) {
  return String(value || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().replace(/^./, (letter) => letter.toUpperCase());
}

function walk(root, maxDepth = 4) {
  const files = [];
  const directories = [];
  const visit = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".autotap")) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        directories.push(absolute);
        if (/\.(xcodeproj|xcworkspace)$/.test(entry.name)) continue;
        if (depth < maxDepth) visit(absolute, depth + 1);
      } else if (entry.isFile()) files.push(absolute);
    }
  };
  visit(root, 0);
  return { files, directories };
}

function sourceEvidence(paths, detail = "") {
  return { basis: "source-observed", paths: [...new Set(paths)].sort(), ...(detail ? { detail } : {}) };
}

function reviewedEvidence(paths, detail = "") {
  return { basis: "reviewed-artifact", paths: [...new Set(paths)].sort(), ...(detail ? { detail } : {}) };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function detectIosTargets(root, inventory) {
  const containers = inventory.directories.filter((item) => /\.(xcworkspace|xcodeproj)$/.test(item) && !item.includes(`${path.sep}Pods${path.sep}`));
  const workspaces = containers.filter((item) => item.endsWith(".xcworkspace") && !item.includes(".xcodeproj/"));
  const projects = containers.filter((item) => item.endsWith(".xcodeproj"));
  const selected = workspaces.length ? workspaces : projects;
  return selected.map((container) => {
    const source = relative(root, container);
    const sharedSchemesDir = path.join(container, "xcshareddata", "xcschemes");
    let schemes = [];
    try { schemes = fs.readdirSync(sharedSchemesDir).filter((name) => name.endsWith(".xcscheme")).map((name) => name.replace(/\.xcscheme$/, "")); } catch {}
    const fallback = path.basename(container).replace(/\.(xcworkspace|xcodeproj)$/, "");
    return {
      id: stableId("target", `ios|${source}`), platform: "ios", kind: "ios-simulator", name: fallback,
      sourcePath: source, status: schemes.length ? "configured" : "needs-confirmation",
      build: { tool: "xcodebuild", container: source, schemeCandidates: schemes, proposedScheme: schemes.find((item) => item === fallback) || schemes[0] || fallback, configuration: "Debug" },
      runtime: { surface: "iOS Simulator", signingRequired: false },
      evidence: sourceEvidence([source, ...schemes.map((name) => posix(path.join(source, "xcshareddata/xcschemes", `${name}.xcscheme`)))], schemes.length ? "shared scheme observed" : "scheme is a source-derived proposal and must be validated by a build"),
    };
  });
}

function repositoryRelativePath(root, value) {
  if (!String(value || "").trim()) return "";
  let absolute = path.resolve(root, String(value));
  try { absolute = fs.realpathSync(absolute); } catch { return ""; }
  const candidate = path.relative(root, absolute);
  if (!candidate || candidate === "." || path.isAbsolute(candidate) || candidate === ".." || candidate.startsWith(`..${path.sep}`)) return "";
  return posix(candidate);
}

function applyRuntimeTargetValidation(root, targets, validation) {
  if (!validation || validation.platform !== "ios" || validation.resolution?.kind !== "xcode-build-installed") return targets;
  const build = validation.resolution.build || {};
  const container = repositoryRelativePath(root, build.container);
  const scheme = String(build.scheme || "").trim();
  const configuration = String(build.configuration || "").trim() || "Debug";
  const bundleId = String(validation.target || validation.resolution.bundleId || "").trim();
  if (!container || !scheme || !bundleId) return targets;
  const captureId = String(validation.evidence?.captureId || "").trim();
  return targets.map((target) => {
    if (target.platform !== "ios" || posix(target.sourcePath) !== container) return target;
    return {
      ...target,
      status: "configured",
      build: {
        ...target.build,
        schemeCandidates: [...new Set([...(target.build?.schemeCandidates || []), scheme])].sort(),
        proposedScheme: scheme,
        configuration,
      },
      runtime: { ...target.runtime, bundleId },
      evidence: {
        ...target.evidence,
        detail: `The scheme was source-derived, then confirmed by a successful Tapp build as '${scheme}'.`,
      },
      runtimeValidation: {
        status: "validated",
        basis: "runtime-observed",
        operation: "xcode-build-install-explore",
        target: bundleId,
        build: { container, scheme, configuration },
        evidence: {
          ...(captureId ? { capture: portableEvidenceReference(`tapp-capture:${captureId}`) } : {}),
          verdict: String(validation.evidence?.verdict || "unknown"),
          inconclusive: validation.evidence?.inconclusive === true,
          ...(validation.evidence?.observedAt ? { observedAt: String(validation.evidence.observedAt) } : {}),
        },
        detail: "Tapp built this repository target with the recorded scheme, installed it, launched it, and produced UI Map evidence.",
      },
    };
  });
}

function persistedTargetValidations(root, outDir) {
  const artifactDir = path.resolve(root, String(outDir || ".autotap"));
  const relativeArtifactDir = path.relative(root, artifactDir);
  if (path.isAbsolute(relativeArtifactDir) || relativeArtifactDir === ".." || relativeArtifactDir.startsWith(`..${path.sep}`)) return [];
  const prior = readJson(path.join(artifactDir, "application-model.json"));
  if (prior?.schemaVersion !== 1 || prior.kind !== "tapp-application-model" || !Array.isArray(prior.targets)) return [];
  return prior.targets.flatMap((target) => {
    const validation = target?.runtimeValidation;
    if (target?.platform !== "ios" || validation?.status !== "validated" || validation?.basis !== "runtime-observed" || validation?.operation !== "xcode-build-install-explore") return [];
    const capture = String(validation.evidence?.capture || "");
    return [{
      platform: "ios",
      target: String(validation.target || target.runtime?.bundleId || ""),
      resolution: {
        kind: "xcode-build-installed",
        bundleId: String(validation.target || target.runtime?.bundleId || ""),
        build: {
          container: validation.build?.container,
          scheme: validation.build?.scheme,
          configuration: validation.build?.configuration,
        },
      },
      evidence: {
        captureId: capture.startsWith("tapp-capture:") ? capture.slice("tapp-capture:".length) : "",
        verdict: validation.evidence?.verdict,
        inconclusive: validation.evidence?.inconclusive === true,
        observedAt: validation.evidence?.observedAt,
      },
    }];
  });
}

function androidApplicationId(source) {
  const match = source.match(/\bapplicationId\s*(?:=\s*)?["']([^"']+)["']/);
  return match?.[1] || "";
}

function appliesAndroidApplicationPlugin(source) {
  if (/apply\s*(?:plugin\s*:\s*|plugin\s*=\s*)["']com\.android\.application["']/.test(source)) return true;
  const blocks = [...source.matchAll(/plugins\s*\{([\s\S]*?)\}/g)].map((match) => match[1]);
  return blocks.some((block) => /com\.android\.application/.test(block) && !/\bapply\s+false\b/.test(block));
}

function detectAndroidTargets(root, inventory) {
  const gradleFiles = inventory.files.filter((item) => /(?:^|\/)(?:build\.gradle(?:\.kts)?)$/.test(posix(item)));
  return gradleFiles.flatMap((file) => {
    const source = fs.readFileSync(file, "utf8");
    if (!appliesAndroidApplicationPlugin(source)) return [];
    const moduleDir = path.dirname(file);
    let gradleRoot = moduleDir;
    while (gradleRoot !== root && !fs.existsSync(path.join(gradleRoot, "gradlew")) && !fs.existsSync(path.join(gradleRoot, "settings.gradle")) && !fs.existsSync(path.join(gradleRoot, "settings.gradle.kts"))) gradleRoot = path.dirname(gradleRoot);
    const modulePath = relative(gradleRoot, moduleDir);
    const appId = androidApplicationId(source);
    return [{
      id: stableId("target", `android|${relative(root, moduleDir)}`), platform: "android", kind: "android-application", name: path.basename(moduleDir),
      sourcePath: relative(root, moduleDir), status: appId ? "configured" : "needs-confirmation",
      build: { tool: fs.existsSync(path.join(gradleRoot, "gradlew")) ? "gradle-wrapper" : "gradle", projectDir: relative(root, gradleRoot), task: `${modulePath === "." ? "" : `:${posix(modulePath).replaceAll("/", ":")}`}:assembleDebug`.replace(/^::/, ":") },
      runtime: { surface: "Android emulator/device", applicationId: appId || null },
      evidence: sourceEvidence([relative(root, file)], appId ? "application plugin and application id observed" : "application plugin observed; application id requires confirmation"),
    }];
  });
}

const WEB_HINTS = new Set(["@angular/core", "@remix-run/react", "astro", "next", "nuxt", "react", "react-dom", "svelte", "vite", "vue"]);
const WEB_LOCKFILES = [
  ["package-lock.json", "npm ci"],
  ["npm-shrinkwrap.json", "npm ci"],
  ["pnpm-lock.yaml", "corepack pnpm install --frozen-lockfile"],
  ["yarn.lock", "corepack yarn install --immutable"],
  ["bun.lock", "bun install --frozen-lockfile"],
  ["bun.lockb", "bun install --frozen-lockfile"],
];

function webDependencyPlan(root, dir, pkg) {
  const dependencyCount = ["dependencies", "devDependencies", "optionalDependencies"]
    .reduce((total, key) => total + Object.keys(pkg[key] || {}).length, 0);
  if (!dependencyCount) return { install: null, dependencyStatus: "not-required", evidencePaths: [] };
  let cursor = dir;
  while (true) {
    for (const [name, install] of WEB_LOCKFILES) {
      const candidate = path.join(cursor, name);
      if (fs.existsSync(candidate)) return {
        install, dependencyStatus: "locked", lockfile: relative(root, candidate),
        installProjectDir: relative(root, cursor), evidencePaths: [relative(root, candidate)],
      };
    }
    if (cursor === root) break;
    const parent = path.dirname(cursor);
    if (parent === cursor || !isInsideRoot(root, parent)) break;
    cursor = parent;
  }
  return { install: null, dependencyStatus: "missing-lockfile", evidencePaths: [] };
}

function isInsideRoot(root, candidate) {
  const value = path.relative(root, candidate);
  return value === "" || (!value.startsWith(`..${path.sep}`) && value !== "..");
}

function detectWebTargets(root, inventory, ownedUrl = "") {
  const packageFiles = inventory.files.filter((item) => path.basename(item) === "package.json");
  const targets = packageFiles.flatMap((file) => {
    const pkg = readJson(file);
    if (!pkg) return [];
    const dir = path.dirname(file);
    const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const scripts = pkg.scripts || {};
    const indexEntry = ["index.html", "public/index.html", "src/index.html"].find((candidate) => fs.existsSync(path.join(dir, candidate)));
    const hasIndex = !!indexEntry;
    const webDependency = Object.keys(dependencies).some((name) => WEB_HINTS.has(name));
    const startEntry = ["dev", "start", "serve", "preview"].find((name) => typeof scripts[name] === "string");
    // A Node service having `start: node server.js` is not evidence that it owns
    // a browser UI. Require an actual browser entrypoint or a recognized web
    // framework; start scripts only explain how to launch an already-grounded
    // web target.
    if (!hasIndex && !webDependency) return [];
    const sourcePath = relative(root, dir);
    const dependencyPlan = webDependencyPlan(root, dir, pkg);
    const managed = dependencyPlan.dependencyStatus !== "missing-lockfile" && (!!startEntry || hasIndex);
    return [{
      id: stableId("target", `web|${sourcePath}`), platform: "web", kind: "browser-application", name: pkg.name || path.basename(dir),
      sourcePath, status: (ownedUrl || managed) ? "configured" : "needs-confirmation",
      build: { tool: "package-script", projectDir: sourcePath, ...dependencyPlan, ...(scripts.build ? { build: "npm run build" } : {}), start: startEntry ? `npm run ${startEntry}` : null },
      runtime: { surface: "Chromium", ownedUrl: ownedUrl || null, management: ownedUrl ? "customer-managed" : managed ? "tapp-managed" : "unresolved" },
      evidence: sourceEvidence([relative(root, file), ...(indexEntry ? [relative(root, path.join(dir, indexEntry))] : []), ...dependencyPlan.evidencePaths], `${startEntry ? `start script '${startEntry}' observed` : "static entrypoint observed"}; dependencies ${dependencyPlan.dependencyStatus}; runtime ${ownedUrl ? "customer-provided URL" : managed ? "Tapp-managed build/start" : "unresolved"}`),
    }];
  });
  if (!targets.length && fs.existsSync(path.join(root, "index.html"))) {
    targets.push({
      id: stableId("target", "web|."), platform: "web", kind: "static-browser-application", name: path.basename(root),
      sourcePath: ".", status: "configured",
      build: { tool: "static-files", projectDir: ".", install: null, start: null },
      runtime: { surface: "Chromium", ownedUrl: ownedUrl || null, management: ownedUrl ? "customer-managed" : "tapp-managed" },
      evidence: sourceEvidence(["index.html"], `static browser entrypoint observed; runtime ${ownedUrl ? "customer-provided URL" : "Tapp-managed static server"}`),
    });
  }
  return targets;
}

function loadUiMapAt(root, relativePath) {
  const mapPath = path.join(root, relativePath);
  const map = readJson(mapPath);
  const artifactPath = posix(relativePath);
  if (!map || map.schemaVersion !== 1) return { map: null, summary: { path: artifactPath, status: "missing", nodeCount: 0, edgeCount: 0, controlCount: 0, uncoveredNodeIds: [], uncoveredEdgeIds: [], platforms: [] } };
  const nodeCount = map.nodes?.length || 0;
  const lastRun = map.provenance?.lastRun || null;
  const inconclusive = nodeCount < 1 || lastRun?.inconclusive === true;
  return {
    map,
    summary: {
      path: artifactPath, status: inconclusive ? "inconclusive" : "observed", nodeCount, edgeCount: map.edges?.length || 0,
      controlCount: (map.nodes || []).reduce((total, node) => total + (node.controls?.length || 0), 0),
      uncoveredNodeIds: map.coverage?.uncoveredNodeIds || [], uncoveredEdgeIds: map.coverage?.uncoveredEdgeIds || [],
      platforms: map.app?.platforms || map.application?.platforms || [],
      ...(lastRun ? { lastRun } : {}),
      evidence: reviewedEvidence([artifactPath], nodeCount < 1 ? "artifact exists but contains no observed UI states" : lastRun?.inconclusive ? "runtime states were observed, but the latest exploration was explicitly inconclusive" : "grounded in prior runtime observations"),
    },
  };
}

function targetArtifactScope(target) {
  const source = posix(target.sourcePath || ".");
  if (target.platform === "ios" && /\.(?:xcodeproj|xcworkspace)$/.test(source)) return posix(path.dirname(source)) || ".";
  return source;
}

function uiMapTargetsTarget(map, target, targets) {
  const platforms = map?.app?.platforms || map?.application?.platforms || [];
  if (platforms.length && !platforms.includes(target.platform)) return false;
  const hint = String(map?.app?.target || map?.application?.target || "").trim();
  const identities = new Set([target.id, target.name, target.sourcePath, target.runtime?.applicationId, target.runtime?.bundleId, target.runtime?.ownedUrl].filter(Boolean).map(String));
  if (hint && identities.has(hint)) return true;
  return platforms.length === 1 && targets.filter((candidate) => candidate.platform === target.platform).length === 1;
}

function loadTargetUiMaps(root, targets) {
  const rootMap = loadUiMapAt(root, path.join(".autotap", "ui-map.json"));
  const records = targets.map((target) => {
    const scope = targetArtifactScope(target);
    const expectedPath = posix(path.join(scope === "." ? "" : scope, ".autotap", "ui-map.json"));
    let loaded = expectedPath === rootMap.summary.path ? rootMap : loadUiMapAt(root, expectedPath);
    if (!loaded.map && rootMap.map && (targets.length === 1 || uiMapTargetsTarget(rootMap.map, target, targets))) loaded = rootMap;
    return {
      targetId: target.id,
      targetName: target.name,
      platform: target.platform,
      expectedPath,
      map: loaded.map,
      summary: { ...loaded.summary, targetId: target.id, targetName: target.name, platform: target.platform, expectedPath },
    };
  });
  const unique = [];
  const seen = new Set();
  for (const record of records) {
    if (!record.map || seen.has(record.summary.path)) continue;
    seen.add(record.summary.path);
    unique.push(record);
  }
  if (!targets.length && rootMap.map) unique.push({ map: rootMap.map, summary: rootMap.summary });
  const allObserved = records.length > 0 && records.every((record) => record.summary.status === "observed");
  const someObserved = records.some((record) => record.summary.status === "observed");
  const someInconclusive = records.some((record) => record.summary.status === "inconclusive");
  const prefixCoverage = unique.length > 1;
  const coverageValues = (field) => unique.flatMap((record) => (record.summary[field] || []).map((id) => prefixCoverage ? `${record.summary.targetId}:${id}` : id));
  const summary = {
    path: unique.length === 1 ? unique[0].summary.path : ".autotap/ui-map.json",
    paths: unique.map((record) => record.summary.path).sort(),
    status: allObserved ? "observed" : someObserved ? "partial" : someInconclusive ? "inconclusive" : "missing",
    nodeCount: unique.reduce((total, record) => total + record.summary.nodeCount, 0),
    edgeCount: unique.reduce((total, record) => total + record.summary.edgeCount, 0),
    controlCount: unique.reduce((total, record) => total + record.summary.controlCount, 0),
    uncoveredNodeIds: coverageValues("uncoveredNodeIds"),
    uncoveredEdgeIds: coverageValues("uncoveredEdgeIds"),
    platforms: [...new Set(unique.flatMap((record) => record.summary.platforms || []))].sort(),
    observedTargetIds: records.filter((record) => record.summary.status === "observed").map((record) => record.targetId),
    missingTargetIds: records.filter((record) => record.summary.status !== "observed").map((record) => record.targetId),
    evidence: reviewedEvidence(unique.map((record) => record.summary.path), allObserved ? "every detected target has a grounded UI Map" : someObserved ? "some detected targets have grounded UI Maps; missing or inconclusive targets remain explicit" : "no detected target has a conclusive grounded UI Map"),
    ...(unique.length === 1 && unique[0].summary.lastRun ? { lastRun: unique[0].summary.lastRun } : {}),
  };
  const planningMap = rootMap.map || (targets.length === 1 ? records[0]?.map || null : null);
  return { map: planningMap, maps: records, summary };
}

function artifactScope(root, file) {
  const parts = relative(root, file).split("/");
  const index = parts.indexOf(".autotap");
  return index > 0 ? parts.slice(0, index).join("/") : ".";
}

function artifactFiles(root, inventory, kind, pattern) {
  return inventory.files.filter((file) => {
    const parts = relative(root, file).split("/");
    const index = parts.indexOf(".autotap");
    return index >= 0 && parts[index + 1] === kind && pattern.test(path.basename(file));
  }).sort();
}

function taskArtifacts(root, inventory) {
  const tasks = [];
  const errors = [];
  for (const file of artifactFiles(root, inventory, "tasks", /\.ya?ml$|\.json$/i)) {
    try { tasks.push({ ...loadTaskFile(file), __scope: artifactScope(root, file) }); }
    catch (error) { errors.push({ path: relative(root, file), error: error.message || String(error) }); }
  }
  return { tasks, errors };
}

async function contractArtifacts(root, inventory) {
  const files = artifactFiles(root, inventory, "contracts", /\.contract\.(?:ts|mts|mjs|js|json)$/i);
  const contracts = [];
  const errors = [];
  for (const file of files) {
    try { contracts.push({ ...await loadReleaseContractFile(file), __scope: artifactScope(root, file) }); }
    catch (error) { errors.push({ path: relative(root, file), error: error.message || String(error) }); }
  }
  return { contracts, errors };
}

function capabilityCriticality(name) {
  const key = semanticUiKey(name);
  if (/checkout|payment|purchase|revenue|order/.test(key)) return "critical";
  if (/auth|sign-in|account|message|publish|create|save/.test(key)) return "high";
  return "medium";
}

function entityFromTask(name) {
  const match = String(name || "").match(/^(?:add|archive|create|delete|edit|like|open|publish|remove|save|send|update|view)([A-Z].*)$/);
  if (!match) return "";
  const noun = match[1].replace(/To[A-Z].*$/, "").replace(/From[A-Z].*$/, "");
  if (!noun || /^(home|settings|profile|feed|conversation)$/i.test(noun)) return "";
  return humanize(noun).replace(/\bFirst\b/i, "").trim();
}

function taskNamesFromContract(contract) {
  return [...new Set((contract.steps || []).filter((step) => typeof step.task === "string").map((step) => step.task))];
}

function taskPlatforms(task, applicationPlatforms) {
  if (Array.isArray(task.steps) || task.implementations?.shared || task.implementations?.default) return applicationPlatforms;
  return Object.keys(task.implementations || {}).filter((platform) => ["ios", "android", "web"].includes(platform)).sort();
}

function safeTaskInputs(task) {
  return Object.fromEntries(Object.entries(task.inputs || {}).map(([name, value]) => {
    const definition = value && typeof value === "object" && !Array.isArray(value) ? value : { default: value };
    return [name, {
      required: definition.required !== false,
      secret: definition.secret === true,
      ...(!definition.secret && Object.hasOwn(definition, "default") ? { default: definition.default } : {}),
    }];
  }));
}

function applicationName(root, targets) {
  const pkg = readJson(path.join(root, "package.json"));
  return pkg?.name || (targets.length === 1 ? targets[0].name : path.basename(root));
}

export async function inspectApplicationRepository({ projectDir, ownedUrl = "", platform = "", targetValidation = null, outDir = ".autotap" } = {}) {
  const root = fs.realpathSync(path.resolve(projectDir || process.cwd()));
  const inventory = walk(root);
  let targets = [
    ...detectIosTargets(root, inventory),
    ...detectAndroidTargets(root, inventory),
    ...detectWebTargets(root, inventory, ownedUrl),
  ];
  if (platform) targets = targets.filter((target) => target.platform === platform);
  for (const priorValidation of persistedTargetValidations(root, outDir)) targets = applyRuntimeTargetValidation(root, targets, priorValidation);
  targets = applyRuntimeTargetValidation(root, targets, targetValidation);
  const { map, maps: uiMaps, summary: uiMap } = loadTargetUiMaps(root, targets);
  const { tasks, errors: taskErrors } = taskArtifacts(root, inventory);
  const { contracts, errors: contractErrors } = await contractArtifacts(root, inventory);
  const contractPathByName = new Map(contracts.map((contract) => [contract.name, relative(root, contract.__path)]));
  const projectConfiguration = readProjectConfig(root);

  const actorsByName = new Map();
  for (const [name, actor] of Object.entries(projectConfiguration.config?.actors || {})) {
    actorsByName.set(name, {
      name,
      roles: actor.role ? [actor.role] : [],
      contracts: [],
      credentialRequirements: Object.keys(actor.credentials || {}),
      credentialBindings: Object.fromEntries(Object.entries(actor.credentials || {}).map(([key, binding]) => [key, binding.env])),
      credentialsConfigured: Object.keys(actor.credentials || {}).length > 0,
      session: actor.session || "default",
      provisioning: actor.provisioning || "existing",
      configured: true,
      bindingConflicts: [],
    });
  }
  for (const contract of contracts) for (const [name, actor] of Object.entries(contract.actors || {})) {
    const prior = actorsByName.get(name) || { name, roles: [], contracts: [], credentialRequirements: [], credentialBindings: {}, configured: false, bindingConflicts: [] };
    if (actor.role && !prior.roles.includes(actor.role)) prior.roles.push(actor.role);
    if (!prior.contracts.includes(contract.name)) prior.contracts.push(contract.name);
    for (const key of Object.keys(actor.credentials || {})) if (!prior.credentialRequirements.includes(key)) prior.credentialRequirements.push(key);
    for (const [key, env] of Object.entries(credentialBindingsFromValue(actor.credentials))) {
      if (prior.credentialBindings[key] && prior.credentialBindings[key] !== env) prior.bindingConflicts.push({ credential: key, configuredEnv: prior.credentialBindings[key], contractEnv: env, contract: contract.name });
      else prior.credentialBindings[key] = env;
    }
    if (actor.session || !prior.configured) prior.session = actor.session || (Object.keys(contract.actors).length > 1 ? "isolated" : "default");
    prior.provisioning ||= "unknown";
    prior.credentialsConfigured ||= Object.keys(actor.credentials || {}).length > 0;
    actorsByName.set(name, prior);
  }
  const actors = [...actorsByName.values()].map((actor) => {
    const configuredPath = actor.configured ? [projectConfiguration.relativePath] : [];
    const paths = [...configuredPath, ...actor.contracts.map((name) => contractPathByName.get(name)).filter(Boolean)];
    return {
      ...actor,
      roles: actor.roles.sort(),
      contracts: actor.contracts.sort(),
      credentialRequirements: actor.credentialRequirements.sort(),
      credentialBindings: Object.fromEntries(Object.entries(actor.credentialBindings || {}).sort(([a], [b]) => a.localeCompare(b))),
      bindingConflicts: actor.bindingConflicts || [],
      evidence: reviewedEvidence(paths, actor.configured ? "actor, session, provisioning, and environment-variable names are explicit human configuration; credential values are never included" : "actor is derived from a reviewed contract; credential values intentionally omitted"),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const capabilities = new Map();
  const addCapability = (name, basis, sourcePath, task = "", contract = "") => {
    const key = semanticUiKey(name);
    if (!key || key === "unknown") return;
    const prior = capabilities.get(key) || { id: `capability_${key}`, name: humanize(name), status: basis, tasks: [], contracts: [], sourcePaths: [] };
    if (task && !prior.tasks.includes(task)) prior.tasks.push(task);
    if (contract && !prior.contracts.includes(contract)) prior.contracts.push(contract);
    if (sourcePath && !prior.sourcePaths.includes(sourcePath)) prior.sourcePaths.push(sourcePath);
    if (basis === "declared") prior.status = "declared";
    capabilities.set(key, prior);
  };
  for (const task of tasks) addCapability(task.name, "task-derived", relative(root, task.__path), task.name);
  for (const contract of contracts) {
    for (const name of contract.coverage?.capabilities || []) addCapability(name, "declared", relative(root, contract.__path), "", contract.name);
    for (const task of taskNamesFromContract(contract)) addCapability(task, "task-derived", relative(root, contract.__path), task, contract.name);
  }
  const capabilityList = [...capabilities.values()].map((item) => ({ ...item, tasks: item.tasks.sort(), contracts: item.contracts.sort(), sourcePaths: item.sourcePaths.sort(), evidence: item.status === "declared" ? reviewedEvidence(item.sourcePaths) : sourceEvidence(item.sourcePaths, "derived from a reusable Task name; requires review") })).sort((a, b) => a.id.localeCompare(b.id));

  const entitiesByName = new Map();
  const addEntity = (name, status, task = "", contract = "", sourcePath = "") => {
    const key = semanticUiKey(name);
    if (!key || key === "unknown") return;
    const prior = entitiesByName.get(key) || { id: `entity_${key}`, name: humanize(name), status, tasks: [], contracts: [], sourcePaths: [] };
    if (task && !prior.tasks.includes(task)) prior.tasks.push(task);
    if (contract && !prior.contracts.includes(contract)) prior.contracts.push(contract);
    if (sourcePath && !prior.sourcePaths.includes(sourcePath)) prior.sourcePaths.push(sourcePath);
    if (status === "declared") prior.status = "declared";
    entitiesByName.set(key, prior);
  };
  for (const task of tasks) {
    const entity = entityFromTask(task.name);
    if (entity) addEntity(entity, "task-derived", task.name, "", relative(root, task.__path));
  }
  for (const contract of contracts) for (const entity of contract.coverage?.entities || []) addEntity(entity, "declared", "", contract.name, relative(root, contract.__path));
  const entities = [...entitiesByName.values()].map((entity) => ({ ...entity, tasks: entity.tasks.sort(), contracts: entity.contracts.sort(), sourcePaths: entity.sourcePaths.sort(), evidence: entity.status === "declared" ? reviewedEvidence(entity.sourcePaths) : sourceEvidence(entity.sourcePaths, "noun derived from a reusable Task; requires review") })).sort((a, b) => a.id.localeCompare(b.id));

  const contractActors = (contract) => Object.entries(contract.actors || {}).map(([name, actor]) => ({
    name,
    session: actor.session || (Object.keys(contract.actors || {}).length > 1 ? "isolated" : "default"),
    credentialRequirements: Object.keys(actor.credentials || {}).sort(),
    credentialBindings: Object.fromEntries(Object.entries(credentialBindingsFromValue(actor.credentials)).sort(([a], [b]) => a.localeCompare(b))),
  })).sort((a, b) => a.name.localeCompare(b.name));

  const journeys = contracts.map((contract) => ({
    id: stableId("journey", `${contract.__scope}|${contract.name}`), name: contract.title, status: "authored-unvalidated", contract: contract.name, scope: contract.__scope,
    criticality: contract.criticality, businessValue: contract.businessValue, actors: Object.keys(contract.actors), tasks: taskNamesFromContract(contract),
    platforms: contract.platforms, evidence: reviewedEvidence([relative(root, contract.__path)], "committed contract exists; current-revision replay evidence is still required"),
  }));
  const revenuePaths = journeys.filter((journey) => /checkout|payment|purchase|revenue|order|subscription|pricing/i.test(`${journey.name} ${journey.businessValue}`)).map((journey) => ({ journeyId: journey.id, contract: journey.contract, status: journey.status, evidence: journey.evidence }));
  const systemInvariants = contracts.filter((contract) => Object.keys(contract.actors || {}).length > 1).map((contract) => ({
    id: stableId("invariant", `${contract.__scope}|${contract.name}`), name: contract.title, contract: contract.name, scope: contract.__scope, actors: Object.keys(contract.actors), status: "authored-unvalidated",
    evidence: reviewedEvidence([relative(root, contract.__path)], "cross-actor behavior is authored but requires current replay evidence"),
  }));

  const requirements = [];
  if (!targets.length) requirements.push({ id: "target", severity: "blocking", status: "missing", message: "No iOS application project, Android application module, or browser application target was detected.", remediation: "Pass the representative target explicitly or add its unavoidable build/runtime configuration." });
  for (const target of targets) {
    if (target.platform === "ios" && target.status !== "configured") requirements.push({ id: `${target.id}:scheme`, severity: "blocking", status: "needs-confirmation", message: `Confirm a shared build scheme for ${target.name}.`, remediation: `Run tapp build ${target.sourcePath} or provide the scheme during init/build.` });
    if (target.platform === "android" && !target.runtime.applicationId) requirements.push({ id: `${target.id}:application-id`, severity: "blocking", status: "missing", message: `Android application id was not statically detected for ${target.name}.`, remediation: "Provide --app-id or expose applicationId in the application module." });
    if (target.platform === "web" && !target.runtime.ownedUrl && target.runtime.management !== "tapp-managed") requirements.push({ id: `${target.id}:owned-url`, severity: "blocking", status: "missing", message: `No safe managed runtime or owned URL is available for ${target.name}.`, remediation: "Add a deterministic start/static target or start the app and rerun tapp init with --url http://127.0.0.1:<port>." });
    if (target.platform === "web" && target.build.dependencyStatus === "missing-lockfile") requirements.push({ id: `${target.id}:dependency-lock`, severity: "blocking", status: "missing", message: `${target.name} declares browser dependencies without an observed dependency lockfile.`, remediation: "Commit the package-manager lockfile so Tapp can install dependencies reproducibly, then rerun tapp init." });
  }
  const incompleteMaps = uiMaps.filter((record) => record.summary.status !== "observed");
  for (const record of incompleteMaps.length ? incompleteMaps : (!targets.length && uiMap.status !== "observed" ? [{ summary: uiMap }] : [])) {
    const target = record.targetId ? targets.find((candidate) => candidate.id === record.targetId) : null;
    const summary = record.summary;
    requirements.push({
      id: targets.length <= 1 ? "ui-map" : `${target.id}:ui-map`, severity: "blocking", status: summary.status === "inconclusive" ? "inconclusive" : "missing",
      message: target ? (summary.status === "inconclusive" ? `The UI Map for ${target.name} is inconclusive.` : `No grounded UI Map exists for ${target.name}.`) : "No repository UI Map has been grounded in a real run.",
      remediation: target ? `Build/launch ${target.name}, explore the real target, and retain its map at ${summary.expectedPath || summary.path}.` : "Build/launch the target and run tapp init --explore so real exploration evidence is merged into .autotap/ui-map.json.",
    });
  }
  if (!contracts.length) requirements.push({ id: "contracts", severity: "warning", status: "missing", message: "No reviewed release contracts exist yet.", remediation: "Review the proposed release plan, then generate and validate a compact set of contracts." });
  if (!actors.length) requirements.push({ id: "actors", severity: "warning", status: "unknown", message: "No user roles or actors are represented in reviewed artifacts.", remediation: "Provide test actors/roles when the product has authentication or cross-user behavior." });
  for (const error of projectConfiguration.errors) requirements.push({ id: stableId("project-config-error", error), severity: "blocking", status: "invalid", message: error, remediation: `Fix ${projectConfiguration.relativePath}; actor configuration must contain environment-variable bindings, never credential values.` });
  for (const actor of actors) {
    const missingBindings = actor.credentialRequirements.filter((credential) => !actor.credentialBindings[credential]);
    if (missingBindings.length) requirements.push({ id: `actor:${actor.name}:credential-bindings`, severity: "blocking", status: "missing", message: `Actor '${actor.name}' has unbound credential requirements: ${missingBindings.join(", ")}.`, remediation: `Run tapp actor set ${actor.name} --credential <name>=<ENV_NAME> for each credential, then replace any literal contract credentials with $ENV_NAME placeholders.` });
    if (actor.bindingConflicts.length) requirements.push({ id: `actor:${actor.name}:credential-conflicts`, severity: "blocking", status: "conflict", message: `Actor '${actor.name}' has conflicting credential environment bindings.`, remediation: `Align ${projectConfiguration.relativePath} and reviewed contracts; Tapp will not guess which secret binding is correct.` });
  }
  for (const error of taskErrors) requirements.push({ id: stableId("task-error", error.path), severity: "blocking", status: "invalid", message: error.error, remediation: `Fix ${error.path} before generation.` });
  for (const error of contractErrors) requirements.push({ id: stableId("contract-error", error.path), severity: "blocking", status: "invalid", message: error.error, remediation: `Fix ${error.path} before trusting the release plan.` });

  const model = {
    schemaVersion: 1, kind: "tapp-application-model",
    application: { name: applicationName(root, targets), repositoryRoot: ".", platforms: [...new Set(targets.map((target) => target.platform))].sort(), targetIds: targets.map((target) => target.id) },
    targets,
    actors,
    entities,
    capabilities: capabilityList,
    criticalJourneys: journeys,
    revenuePaths,
    systemInvariants,
    configuration: {
      path: projectConfiguration.relativePath,
      status: projectConfiguration.errors.length ? "invalid" : projectConfiguration.exists ? "configured" : "missing",
      actorCount: Object.keys(projectConfiguration.config?.actors || {}).length,
      lifecycle: {
        setupSteps: projectConfiguration.config?.lifecycle?.setup?.length || 0,
        teardownSteps: projectConfiguration.config?.lifecycle?.teardown?.length || 0,
      },
      evidence: projectConfiguration.exists ? reviewedEvidence([projectConfiguration.relativePath], "explicit human configuration; only environment-variable names are included in the application model") : sourceEvidence([], "optional project configuration has not been created"),
    },
    environments: targets.map((target) => ({ targetId: target.id, platform: target.platform, status: target.status, runtime: target.runtime })),
    stateBoundaries: actors.length > 1 ? [{ kind: "actor-session", isolation: "required", actors: actors.map((actor) => actor.name) }] : [],
    uiMap,
    uiMaps: uiMaps.map((record) => record.summary),
    artifacts: { tasks: tasks.map((task) => ({ id: stableId("task", relative(root, task.__path)), name: task.name, scope: task.__scope, path: relative(root, task.__path), version: task.version, platforms: taskPlatforms(task, [...new Set(targets.map((target) => target.platform))].sort()), inputs: safeTaskInputs(task) })), contracts: contracts.map((contract) => ({ id: stableId("contract", relative(root, contract.__path)), name: contract.name, scope: contract.__scope, path: relative(root, contract.__path), criticality: contract.criticality, platforms: contract.platforms, actors: contractActors(contract) })) },
    requirements,
    provenance: {
      generatedBy: "tapp-init", generatedAt: new Date().toISOString(), remoteAiUsed: false,
      distinctions: ["runtime-observed", "source-observed", "reviewed-artifact", "source-derived-proposal", "human-decision"],
    },
  };
  return { root, model, map, maps: uiMaps.map((record) => ({ targetId: record.targetId, path: record.summary.path, map: record.map })), tasks, contracts, projectConfiguration };
}

function candidateFromTask(task, capability, platforms, actor) {
  return {
    id: stableId("proposal", `task|${task.path}`), kind: "release-contract", name: `${task.name}Works`, title: `${humanize(task.name)} remains available`, scope: task.scope,
    origin: "deterministic-source-proposal", decision: "pending", criticality: capabilityCriticality(task.name),
    businessValue: `Protect the reviewed ${humanize(task.name).toLowerCase()} capability through its reusable Task.`, actors: [actor], tasks: [task.name], platforms: task.platforms?.length ? task.platforms : platforms,
    taskInputs: { [task.name]: task.inputs || {} },
    risk: "The Task exists but is not composed by a reviewed release contract.", groundedBy: [{ type: "task", path: task.path }, { type: "capability", id: capability?.id || `capability_${semanticUiKey(task.name)}` }],
    requiredValidation: "Compile and replay against the real target before approval or commit.",
  };
}

export function releasePlanCandidateFromUiMapNode(node, platforms, actor = "customer", { scope = ".", targetId = "", mapPath = "" } = {}) {
  const displayName = node.stateLabel || node.name;
  return {
    id: stableId("proposal", `node|${targetId}|${node.id}`), kind: "release-contract", name: `${semanticUiKey(displayName).replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Reachable`, title: `${displayName} remains reachable`, scope,
    origin: "deterministic-ui-map-proposal", decision: "pending", criticality: capabilityCriticality(node.name),
    businessValue: `Protect access to the observed ${displayName} product surface.`, actors: [actor], tasks: [], platforms: node.platforms?.length ? node.platforms : platforms,
    risk: "Observed UI behavior is not covered by a reviewed Task or release contract.", groundedBy: [{ type: "ui-map-node", id: node.id, observationCount: node.observation?.count || 0, ...(targetId ? { targetId } : {}), ...(mapPath ? { mapPath } : {}) }],
    requiredValidation: "Author reusable Tasks for observed transitions, then compile and replay the contract against the real target.",
  };
}

function taskScreenCondition(task, phase) {
  const condition = (task[phase] || []).find((item) => item && typeof item === "object" && typeof item.screen === "string");
  return condition?.screen || "";
}

function crossActorVisibleOutput(task) {
  const entity = entityFromTask(task.name);
  if (!/^(announcement|comment|content|listing|post|update)$/i.test(entity)) return null;
  for (const [output, definition] of Object.entries(task.outputs || {})) {
    const input = definition?.fromInput;
    if (!input || task.inputs?.[input]?.secret === true) continue;
    const visible = (task.postconditions || []).some((condition) => condition?.exists === `{{${input}}}`);
    if (visible) return { entity, input, output };
  }
  return null;
}

function configuredActorPair(model) {
  const actors = (model.actors || []).filter((actor) => actor.configured && actor.session === "isolated" && actor.credentialBindings?.email && actor.credentialBindings?.password);
  for (let left = 0; left < actors.length; left += 1) for (let right = left + 1; right < actors.length; right += 1) {
    const sharedRole = actors[left].roles.find((role) => actors[right].roles.includes(role));
    if (sharedRole) return { actors: [actors[left], actors[right]], role: sharedRole };
  }
  return null;
}

function crossActorProposals({ model, tasks, contracts, projectConfiguration }) {
  if (!model.application.platforms.includes("web") || projectConfiguration?.errors?.length) return [];
  const lifecycle = projectConfiguration?.config?.lifecycle || {};
  if (!(lifecycle.setup?.length && lifecycle.teardown?.length)) return [];
  const pair = configuredActorPair(model);
  if (!pair) return [];
  const existingMultiActorTasks = new Set(contracts.filter((contract) => Object.keys(contract.actors || {}).length > 1).flatMap(taskNamesFromContract));
  const artifacts = new Map(model.artifacts.tasks.map((task) => [`${task.scope}|${task.name}`, task]));
  const proposals = [];
  for (const producer of tasks) {
    const output = crossActorVisibleOutput(producer);
    if (!output || existingMultiActorTasks.has(producer.name)) continue;
    const producerPlatforms = taskPlatforms(producer, model.application.platforms);
    if (!producerPlatforms.includes("web")) continue;
    const producerEntry = taskScreenCondition(producer, "preconditions");
    if (!producerEntry) continue;
    const authentication = tasks.find((candidate) => {
      if (candidate.__scope !== producer.__scope || !/^(authenticate|logIn|signIn)/.test(candidate.name)) return false;
      if (!taskPlatforms(candidate, model.application.platforms).includes("web")) return false;
      if (candidate.inputs?.email?.secret !== true || candidate.inputs?.password?.secret !== true) return false;
      return semanticUiKey(taskScreenCondition(candidate, "postconditions")) === semanticUiKey(producerEntry);
    });
    if (!authentication) continue;
    const producerArtifact = artifacts.get(`${producer.__scope}|${producer.name}`);
    const authArtifact = artifacts.get(`${authentication.__scope}|${authentication.name}`);
    if (!producerArtifact || !authArtifact) continue;
    const [creator, observer] = pair.actors.map((actor) => actor.name);
    const entityKey = semanticUiKey(output.entity);
    const entityCamel = entityKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const suffix = crypto.createHash("sha256").update(`${producer.__scope}|${producer.name}|${output.output}`).digest("hex").slice(0, 6);
    const value = `Tapp cross-actor ${output.entity.toLowerCase()} ${suffix}`;
    const sharedVariable = `SHARED_${entityKey.replaceAll("-", "_").toUpperCase()}`;
    proposals.push({
      id: stableId("proposal", `cross-actor|${producer.__scope}|${producer.name}|${creator}|${observer}`),
      kind: "release-contract",
      name: `${entityCamel}PropagatesAcrossActors`,
      title: `${output.entity} created by one ${pair.role} becomes visible to another`,
      scope: producer.__scope,
      origin: "deterministic-cross-actor-proposal",
      decision: "pending",
      criticality: "high",
      businessValue: `Protect cross-account ${output.entity.toLowerCase()} propagation between isolated ${pair.role} sessions.`,
      actors: [creator, observer],
      tasks: [authentication.name, producer.name],
      platforms: ["web"],
      policy: { always: true, prRelevant: true, nightly: true, tags: ["multi-actor", entityKey, "propagation"] },
      taskInputs: { [authentication.name]: safeTaskInputs(authentication), [producer.name]: safeTaskInputs(producer) },
      constraints: { inputs: { [producer.name]: { [output.input]: value } } },
      lifecycleSource: "project-config",
      journeySteps: [
        { actor: creator, task: authentication.name, with: { email: "$EMAIL", password: "$PASSWORD" }, reason: `${humanize(creator)} needs an isolated authenticated session.` },
        { actor: observer, task: authentication.name, with: { email: "$EMAIL", password: "$PASSWORD" }, reason: `${humanize(observer)} must not share ${humanize(creator)}'s session.` },
        { actor: creator, task: producer.name, with: { [output.input]: value }, save: { [output.output]: sharedVariable } },
        { actor: observer, expect: { exists: `$${sharedVariable}`, eventually: { timeoutMs: 10000, pollMs: 250 } }, reason: `The observed Task output must propagate across isolated accounts within a bounded interval.` },
      ],
      risk: `The producer Task proves local creation, but no reviewed contract proves another isolated ${pair.role} can observe its output.`,
      groundedBy: [
        { type: "actor-config", path: projectConfiguration.relativePath, actors: [creator, observer], role: pair.role },
        { type: "lifecycle", path: projectConfiguration.relativePath, setupSteps: lifecycle.setup.length, teardownSteps: lifecycle.teardown.length },
        { type: "task", path: authArtifact.path, task: authentication.name },
        { type: "task-output", path: producerArtifact.path, task: producer.name, input: output.input, output: output.output, postcondition: `exists {{${output.input}}}` },
        { type: "capability", id: `capability_${semanticUiKey(producer.name)}`, name: producer.name },
      ],
      requiredValidation: "Compile to an isolated deterministic Scenario and replay against the real shared backend before approval or commit.",
    });
  }
  return proposals;
}

function observedScreenNode(map, screen) {
  const key = semanticUiKey(screen);
  return (map?.nodes || []).find((node) => node.status === "observed" && (node.semanticKey === key || semanticUiKey(node.name) === key));
}

function durableCheckoutOutput(task) {
  if (!/^(?:completeCheckout|checkout|placeOrder|purchase|submitOrder)$/i.test(String(task.name || ""))) return null;
  for (const [output, definition] of Object.entries(task.outputs || {})) {
    const input = definition?.fromInput;
    const inputDefinition = task.inputs?.[input];
    if (!input || !inputDefinition || inputDefinition.secret === true || !Object.hasOwn(inputDefinition, "default")) continue;
    const value = inputDefinition.default;
    if (typeof value !== "string" || !value.trim()) continue;
    const visible = (task.postconditions || []).some((condition) => condition?.exists === `{{${input}}}`);
    if (visible) return { input, output, value };
  }
  return null;
}

function durableBusinessProposals({ model, map, tasks, contracts, projectConfiguration }) {
  if (!model.application.platforms.includes("web") || projectConfiguration?.errors?.length) return [];
  const lifecycle = projectConfiguration?.config?.lifecycle || {};
  if (!(lifecycle.setup?.length && lifecycle.teardown?.length)) return [];
  const actor = (model.actors || []).find((candidate) => candidate.configured && candidate.session === "default") || model.actors?.[0];
  if (!actor) return [];
  const contractedTasks = new Set(contracts.flatMap(taskNamesFromContract));
  const artifacts = new Map(model.artifacts.tasks.map((task) => [`${task.scope}|${task.name}`, task]));
  const proposals = [];
  for (const producer of tasks) {
    const output = durableCheckoutOutput(producer);
    if (!output || contractedTasks.has(producer.name) || !taskPlatforms(producer, model.application.platforms).includes("web")) continue;
    const entryScreen = taskScreenCondition(producer, "preconditions");
    const confirmationScreen = taskScreenCondition(producer, "postconditions");
    const verifier = tasks.find((candidate) => {
      if (candidate.__scope !== producer.__scope || contractedTasks.has(candidate.name)) return false;
      if (!/^(?:open|view)(?:OrderHistory|Orders|Purchases)$/i.test(candidate.name)) return false;
      if (!taskPlatforms(candidate, model.application.platforms).includes("web")) return false;
      return Object.values(safeTaskInputs(candidate)).every((definition) => definition.required === false || Object.hasOwn(definition, "default"));
    });
    if (!entryScreen || !confirmationScreen || !verifier) continue;
    const historyScreen = taskScreenCondition(verifier, "postconditions");
    const nodes = [observedScreenNode(map, entryScreen), observedScreenNode(map, confirmationScreen), observedScreenNode(map, historyScreen)];
    if (!historyScreen || nodes.some((node) => !node)) continue;
    const producerArtifact = artifacts.get(`${producer.__scope}|${producer.name}`);
    const verifierArtifact = artifacts.get(`${verifier.__scope}|${verifier.name}`);
    if (!producerArtifact || !verifierArtifact) continue;
    const sharedVariable = "ORDERED_ITEM";
    proposals.push({
      id: stableId("proposal", `durable-checkout|${producer.__scope}|${producer.name}|${verifier.name}|${actor.name}`),
      kind: "release-contract",
      name: "checkoutCreatesDurableOrder",
      title: "Checkout creates an order that remains in order history",
      scope: producer.__scope,
      origin: "deterministic-business-effect-proposal",
      decision: "pending",
      criticality: "critical",
      businessValue: "Protect the revenue path and prove its resulting order survives navigation into customer order history.",
      actors: [actor.name],
      tasks: [producer.name, verifier.name],
      platforms: ["web"],
      policy: { always: true, prRelevant: true, nightly: true, tags: ["revenue", "checkout", "order", "persistence"] },
      taskInputs: { [producer.name]: safeTaskInputs(producer), [verifier.name]: safeTaskInputs(verifier) },
      constraints: { inputs: { [producer.name]: { [output.input]: output.value } } },
      lifecycleSource: "project-config",
      journeySteps: [
        { actor: actor.name, task: producer.name, with: { [output.input]: output.value }, save: { [output.output]: sharedVariable }, reason: "Complete the reviewed representative revenue path from controlled state." },
        { actor: actor.name, task: verifier.name, reason: "Navigate away from confirmation and reopen the durable system record." },
        { actor: actor.name, expect: { exists: `$${sharedVariable}`, eventually: { timeoutMs: 10000, pollMs: 250 } }, reason: "The purchased item must remain observable in order history within a bounded interval." },
      ],
      risk: "A confirmation screen can pass even when checkout fails to create a durable order record.",
      groundedBy: [
        { type: "lifecycle", path: projectConfiguration.relativePath, setupSteps: lifecycle.setup.length, teardownSteps: lifecycle.teardown.length },
        { type: "task-output", path: producerArtifact.path, task: producer.name, input: output.input, output: output.output, postcondition: `exists {{${output.input}}}` },
        { type: "task", path: verifierArtifact.path, task: verifier.name, postcondition: `screen ${historyScreen}` },
        ...nodes.map((node) => ({ type: "ui-map-node", id: node.id, observationCount: node.observation?.count || 0 })),
        { type: "capability", id: "capability_checkout", name: "checkout" },
        { type: "capability", id: "capability_order-creation", name: "order creation" },
        { type: "capability", id: "capability_order-persistence", name: "order persistence" },
      ],
      requiredValidation: "Replay from deterministic reset through order history on the real backend before approval or commit.",
    });
  }
  return proposals;
}

export function isBusinessUiMapNode(node) {
  const key = semanticUiKey(`${node.name} ${(node.roles || []).join(" ")}`);
  if (/error|blank|loading|not-found|debug|changelog|feature|system-status/.test(key)) return false;
  if (/account|admin|cart|checkout|dashboard|feed|home|inbox|login|message|onboard|order|payment|plan|price|pricing|product|profile|register|search|settings|sign-in|subscribe/.test(key)) return true;
  const controls = node.controls || [];
  const fields = controls.filter((control) => /field|input|select|checkbox|radio/i.test(control.kind)).length;
  const actions = controls.filter((control) => /button/i.test(control.kind)).length;
  return fields > 0 && actions > 0;
}

export function proposeReleasePlan({ model, map, maps = [], tasks, contracts, projectConfiguration, maxContracts = 15 } = {}) {
  const defaultActor = model.actors?.find((actor) => actor.session === "default")?.name || model.actors?.[0]?.name || "customer";
  const items = contracts.map((contract) => {
    const artifact = model.artifacts.contracts.find((item) => item.name === contract.name && item.scope === contract.__scope);
    return {
      id: artifact?.id || stableId("contract", `${contract.__scope}|${contract.name}`), kind: "release-contract", name: contract.name, title: contract.title, scope: contract.__scope,
      origin: "committed", decision: "accepted", criticality: contract.criticality, businessValue: contract.businessValue,
      actors: Object.keys(contract.actors), tasks: taskNamesFromContract(contract), platforms: contract.platforms,
      risk: "Business guarantee regresses or becomes inconclusive.", groundedBy: [{ type: "contract", path: artifact?.path }],
      requiredValidation: "Replay on the current target revision; committed status alone is not execution proof.",
    };
  });
  for (const proposal of durableBusinessProposals({ model, map, tasks, contracts, projectConfiguration })) {
    if (items.length >= maxContracts) break;
    items.push(proposal);
  }
  for (const proposal of crossActorProposals({ model, tasks, contracts, projectConfiguration })) {
    if (items.length >= maxContracts) break;
    items.push(proposal);
  }
  const contractedTasks = new Set(items.flatMap((item) => item.tasks.map((task) => `${item.scope}|${task}`)));
  const capabilityByTask = new Map(model.capabilities.flatMap((capability) => capability.tasks.map((task) => [task, capability])));
  for (const task of model.artifacts.tasks) {
    if (items.length >= maxContracts || contractedTasks.has(`${task.scope}|${task.name}`)) continue;
    items.push(candidateFromTask(task, capabilityByTask.get(task.name), model.application.platforms, defaultActor));
  }
  const scopedMaps = maps.some((entry) => entry.map)
    ? maps.filter((entry) => entry.map).map((entry) => ({ ...entry, target: model.targets.find((target) => target.id === entry.targetId) }))
    : map ? [{ map, path: model.uiMap.path, target: null }] : [];
  for (const entry of scopedMaps) for (const node of entry.map.nodes || []) {
    if (items.length >= maxContracts) break;
    if ((node.coveredBy?.tasks || []).length || (node.coveredBy?.contracts || []).length) continue;
    if (!isBusinessUiMapNode(node)) continue;
    if (items.some((item) => item.groundedBy.some((ground) => ground.type === "ui-map-node" && ground.id === node.id && (!entry.targetId || ground.targetId === entry.targetId)))) continue;
    const scope = entry.target ? targetArtifactScope(entry.target) : ".";
    items.push(releasePlanCandidateFromUiMapNode(node, entry.target ? [entry.target.platform] : model.application.platforms, defaultActor, { scope, targetId: model.targets.length > 1 ? entry.targetId || "" : "", mapPath: entry.path || model.uiMap.path }));
  }
  return {
    schemaVersion: 1, kind: "tapp-release-plan", application: model.application,
    status: items.some((item) => item.decision === "pending") ? "awaiting-review" : "reviewed",
    policy: { targetCount: "approximately 5–15 when grounded evidence supports it", maximum: maxContracts, compactOverExhaustive: true, deterministicReplayRequired: true, aiAssertionsDefault: false },
    items,
    coverageGaps: { unknownRequirements: model.requirements.filter((item) => ["missing", "unknown", "needs-confirmation"].includes(item.status)).map((item) => item.id), uncoveredUiMapNodes: model.uiMap.uncoveredNodeIds, uncoveredUiMapEdges: model.uiMap.uncoveredEdgeIds },
    review: { instructions: "Approve, reject, defer, reprioritize, or constrain pending items before generation. Existing committed contracts remain accepted but still require current replay evidence.", reviewedAt: null },
    provenance: { generatedBy: "tapp-init", generatedAt: new Date().toISOString(), remoteAiUsed: false, groundedOnly: true },
  };
}

function invalidatedGeneration(generation) {
  if (!generation || generation.status === "blocked" || !generation.path) return generation;
  return {
    ...generation,
    status: "requires-revalidation",
    trusted: false,
    replayRequired: true,
    validationStale: true,
    ...(generation.realValidation ? { previousValidation: generation.realValidation, realValidation: {} } : {}),
  };
}

function mergePlanDecisions(next, prior, { invalidateValidation = false } = {}) {
  if (!prior || prior.schemaVersion !== 1 || prior.kind !== "tapp-release-plan") return next;
  const priorItems = new Map((prior.items || []).map((item) => [item.id, item]));
  const priorByNameScope = new Map();
  for (const item of prior.items || []) {
    const key = `${item.scope || "."}|${item.name}`;
    const list = priorByNameScope.get(key) || [];
    list.push(item);
    priorByNameScope.set(key, list);
  }
  const consumedPriorIds = new Set();
  const carried = next.items.map((item) => {
    const exact = priorItems.get(item.id);
    const lineage = item.origin === "committed"
      ? (priorByNameScope.get(`${item.scope || "."}|${item.name}`) || []).find((candidate) => candidate.origin === "promoted-validated" || candidate.generation?.status === "promoted")
      : null;
    const previous = exact || lineage;
    if (!previous) return item;
    consumedPriorIds.add(previous.id);
    if (exact && lineage && exact.id !== lineage.id) consumedPriorIds.add(lineage.id);
    const human = {};
    for (const key of ["decision", "criticality", "reviewNotes", "constraints", "reviewedBy", "reviewedAt"]) if (previous[key] !== undefined) human[key] = previous[key];
    const generationSource = exact?.generation || lineage?.generation || previous.generation;
    const taskSource = exact?.generation?.tasks ? exact : lineage?.generation?.tasks ? lineage : previous;
    if (generationSource !== undefined) human.generation = invalidateValidation ? invalidatedGeneration(generationSource) : generationSource;
    if (taskSource.generation?.tasks && taskSource.tasks !== undefined) human.tasks = taskSource.tasks;
    if (taskSource.generation?.tasks && taskSource.taskInputs !== undefined) human.taskInputs = taskSource.taskInputs;
    // A reviewed proposal becomes a committed contract without becoming a different
    // customer decision. Preserve its original plan identity so browser links, CLI
    // item selectors, and review history remain stable across promotion refreshes.
    return { ...item, id: previous.id, ...human };
  });
  const currentIds = new Set(carried.map((item) => item.id));
  for (const previous of prior.items || []) if (!currentIds.has(previous.id) && !consumedPriorIds.has(previous.id) && previous.decision && previous.decision !== "pending") carried.push({ ...previous, stale: true, status: "not-derived-on-refresh" });
  let generation = prior.generation;
  if (invalidateValidation && generation) generation = {
    ...generation,
    generatedTasks: (generation.generatedTasks || []).map(invalidatedGeneration),
    generated: (generation.generated || []).map(invalidatedGeneration),
    invalidatedAt: new Date().toISOString(),
    invariant: "A new runtime exploration invalidated prior draft trust; preserved evidence is historical and every affected platform must replay.",
  };
  return {
    ...next,
    ...(generation ? { generation } : {}),
    items: carried,
    status: carried.some((item) => item.decision === "pending") ? "awaiting-review" : "reviewed",
    review: { ...next.review, ...(prior.review || {}) },
  };
}

function invalidateGeneratedTaskFiles(root, plan) {
  for (const record of plan.generation?.generatedTasks || []) {
    if (!record.path) continue;
    const absolute = path.resolve(root, record.path);
    const proposalRoot = path.join(root, ".autotap", "proposals", "tasks");
    if (!isInsideRoot(proposalRoot, absolute) || !fs.existsSync(absolute)) continue;
    const task = readJson(absolute);
    if (!task || task.generation?.origin !== "deterministic-ui-map") continue;
    task.generation = invalidatedGeneration({ ...task.generation, path: record.path });
    delete task.generation.path;
    const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, JSON.stringify(task, null, 2) + "\n");
    fs.renameSync(temporary, absolute);
  }
}

export function writeInitArtifacts({ root, model, plan, outDir = ".autotap", refresh = false, invalidateValidation = false } = {}) {
  const directory = path.resolve(root, outDir);
  const modelPath = path.join(directory, "application-model.json");
  const planPath = path.join(directory, "release-plan.json");
  if (!refresh && (fs.existsSync(modelPath) || fs.existsSync(planPath))) throw new Error(`Init artifacts already exist under ${relative(root, directory)}; inspect them or rerun with --refresh to preserve reviewed decisions while updating evidence`);
  const priorPlan = refresh && fs.existsSync(planPath) ? readJson(planPath) : null;
  const mergedPlan = mergePlanDecisions(plan, priorPlan, { invalidateValidation });
  if (invalidateValidation) invalidateGeneratedTaskFiles(root, mergedPlan);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(modelPath, JSON.stringify(model, null, 2) + "\n");
  fs.writeFileSync(planPath, JSON.stringify(mergedPlan, null, 2) + "\n");
  return { modelPath, planPath, plan: mergedPlan };
}

export function reviewReleasePlan(plan, { approve = [], reject = [], defer = [] } = {}) {
  const choices = new Map();
  for (const [decision, values] of Object.entries({ approved: approve, rejected: reject, deferred: defer })) {
    for (const value of values || []) {
      if (choices.has(value)) throw new Error(`Plan item '${value}' received more than one decision`);
      choices.set(value, decision);
    }
  }
  const matched = new Set();
  const items = (plan.items || []).map((item) => {
    const decision = choices.get(item.id) || choices.get(item.name);
    if (!decision) return item;
    matched.add(choices.has(item.id) ? item.id : item.name);
    return { ...item, decision, reviewedAt: new Date().toISOString() };
  });
  const missing = [...choices.keys()].filter((key) => !matched.has(key));
  if (missing.length) throw new Error(`Unknown plan item(s): ${missing.join(", ")}`);
  return { ...plan, items, status: items.some((item) => item.decision === "pending") ? "awaiting-review" : "reviewed", review: { ...(plan.review || {}), reviewedAt: new Date().toISOString() } };
}

function kebab(value) {
  return String(value || "contract").replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

function pascalSemantic(value) {
  return semanticUiKey(value).split("-").filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join("") || "Screen";
}

function edgeSupportsPlatform(edge, nodes, platform) {
  if (Array.isArray(edge.platforms) && edge.platforms.length) return edge.platforms.includes(platform);
  const from = nodes.get(edge.from);
  const to = nodes.get(edge.to);
  return (!from?.platforms?.length || from.platforms.includes(platform)) && (!to?.platforms?.length || to.platforms.includes(platform));
}

function shortestObservedPath(map, platform, targetId, { startNodeId } = {}) {
  const nodes = new Map((map.nodes || []).map((node) => [node.id, node]));
  const entryId = startNodeId || map.app?.navigationRoots?.[platform] || map.app?.entryNodes?.[platform];
  if (!entryId || !nodes.has(entryId)) throw new Error(`UI Map has no observed ${platform} navigation root; rerun tapp init --refresh --explore before generating Tasks`);
  if (!nodes.has(targetId)) throw new Error(`UI Map proposal target '${targetId}' is no longer present`);
  if (entryId === targetId) return [];
  const outgoing = new Map();
  for (const edge of (map.edges || []).filter((item) => item.status === "observed" && edgeSupportsPlatform(item, nodes, platform))) {
    const list = outgoing.get(edge.from) || [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  for (const list of outgoing.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  const queue = [{ nodeId: entryId, path: [] }];
  const seen = new Set([entryId]);
  while (queue.length) {
    const current = queue.shift();
    for (const edge of outgoing.get(current.nodeId) || []) {
      const nextPath = [...current.path, edge];
      if (edge.to === targetId) return nextPath;
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push({ nodeId: edge.to, path: nextPath });
      }
    }
  }
  throw new Error(`No observed ${platform} path connects the entry state to the approved UI Map proposal`);
}

function reviewedEntryToNavigationRootTasks(map, platform, existingTasks) {
  const entryId = map.app?.entryNodes?.[platform];
  const rootId = map.app?.navigationRoots?.[platform] || entryId;
  if (!entryId || !rootId || entryId === rootId) return [];
  const path = shortestObservedPath(map, platform, rootId, { startNodeId: entryId });
  const sequence = [];
  for (const edge of path) {
    const reviewed = (edge.coveredBy?.tasks || []).find((name) => existingTasks.has(name));
    if (!reviewed) {
      throw new Error(`Observed ${platform} launch entry requires a reviewed Task before deterministic replay can reach the navigation root`);
    }
    if (sequence.at(-1) !== reviewed) sequence.push(reviewed);
  }
  return sequence;
}

function generatedActionSteps(edge, nodes) {
  const from = nodes.get(edge.from);
  const to = nodes.get(edge.to);
  const action = String(edge.action?.type || "tap").toLowerCase();
  const target = String(edge.action?.target || "").trim();
  let step;
  if (["tap", "open", "login"].includes(action) && target) step = { tap: target };
  else if (action === "back") step = { back: true };
  else throw new Error(`Observed edge '${edge.id}' uses unsupported generated action '${action || "unknown"}'`);
  const inputs = {};
  const preparation = [];
  for (const action of edge.preparation || []) {
    if (action.type !== "type" || !action.target) throw new Error(`Observed edge '${edge.id}' has unsupported preparation evidence`);
    let value = "Tapp test";
    if (action.valueSource === "test-email") {
      inputs.email = { required: true, secret: true };
      value = "{{email}}";
    } else if (action.valueSource === "test-password") {
      inputs.password = { required: true, secret: true };
      value = "{{password}}";
    } else if (action.valueSource !== "generated-text") throw new Error(`Observed edge '${edge.id}' has an unknown preparation value source`);
    preparation.push({ wait_for: action.target }, { type: { field: action.target, value } });
  }
  return { inputs, steps: [
    { action: "assert_screen", target: from.name },
    ...preparation,
    ...(["tap", "open", "login"].includes(action) ? [{ wait_for: target }] : []),
    step,
    { wait_for: to.name },
  ] };
}

function generatedTaskName(node, entryOnly, occupied, identity) {
  const base = `${entryOnly ? "confirm" : "open"}${pascalSemantic(node.name)}${entryOnly ? "Available" : ""}`;
  if (!occupied.has(base) || occupied.get(base) === identity) return base;
  return `${base}${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 6)}`;
}

function prepareMapBackedItem(item, map, existingTasks, taskDrafts, { targetId = "", mapPath = ".autotap/ui-map.json" } = {}) {
  const ground = (item.groundedBy || []).find((entry) => entry.type === "ui-map-node");
  if (!ground) throw new Error("Approved UI-only proposal is not grounded by a UI Map node");
  const nodes = new Map((map.nodes || []).map((node) => [node.id, node]));
  const target = nodes.get(ground.id);
  if (!target) throw new Error(`Approved UI Map state '${ground.id}' is no longer present`);
  const occupied = new Map([...existingTasks.keys()].map((name) => [name, `reviewed:${name}`]));
  for (const [name, draft] of taskDrafts) occupied.set(name, draft.identity);
  const platformSequences = new Map();
  const sourcePaths = [...new Set((item.groundedBy || []).filter((ground) => ground.type === "pr-exploration" && ground.provenance === "runtime-observed").flatMap((ground) => ground.changedFiles || []))].sort();

  for (const platform of item.platforms || []) {
    const path = shortestObservedPath(map, platform, target.id);
    // Autonomous exploration normalizes to navigationRoots, but committed
    // contract replay starts at the real launch entry. Reuse reviewed Tasks
    // for that prefix so a generated draft remains valid on a fresh CI run.
    const sequence = reviewedEntryToNavigationRootTasks(map, platform, existingTasks);
    if (!path.length) {
      const identity = `${targetId}|entry|${target.semanticKey}`;
      const name = generatedTaskName(target, true, occupied, identity);
      let draft = taskDrafts.get(name);
      if (!draft) {
        draft = { identity, name, scope: item.scope || ".", targetId, mapPath, description: `Confirm the observed ${target.name} entry state is available.`, inputs: {}, implementations: {}, nodes: new Set(), edges: new Set(), sourcePaths: new Set(), planItemIds: new Set() };
        taskDrafts.set(name, draft);
        occupied.set(name, identity);
      }
      draft.implementations[platform] = [{ action: "assert_screen", target: target.name }];
      draft.nodes.add(target.id);
      draft.planItemIds.add(item.id);
      sequence.push(name);
    } else {
      for (const edge of path) {
        const reviewed = (edge.coveredBy?.tasks || []).find((name) => existingTasks.has(name));
        // One reviewed semantic Task may intentionally own several adjacent map
        // edges (for example Dashboard → Settings → Update Profile). Compose it
        // once; repeating it for every covered edge would immediately violate
        // its precondition after the first successful invocation.
        if (reviewed) {
          if (sequence.at(-1) !== reviewed) sequence.push(reviewed);
          continue;
        }
        const destination = nodes.get(edge.to);
        const identity = `${targetId}|edge|${edge.from}|${edge.to}|${semanticUiKey(edge.action?.target)}`;
        const name = generatedTaskName(destination, false, occupied, identity);
        let draft = taskDrafts.get(name);
        if (!draft) {
          draft = { identity, name, scope: item.scope || ".", targetId, mapPath, description: `Navigate from ${nodes.get(edge.from).name} to the observed ${destination.name} state.`, inputs: {}, implementations: {}, nodes: new Set(), edges: new Set(), sourcePaths: new Set(), planItemIds: new Set() };
          taskDrafts.set(name, draft);
          occupied.set(name, identity);
        } else if (draft.identity !== identity) {
          throw new Error(`Generated Task name '${name}' maps to incompatible UI transitions`);
        }
        const generated = generatedActionSteps(edge, nodes);
        const steps = generated.steps;
        const prior = draft.implementations[platform];
        if (prior && JSON.stringify(prior) !== JSON.stringify(steps)) throw new Error(`Observed ${platform} paths require conflicting '${name}' implementations`);
        draft.implementations[platform] = steps;
        for (const [input, definition] of Object.entries(generated.inputs)) {
          if (draft.inputs[input] && JSON.stringify(draft.inputs[input]) !== JSON.stringify(definition)) throw new Error(`Observed paths require conflicting '${name}.${input}' input definitions`);
          draft.inputs[input] = definition;
        }
        draft.nodes.add(edge.from);
        draft.nodes.add(edge.to);
        draft.edges.add(edge.id);
        draft.planItemIds.add(item.id);
        sequence.push(name);
      }
    }
    platformSequences.set(platform, sequence);
  }
  const sequences = [...platformSequences.values()];
  if (!sequences.length) throw new Error("Approved proposal has no applicable platform path");
  if (sequences.some((sequence) => JSON.stringify(sequence) !== JSON.stringify(sequences[0]))) {
    throw new Error("Observed platform paths require different semantic Task composition; review platform-specific Tasks before generating this contract");
  }
  const edgeIds = [...new Set((item.platforms || []).flatMap((platform) => shortestObservedPath(map, platform, target.id).map((edge) => edge.id)))].sort();
  const nodeIds = [...new Set([target.id, ...edgeIds.flatMap((id) => {
    const edge = map.edges.find((candidate) => candidate.id === id);
    return edge ? [edge.from, edge.to] : [];
  })])].sort();
  for (const name of sequences.flat()) {
    const draft = taskDrafts.get(name);
    if (!draft) continue;
    draft.sourcePaths ||= new Set();
    for (const sourcePath of sourcePaths) draft.sourcePaths.add(sourcePath);
  }
  return {
    ...item,
    tasks: sequences[0],
    taskInputs: Object.fromEntries(sequences[0].map((name) => [name, existingTasks.has(name) ? safeTaskInputs(existingTasks.get(name)) : safeTaskInputs(taskDrafts.get(name) || {})])),
    generatedCoverage: { nodes: nodeIds, edges: edgeIds, sourcePaths },
  };
}

function writeGeneratedTaskDrafts(root, taskDrafts) {
  const generated = [];
  for (const draft of [...taskDrafts.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const scopeRoot = path.resolve(root, draft.scope === "." || !draft.scope ? "" : draft.scope);
    if (!isInsideRoot(root, scopeRoot)) throw new Error(`Generated Task scope escapes repository: ${draft.scope}`);
    const output = path.join(scopeRoot, ".autotap", "proposals", "tasks", `${kebab(draft.name)}.task.json`);
    const definition = {
      kind: "task", version: 1, name: draft.name, description: draft.description,
      ...(Object.keys(draft.inputs || {}).length ? { inputs: draft.inputs } : {}),
      implementations: Object.fromEntries(Object.entries(draft.implementations).sort(([a], [b]) => a.localeCompare(b)).map(([platform, steps]) => [platform, { steps }])),
      coverage: { nodes: [...draft.nodes].sort(), edges: [...draft.edges].sort(), sourcePaths: [...(draft.sourcePaths || [])].sort() },
      generation: { status: "draft-grounded-unvalidated", trusted: false, origin: "deterministic-ui-map", planItemIds: [...draft.planItemIds].sort(), mapPath: draft.mapPath, targetId: draft.targetId },
    };
    const source = JSON.stringify(definition, null, 2) + "\n";
    const created = !fs.existsSync(output);
    if (!created) {
      const existing = readJson(output);
      const comparable = existing ? { ...existing, generation: definition.generation } : null;
      if (!comparable || JSON.stringify(comparable, null, 2) + "\n" !== source) throw new Error(`Draft Task already exists with different content and was not overwritten: ${relative(root, output)}`);
    }
    if (created) {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, source);
    }
    try {
      const task = loadTaskFile(output);
      const mapPath = path.resolve(root, draft.mapPath || ".autotap/ui-map.json");
      if (!isInsideRoot(root, mapPath)) throw new Error(`Generated Task UI Map escapes repository: ${draft.mapPath}`);
      const map = readJson(mapPath);
      if (!map || map.schemaVersion !== 1) throw new Error(`Generated Task UI Map is missing or invalid: ${draft.mapPath}`);
      const grounding = Object.keys(draft.implementations).map((platform) => ({ platform, ...validateTaskAgainstUiMap(task, map, platform) }));
      const errors = grounding.flatMap((entry) => entry.errors.map((error) => `${entry.platform}: ${error}`));
      if (errors.length) throw new Error(errors.join("; "));
      generated.push({ name: draft.name, scope: draft.scope, mapPath: draft.mapPath, targetId: draft.targetId, path: relative(root, output), status: task.generation?.status || "draft-grounded-unvalidated", trusted: task.generation?.trusted === true, platforms: Object.keys(draft.implementations).sort(), grounding, ...(task.generation?.realValidation ? { realValidation: task.generation.realValidation } : {}) });
    } catch (error) {
      if (created) fs.rmSync(output, { force: true });
      throw error;
    }
  }
  return generated;
}

function draftContractSource(item, projectConfig = {}) {
  const configuredActors = projectConfig.actors || {};
  const actors = item.actors?.length ? item.actors : ["customer"];
  const actor = actors[0];
  const secretInputs = new Set(Object.values(item.taskInputs || {}).flatMap((inputs) => Object.entries(inputs).filter(([, definition]) => definition.secret).map(([name]) => name)));
  const actorObject = Object.fromEntries(actors.map((name) => {
    const configured = configuredActors[name] || {};
    const bindings = Object.fromEntries(Object.entries(configured.credentials || {}).map(([key, binding]) => [key, binding.env]));
    if (name === actor) {
      if (secretInputs.has("email") && !bindings.email) bindings.email = "TEST_EMAIL";
      if (secretInputs.has("password") && !bindings.password) bindings.password = "TEST_PASSWORD";
    }
    const standardCredentials = Object.fromEntries(Object.entries(bindings).filter(([key]) => ["email", "password"].includes(key)).map(([key, env]) => [key, `$${env}`]));
    const customVars = Object.fromEntries(Object.entries(bindings).filter(([key]) => !["email", "password"].includes(key)).map(([key, env]) => [key.replace(/[^A-Za-z0-9]/g, "_").toUpperCase(), `$${env}`]));
    return [name, {
      role: configured.role || (name === "customer" ? "customer" : name),
      session: configured.session || (actors.length > 1 ? "isolated" : "default"),
      ...(Object.keys(standardCredentials).length ? { credentials: standardCredentials } : {}),
      ...(Object.keys(customVars).length ? { vars: customVars } : {}),
    }];
  }));
  const defaultSteps = (item.tasks || []).map((task) => {
    const definitions = item.taskInputs?.[task] || {};
    const supplied = item.constraints?.inputs?.[task] || {};
    const withInputs = {};
    for (const [name, definition] of Object.entries(definitions)) {
      if (Object.hasOwn(supplied, name)) withInputs[name] = supplied[name];
      else if (definition.secret) withInputs[name] = `$${name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
      else if (Object.hasOwn(definition, "default")) withInputs[name] = definition.default;
    }
    return { actor, task, ...(Object.keys(withInputs).length ? { with: withInputs } : {}) };
  });
  const steps = item.journeySteps?.length ? item.journeySteps.map((step) => {
    if (!step.task) return structuredClone(step);
    const constrained = item.constraints?.inputs?.[step.task] || {};
    const definitions = item.taskInputs?.[step.task] || {};
    const safeConstraints = Object.fromEntries(Object.entries(constrained).filter(([name]) => definitions[name]?.secret !== true));
    return { ...structuredClone(step), ...(Object.keys(safeConstraints).length ? { with: { ...(step.with || {}), ...safeConstraints } } : {}) };
  }) : defaultSteps;
  const lifecycle = item.lifecycleSource === "project-config" ? projectConfig.lifecycle || {} : {};
  const contract = {
    name: item.name,
    title: item.title,
    description: `Draft generated from approved release-plan item ${item.id}.`,
    businessValue: item.businessValue,
    criticality: item.criticality,
    platforms: item.platforms,
    policy: { prRelevant: true, ...(item.policy || {}) },
    actors: actorObject,
    steps,
    ...(lifecycle.setup?.length ? { setup: lifecycle.setup } : {}),
    ...(lifecycle.teardown?.length ? { teardown: lifecycle.teardown } : {}),
    coverage: {
      capabilities: item.groundedBy.filter((ground) => ground.type === "capability").map((ground) => ground.name || ground.id.replace(/^capability_/, "")),
      nodes: item.generatedCoverage?.nodes || item.groundedBy.filter((ground) => ground.type === "ui-map-node").map((ground) => ground.id),
      edges: item.generatedCoverage?.edges || [],
      sourcePaths: item.generatedCoverage?.sourcePaths || [],
    },
  };
  return `import { defineContract } from "@aarwitz/tapp/contracts";\n\nexport default defineContract(${JSON.stringify(contract, null, 2)});\n`;
}

export async function generateApprovedContractProposals(plan, { projectDir } = {}) {
  const root = fs.realpathSync(path.resolve(projectDir || process.cwd()));
  const generated = [];
  const blocked = [];
  const generationById = new Map();
  const preparedById = new Map();
  const taskDrafts = new Map();
  const existingTaskResult = taskArtifacts(root, walk(root));
  if (existingTaskResult.errors.length) throw new Error(existingTaskResult.errors.map((item) => `${item.path}: ${item.error}`).join("; "));
  const projectConfiguration = readProjectConfig(root);
  if (projectConfiguration.errors.length) throw new Error(`Invalid ${projectConfiguration.relativePath}: ${projectConfiguration.errors.join("; ")}`);
  const configuredActors = projectConfiguration.config?.actors || {};
  const block = (item, reason) => {
    blocked.push({ id: item.id, name: item.name, reason });
    generationById.set(item.id, { status: "blocked", trusted: false, reason });
  };

  for (const item of plan.items || []) {
    if (item.decision !== "approved" || item.origin === "committed") continue;
    if (!Array.isArray(item.platforms) || !item.platforms.length) {
      block(item, "Approved proposal has no applicable detected platform.");
      continue;
    }
    const unresolvedInputs = Object.entries(item.taskInputs || {}).flatMap(([task, inputs]) => Object.entries(inputs).flatMap(([name, definition]) => {
      if (item.constraints?.inputs?.[task] && Object.hasOwn(item.constraints.inputs[task], name)) return [];
      if (Object.hasOwn(definition, "default")) return [];
      const actorName = item.actors?.[0] || "customer";
      if (definition.secret && (["email", "password"].includes(name) || configuredActors[actorName]?.credentials?.[name]?.env)) return [];
      return definition.required === false ? [] : [`${task}.${name}`];
    }));
    if (unresolvedInputs.length) {
      block(item, `Approved proposal still needs explicit safe input bindings: ${unresolvedInputs.join(", ")}`);
      continue;
    }
    let prepared = item;
    if (item.origin === "deterministic-ui-map-proposal") {
      const grounding = (item.groundedBy || []).find((entry) => entry.type === "ui-map-node");
      const mapPath = grounding?.mapPath || ".autotap/ui-map.json";
      const absoluteMapPath = path.resolve(root, mapPath);
      const itemMap = isInsideRoot(root, absoluteMapPath) ? readJson(absoluteMapPath) : null;
      if (!itemMap || itemMap.schemaVersion !== 1) {
        block(item, "Approved UI-only proposal requires a valid repository UI Map before reusable Tasks can be generated.");
        continue;
      }
      const scopedTasks = new Map(existingTaskResult.tasks.filter((task) => task.__scope === "." || task.__scope === (item.scope || ".")).map((task) => [task.name, task]));
      try { prepared = prepareMapBackedItem(item, itemMap, scopedTasks, taskDrafts, { targetId: grounding?.targetId || "", mapPath: relative(root, absoluteMapPath) }); }
      catch (error) { block(item, error.message || String(error)); continue; }
    } else if (!(item.tasks || []).length) {
      block(item, "Approved proposal has no reusable Task composition.");
      continue;
    }
    preparedById.set(item.id, prepared);
  }

  let generatedTasks = [];
  if (taskDrafts.size) generatedTasks = writeGeneratedTaskDrafts(root, taskDrafts);

  for (const item of plan.items || []) {
    const prepared = preparedById.get(item.id);
    if (!prepared) continue;
    const scopeRoot = path.resolve(root, item.scope === "." || !item.scope ? "" : item.scope);
    if (scopeRoot !== root && !scopeRoot.startsWith(root + path.sep)) throw new Error(`Plan scope escapes repository: ${item.scope}`);
    const output = path.join(scopeRoot, ".autotap", "proposals", "contracts", `${kebab(item.name)}.contract.ts`);
    const source = draftContractSource(prepared, projectConfiguration.config || {});
    if (fs.existsSync(output) && fs.readFileSync(output, "utf8") !== source) throw new Error(`Draft contract already exists with different content and was not overwritten: ${relative(root, output)}`);
    const created = !fs.existsSync(output);
    if (created) {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, source);
    }
    try {
      const contract = await loadReleaseContractFile(output);
      const compiled = prepared.platforms.map((platform) => {
        const execution = compileReleaseContract(contract, { platform, sourcePath: output });
        return { platform, kind: execution.kind, deterministicSteps: execution.steps.length };
      });
      const taskPaths = generatedTasks.filter((task) => task.scope === (item.scope || ".") && prepared.tasks.includes(task.name)).map((task) => task.path);
      const mapPath = (item.groundedBy || []).find((entry) => entry.type === "ui-map-node")?.mapPath;
      const resultPath = relative(root, output);
      const prior = item.generation?.path === resultPath && item.generation.trusted === true ? item.generation : null;
      const result = {
        id: item.id, name: item.name, path: resultPath, tasks: prepared.tasks, taskPaths, ...(mapPath ? { mapPath } : {}),
        status: prior?.status || "draft-compiled-unvalidated", trusted: prior?.trusted === true, staticValidation: compiled,
        replayRequired: prior ? prior.replayRequired === true : true,
        ...(prior?.realValidation ? { realValidation: prior.realValidation } : {}),
        ...(prior?.validationStale !== undefined ? { validationStale: prior.validationStale } : {}),
      };
      generated.push(result);
      generationById.set(item.id, result);
    } catch (error) {
      if (created) fs.rmSync(output, { force: true });
      const reason = error.message || String(error);
      blocked.push({ id: item.id, name: item.name, reason });
      generationById.set(item.id, { status: "blocked", trusted: false, reason });
    }
  }
  const nextPlan = {
    ...plan,
    items: (plan.items || []).map((item) => generationById.has(item.id) ? { ...item, ...(preparedById.has(item.id) ? { tasks: preparedById.get(item.id).tasks, taskInputs: preparedById.get(item.id).taskInputs || item.taskInputs } : {}), generation: generationById.get(item.id) } : item),
    generation: { generatedAt: new Date().toISOString(), generatedTasks, generated, blocked, invariant: "Draft Task grounding and contract compilation are not real-surface validation; generated artifacts remain untrusted until deterministic replay passes." },
  };
  return { plan: nextPlan, generatedTasks, generated, blocked };
}

export function portableEvidenceReference(value) {
  const evidence = String(value || "").trim();
  if (!evidence) return null;
  const capture = evidence.match(/[\\/]captures[\\/]([^\\/]+)(?:[\\/].*)?$/);
  if (capture) return `tapp-capture:${capture[1]}`;
  if (path.isAbsolute(evidence)) return `local-evidence:${crypto.createHash("sha256").update(evidence).digest("hex").slice(0, 16)}`;
  return evidence;
}

export function resolvePlanValidationFlag(key, value, { cwd = process.cwd() } = {}) {
  return key === "apk" ? path.resolve(cwd, String(value)) : String(value);
}

export function recordContractProposalValidation(plan, { id = "", name = "", platform, passed, evidence = "", detail = "" } = {}) {
  if (!["ios", "android", "web"].includes(platform)) throw new Error("platform must be ios|android|web");
  const matches = (plan.items || []).filter((item) => (id && item.id === id) || (!id && name && item.name === name));
  if (matches.length !== 1) throw new Error(matches.length ? `Plan item name '${name}' is ambiguous; use its stable id` : `Generated plan item not found: ${id || name}`);
  const target = matches[0];
  if (!target.generation?.path) throw new Error(`Plan item '${target.name}' has no generated draft`);
  if (!(target.platforms || []).includes(platform)) throw new Error(`Plan item '${target.name}' does not apply to ${platform}`);
  const validations = { ...(target.generation.realValidation || {}), [platform]: { status: passed ? "passed" : "failed", passed: !!passed, evidence: portableEvidenceReference(evidence), detail: detail || "" } };
  const trusted = (target.platforms || []).every((candidate) => validations[candidate]?.passed === true);
  const generation = {
    ...target.generation,
    status: trusted ? (target.generation.promotedAt ? "promoted" : "validated-draft") : passed ? "partially-validated-draft" : "replay-failed",
    trusted,
    realValidation: validations,
    replayRequired: !trusted,
    validationStale: false,
  };
  const items = plan.items.map((item) => item.id === target.id ? { ...item, generation } : item);
  const generated = (plan.generation?.generated || []).map((item) => {
    const sameGeneration = item.id === target.id || item.id === target.generation.id || (item.name === target.generation.name && item.path === target.generation.path);
    return sameGeneration ? { ...item, ...generation } : item;
  });
  return { ...plan, items, generation: { ...(plan.generation || {}), generated } };
}

export function recordGeneratedTaskProposalValidation({ projectDir, item, platform, evidence = "", detail = "" } = {}) {
  if (!["ios", "android", "web"].includes(platform)) throw new Error("platform must be ios|android|web");
  const root = fs.realpathSync(path.resolve(projectDir || process.cwd()));
  const proposalMarker = `${path.sep}.autotap${path.sep}proposals${path.sep}tasks${path.sep}`;
  const reviewedMarker = `${path.sep}.autotap${path.sep}tasks${path.sep}`;
  const updated = [];
  for (const taskPath of item?.generation?.taskPaths || []) {
    const absolute = path.resolve(root, taskPath);
    const proposed = isInsideRoot(root, absolute) && absolute.includes(proposalMarker);
    const reviewed = isInsideRoot(root, absolute) && absolute.includes(reviewedMarker) && !absolute.includes(proposalMarker);
    if ((!proposed && !reviewed) || !fs.existsSync(absolute)) throw new Error(`Generated Task is missing or outside Tapp Task directories: ${taskPath}`);
    const task = readJson(absolute);
    if (!task || task.kind !== "task" || task.generation?.origin !== "deterministic-ui-map") throw new Error(`Generated Task draft has invalid provenance: ${taskPath}`);
    if (!task.implementations?.[platform]) throw new Error(`Generated Task '${task.name}' has no ${platform} implementation`);
    if (reviewed) {
      if (task.generation?.trusted !== true) throw new Error(`Promoted Task '${task.name}' is not trusted`);
      updated.push({ name: task.name, path: relative(root, absolute), status: task.generation.status, trusted: true, realValidation: task.generation.realValidation || {}, platform });
      continue;
    }
    const validations = {
      ...(task.generation.realValidation || {}),
      [platform]: { status: "passed", passed: true, evidence: portableEvidenceReference(evidence), detail, contract: item.name, validatedAt: new Date().toISOString() },
    };
    const platforms = Object.keys(task.implementations || {}).filter((candidate) => ["ios", "android", "web"].includes(candidate));
    const trusted = platforms.length > 0 && platforms.every((candidate) => validations[candidate]?.passed === true);
    task.generation = { ...task.generation, status: trusted ? "validated-draft" : "partially-validated-draft", trusted, realValidation: validations };
    const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, JSON.stringify(task, null, 2) + "\n");
    fs.renameSync(temporary, absolute);
    updated.push({ name: task.name, path: relative(root, absolute), status: task.generation.status, trusted, realValidation: task.generation.realValidation, platform });
  }
  return updated;
}

export function mergeGeneratedTaskProposalValidation(plan, updates = []) {
  const byPath = new Map(updates.map((item) => [item.path, item]));
  return {
    ...plan,
    generation: {
      ...(plan.generation || {}),
      generatedTasks: (plan.generation?.generatedTasks || []).map((task) => {
        const update = byPath.get(task.path);
        return update ? { ...task, status: update.status, trusted: update.trusted, realValidation: update.realValidation } : task;
      }),
    },
  };
}

function promotedDestination(root, source, kind) {
  const marker = `${path.sep}.autotap${path.sep}proposals${path.sep}${kind}${path.sep}`;
  const index = source.indexOf(marker);
  if (index < 0) throw new Error(`Proposal ${kind.slice(0, -1)} is outside .autotap/proposals/${kind}: ${relative(root, source)}`);
  const destination = `${source.slice(0, index)}${path.sep}.autotap${path.sep}${kind}${path.sep}${source.slice(index + marker.length)}`;
  if (!isInsideRoot(root, destination)) throw new Error(`Promotion destination escapes repository: ${destination}`);
  return destination;
}

export async function promoteValidatedProposals(plan, { projectDir, ids = [] } = {}) {
  const root = fs.realpathSync(path.resolve(projectDir || process.cwd()));
  const requested = new Set(ids || []);
  const candidates = (plan.items || []).filter((item) => item.generation?.path && (requested.size ? requested.has(item.id) || requested.has(item.name) : item.generation.trusted === true));
  if (requested.size) {
    const matched = new Set(candidates.flatMap((item) => [item.id, item.name]).filter((value) => requested.has(value)));
    const missing = [...requested].filter((value) => !matched.has(value));
    if (missing.length) throw new Error(`Generated plan item(s) not found: ${missing.join(", ")}`);
  }
  if (!candidates.length) throw new Error("No validated generated contracts are available to promote");
  for (const item of candidates) if (item.generation.trusted !== true || item.generation.status !== "validated-draft") throw new Error(`Plan item '${item.name}' must pass deterministic replay on every declared platform before promotion`);

  const mapCache = new Map();
  const mapForItem = (item) => {
    const relativeMapPath = item.generation?.mapPath || (item.groundedBy || []).find((entry) => entry.type === "ui-map-node")?.mapPath || ".autotap/ui-map.json";
    const absolute = path.resolve(root, relativeMapPath);
    if (!isInsideRoot(root, absolute)) throw new Error(`UI Map for '${item.name}' escapes the repository: ${relativeMapPath}`);
    if (!mapCache.has(absolute)) {
      const map = readJson(absolute);
      if (!map || map.schemaVersion !== 1) throw new Error(`A valid UI Map is required for '${item.name}': ${relative(root, absolute)}`);
      mapCache.set(absolute, map);
    }
    return { path: absolute, map: mapCache.get(absolute) };
  };
  const moves = new Map();
  const taskRecords = new Map();
  const taskMapPaths = new Map();
  const contractRecords = [];
  for (const item of candidates) {
    const itemMap = mapForItem(item);
    for (const taskPath of item.generation.taskPaths || []) {
      const source = path.resolve(root, taskPath);
      if (!fs.existsSync(source)) throw new Error(`Generated Task is missing: ${taskPath}`);
      if (!String(source).includes(`${path.sep}.autotap${path.sep}proposals${path.sep}tasks${path.sep}`)) continue;
      const destination = promotedDestination(root, source, "tasks");
      moves.set(source, destination);
      let task = taskRecords.get(source);
      if (!task) {
        task = loadTaskFile(source);
        if (task.generation?.trusted !== true || task.generation?.status !== "validated-draft") throw new Error(`Generated Task '${task.name}' must be fully validated before promotion`);
        taskRecords.set(source, task);
      }
      for (const platform of Object.keys(task.implementations || {})) {
        const grounding = validateTaskAgainstUiMap(task, itemMap.map, platform);
        if (grounding.errors.length) throw new Error(`Generated Task '${task.name}' is no longer grounded in ${relative(root, itemMap.path)}: ${grounding.errors.join("; ")}`);
      }
      const mapPaths = taskMapPaths.get(source) || new Set();
      mapPaths.add(itemMap.path);
      taskMapPaths.set(source, mapPaths);
    }
    const source = path.resolve(root, item.generation.path);
    if (!fs.existsSync(source)) throw new Error(`Generated contract is missing: ${item.generation.path}`);
    const destination = promotedDestination(root, source, "contracts");
    moves.set(source, destination);
    const contract = await loadReleaseContractFile(source);
    const grounding = validateReleaseContractAgainstUiMap(contract, itemMap.map);
    if (grounding.errors.length) throw new Error(`Generated contract '${contract.name}' is no longer grounded: ${grounding.errors.join("; ")}`);
    contractRecords.push({ item, source, destination, contract, mapPath: itemMap.path });
  }
  for (const destination of moves.values()) if (fs.existsSync(destination)) throw new Error(`Promotion never overwrites an existing reviewed artifact: ${relative(root, destination)}`);

  const completed = [];
  const originalTaskSources = new Map([...taskRecords.keys()].map((source) => [source, fs.readFileSync(source, "utf8")]));
  try {
    for (const [source, destination] of [...moves].sort(([a], [b]) => a.localeCompare(b))) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(source, destination);
      completed.push([source, destination]);
      const task = taskRecords.get(source);
      if (task) {
        const promoted = { ...task, generation: { ...task.generation, status: "promoted", trusted: true, promotedAt: new Date().toISOString(), promotedFrom: relative(root, source) } };
        delete promoted.__path;
        fs.writeFileSync(destination, JSON.stringify(promoted, null, 2) + "\n");
      }
    }
  } catch (error) {
    for (const [source, destination] of completed.reverse()) {
      try {
        fs.renameSync(destination, source);
        if (originalTaskSources.has(source)) fs.writeFileSync(source, originalTaskSources.get(source));
      } catch { /* preserve the original error */ }
    }
    throw error;
  }

  const pathMap = new Map([...moves].map(([source, destination]) => [relative(root, source), relative(root, destination)]));
  const coveredMaps = new Map([...mapCache].map(([mapPath, map]) => [mapPath, map]));
  for (const [source, task] of taskRecords) for (const mapPath of taskMapPaths.get(source) || []) coveredMaps.set(mapPath, applyTaskCoverage(coveredMaps.get(mapPath), task));
  for (const record of contractRecords) coveredMaps.set(record.mapPath, applyReleaseContractCoverage(coveredMaps.get(record.mapPath), record.contract));
  const { writeUiMap } = await import("./ui-map.js");
  for (const [mapPath, coveredMap] of coveredMaps) writeUiMap(mapPath, coveredMap);
  const promotedIds = new Set(candidates.map((item) => item.id));
  const promotedAt = new Date().toISOString();
  const rewriteGeneration = (generation) => generation ? {
    ...generation,
    ...(pathMap.has(generation.path) ? { path: pathMap.get(generation.path) } : {}),
    ...(generation.taskPaths ? { taskPaths: generation.taskPaths.map((value) => pathMap.get(value) || value) } : {}),
  } : generation;
  const items = (plan.items || []).map((item) => {
    const generation = rewriteGeneration(item.generation);
    if (!promotedIds.has(item.id)) return generation === item.generation ? item : { ...item, generation };
    return { ...item, origin: "promoted-validated", decision: "accepted", generation: { ...generation, status: "promoted", trusted: true, replayRequired: false, promotedAt } };
  });
  const generatedTasks = (plan.generation?.generatedTasks || []).map((task) => {
    const nextPath = pathMap.get(task.path);
    return nextPath ? { ...task, path: nextPath, status: "promoted", trusted: true, promotedAt } : task;
  });
  const generated = (plan.generation?.generated || []).map((contract) => {
    const nextPath = pathMap.get(contract.path);
    const taskPaths = (contract.taskPaths || []).map((value) => pathMap.get(value) || value);
    const tasksChanged = JSON.stringify(taskPaths) !== JSON.stringify(contract.taskPaths || []);
    return nextPath
      ? { ...contract, path: nextPath, taskPaths, status: "promoted", trusted: true, promotedAt }
      : tasksChanged ? { ...contract, taskPaths } : contract;
  });
  const nextPlan = { ...plan, items, generation: { ...(plan.generation || {}), generatedTasks, generated, promotedAt } };
  return {
    plan: nextPlan,
    promotedTasks: [...taskRecords].map(([source, task]) => ({ name: task.name, from: relative(root, source), path: pathMap.get(relative(root, source)) })).sort((a, b) => a.name.localeCompare(b.name)),
    promotedContracts: contractRecords.map((record) => ({ name: record.contract.name, from: relative(root, record.source), path: relative(root, record.destination) })).sort((a, b) => a.name.localeCompare(b.name)),
    mapPath: [...coveredMaps.keys()][0],
    mapPaths: [...coveredMaps.keys()].sort(),
  };
}

export async function buildInitArtifacts(options = {}) {
  const inspected = await inspectApplicationRepository(options);
  return { ...inspected, plan: proposeReleasePlan({ ...inspected, maxContracts: options.maxContracts }) };
}

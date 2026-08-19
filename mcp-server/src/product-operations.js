// Tapp's customer-journey engine. Every user-facing adapter should be thin:
// validate its transport, call one of these operations, and render the result.
// This module owns repository artifact semantics and never imports a UI adapter.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInitArtifacts,
  generateApprovedContractProposals,
  mergeGeneratedTaskProposalValidation,
  promoteValidatedProposals,
  recordContractProposalValidation,
  recordGeneratedTaskProposalValidation,
  reviewReleasePlan,
  writeInitArtifacts,
} from "./application-model.js";
import { baselinePathForTarget, existingBaselinePathForTarget, renderGithubWorkflow, selectApplicationTarget, writeCiInstallation, writeTargetBaseline } from "./ci-setup.js";
import { executeReleaseContract, runProductProcess } from "./product-execution.js";
import { projectArtifactDirectory } from "./project-paths.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
const DEFAULT_ACTION_REF = `aarwitz/tapp@v${packageVersion}`;

function realProject(projectDir) {
  const root = fs.realpathSync(path.resolve(projectDir || process.cwd()));
  if (!fs.statSync(root).isDirectory()) throw new Error(`Repository directory not found: ${root}`);
  return root;
}

function inside(root, value) {
  const candidate = path.resolve(value);
  return candidate === root || candidate.startsWith(root + path.sep);
}

function readJson(file, { required = false } = {}) {
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`Required artifact not found: ${file}`);
    return null;
  }
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`Invalid JSON in ${file}: ${error.message}`); }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(temporary, file);
}

function artifactPaths(root, outDir = ".tapp") {
  const selectedOutDir = projectArtifactDirectory(root, outDir);
  const dir = path.resolve(root, selectedOutDir);
  if (!inside(root, dir)) throw new Error("Artifact directory must remain inside the repository");
  return {
    dir,
    model: path.join(dir, "application-model.json"),
    plan: path.join(dir, "release-plan.json"),
    map: path.join(dir, "ui-map.json"),
    ci: path.join(dir, "ci.json"),
  };
}

function normalizedInitTarget(root, target) {
  const requested = String(target || "").trim();
  if (!requested) return "";
  let absolute;
  try { absolute = fs.realpathSync(path.resolve(root, requested)); }
  catch { absolute = path.resolve(root, requested); }
  if (absolute === root) return "";
  if (inside(root, absolute)) return path.relative(root, absolute).replaceAll(path.sep, "/");
  return requested;
}

function initTargetChoices(model, platform = "") {
  const candidates = (model.targets || []).filter((target) => !platform || target.platform === platform);
  return candidates.map((target) => ({
    target,
    command: `npx -y @aarwitz/tapp@latest init . --explore --platform ${target.platform} --target ${target.sourcePath === "." ? JSON.stringify(target.name) : JSON.stringify(target.sourcePath)}`,
  }));
}

function selectInitExplorationTarget(model, {
  root,
  platform = "",
  target = "",
  appId = "",
} = {}) {
  const selectedPlatform = String(platform || "").trim().toLowerCase();
  if (selectedPlatform && !["ios", "android", "web"].includes(selectedPlatform)) throw new Error("platform must be ios|android|web");
  let requested = normalizedInitTarget(root, target);
  if (!requested && appId) {
    const androidMatch = (model.targets || []).find((candidate) => candidate.platform === "android" && candidate.runtime?.applicationId === appId);
    if (androidMatch) requested = androidMatch.id;
  }
  try {
    return selectApplicationTarget(model, {
      platform: selectedPlatform,
      target: requested,
      // `init --explore` is the explicit onboarding/refresh operation: it asks whenever several
      // targets are plausible. Only a later bare `tapp explore` consumes the recorded default.
      useDefault: false,
    });
  } catch (error) {
    const choices = initTargetChoices(model, selectedPlatform);
    if (choices.length > 1 && !requested) {
      const selection = new Error(
        `Multiple application targets were detected; Tapp will not guess which one you mean:\n` +
        choices.map(({ target: choice }) => `  - ${choice.platform}:${choice.name} (${choice.sourcePath})`).join("\n") +
        `\nRerun with one of:\n` + choices.map(({ command }) => `  ${command}`).join("\n")
      );
      selection.code = "TAPP_TARGET_SELECTION_REQUIRED";
      selection.details = {
        reason: "target-selection-required",
        choices: choices.map(({ target: choice, command }) => ({
          id: choice.id,
          platform: choice.platform,
          name: choice.name,
          sourcePath: choice.sourcePath,
          selector: choice.sourcePath === "." ? choice.name : choice.sourcePath,
          command,
        })),
      };
      throw selection;
    }
    throw error;
  }
}

export function scopeProductRequirements(model, { selectedTargetId = "" } = {}) {
  const targets = Array.isArray(model?.targets) ? model.targets : [];
  const requirements = Array.isArray(model?.requirements) ? model.requirements : [];
  const selected = String(selectedTargetId || "").trim();
  const enriched = requirements.map((requirement) => {
    const target = targets.find((candidate) => requirement.targetId === candidate.id || String(requirement.id || "").startsWith(`${candidate.id}:`));
    return target
      ? { ...requirement, targetId: target.id, targetPlatform: target.platform, targetName: target.name }
      : { ...requirement };
  });
  if (!selected) return { selectedTargetId: "", active: enriched, deferred: [] };
  return {
    selectedTargetId: selected,
    active: enriched.filter((requirement) => !requirement.targetId || requirement.targetId === selected),
    deferred: enriched.filter((requirement) => requirement.targetId && requirement.targetId !== selected),
  };
}

function productRunRoot(root) {
  const home = process.env.TAPP_HOME || path.join(os.homedir(), ".tapp");
  const identity = crypto.createHash("sha256").update(root).digest("hex").slice(0, 16);
  return path.join(home, "product-runs", identity);
}

function listProductRuns(root) {
  const runsRoot = productRunRoot(root);
  if (!fs.existsSync(runsRoot)) return [];
  return fs.readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(runsRoot, entry.name);
      const reportPath = path.join(dir, "gate-report.json");
      const markdownPath = path.join(dir, "gate-report.md");
      const report = readJson(reportPath);
      return {
        id: entry.name,
        createdAt: fs.statSync(dir).birthtime.toISOString(),
        status: report ? "completed" : "incomplete",
        outcome: report?.gate?.outcome || null,
        gate: report?.gate || null,
        reportPath: fs.existsSync(reportPath) ? reportPath : null,
        markdownPath: fs.existsSync(markdownPath) ? markdownPath : null,
        report,
      };
    })
    .sort((left, right) => right.id.localeCompare(left.id))
    .slice(0, 20);
}

function listRepositoryFlows(root) {
  const directory = path.join(root, projectArtifactDirectory(root), "flows");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes:true })
    .filter((entry) => entry.isFile() && /\.(?:ya?ml|json)$/i.test(entry.name))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      const relativePath = path.relative(root, file).replaceAll(path.sep, "/");
      let name = entry.name.replace(/\.(?:ya?ml|json)$/i, "");
      let platform = "ios";
      let steps = 0;
      try {
        const source = fs.readFileSync(file, "utf8");
        if (entry.name.endsWith(".json")) {
          const parsed = JSON.parse(source);
          name = String(parsed.name || name);
          platform = String(parsed.platform || (/^https?:\/\//i.test(parsed.url || parsed.app || "") ? "web" : "ios")).toLowerCase();
          steps = Array.isArray(parsed.steps) ? parsed.steps.length : 0;
        } else {
          const scalar = (key) => {
            const match = source.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
            return match ? match[1].replace(/^["']|["']$/g, "") : "";
          };
          name = scalar("name") || name;
          platform = (scalar("platform") || (/^url:\s*https?:\/\//im.test(source) ? "web" : "ios")).toLowerCase();
          const block = source.split(/^steps:\s*$/m)[1] || "";
          steps = (block.match(/^\s{2}-\s/gm) || []).length;
        }
      } catch { /* Artifact remains inspectable; deterministic replay reports invalid syntax. */ }
      return { id:`flow_${crypto.createHash("sha256").update(relativePath).digest("hex").slice(0, 16)}`, name, path:relativePath, platform, steps, status:"committed" };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function readProductProject({ projectDir, outDir = ".tapp" } = {}) {
  const root = realProject(projectDir);
  const paths = artifactPaths(root, outDir);
  const model = readJson(paths.model);
  const plan = readJson(paths.plan);
  const map = readJson(paths.map);
  const ci = readJson(paths.ci);
  const requirements = model?.requirements || [];
  const planItems = plan?.items || [];
  const baselines = (model?.targets || []).map((target) => {
    const file = existingBaselinePathForTarget(root, target);
    return { targetId: target.id, platform: target.platform, path: file, relativePath: path.relative(root, file).replaceAll(path.sep, "/"), exists: fs.existsSync(file) };
  });
  return {
    kind: "tapp-product-project",
    schemaVersion: 1,
    root,
    application: model?.application || { name: path.basename(root), platforms: [], targetIds: [] },
    targets: model?.targets || [],
    actors: model?.actors || [],
    capabilities: model?.capabilities || [],
    requirements,
    model,
    map,
    plan,
    ci,
    baselines,
    flows: listRepositoryFlows(root),
    evidence: listProductRuns(root),
    state: {
      inspected: !!model,
      explored: map?.nodes?.length > 0 && model?.uiMap?.status === "observed",
      reviewComplete: !!plan && !planItems.some((item) => item.decision === "pending"),
      generated: planItems.some((item) => item.generation?.path),
      validated: planItems.some((item) => item.generation?.trusted === true || item.generation?.status === "validated-draft"),
      promoted: planItems.some((item) => item.decision === "accepted" || item.origin === "committed"),
      ciPrepared: !!ci,
      baselineReady: baselines.some((item) => item.exists),
      blockingRequirements: requirements.filter((item) => item.severity === "blocking").length,
    },
    paths,
  };
}

// Resolve and, when needed, build one canonical Application Model target. UI
// adapters provide platform tool invocations; selection and runtime semantics
// stay here so browser, CLI, MCP, and managed runners do not invent their own
// target identity or configuration rules.
export async function prepareProductTarget({
  projectDir,
  outDir = ".tapp",
  platform = "",
  target = "",
  appPath = "",
  apkPath = "",
  bundleId = "",
  appId = "",
  scheme = "",
  configuration = "",
  buildIos,
  installIos,
  buildAndroid,
  onProgress = () => {},
} = {}) {
  const root = realProject(projectDir);
  const project = readProductProject({ projectDir: root, outDir });
  if (!project.model) throw new Error("Application model not found; inspect the repository first");
  const selectedTarget = selectApplicationTarget(project.model, { platform, target });
  const runtime = { platform: selectedTarget.platform, target: selectedTarget.id };

  if (selectedTarget.platform === "web") {
    runtime.url = selectedTarget.runtime?.ownedUrl || "";
    runtime.management = selectedTarget.runtime?.management || "unresolved";
    return { operation: "prepare-target", selectedTarget, runtime };
  }

  if (selectedTarget.platform === "android") {
    runtime.appId = String(appId || selectedTarget.runtime?.applicationId || "").trim();
    if (!runtime.appId) throw new Error(`Android target '${selectedTarget.name}' needs an application id before it can run`);
    let resolvedApk = String(apkPath || "").trim();
    if (resolvedApk) {
      resolvedApk = path.resolve(resolvedApk);
      if (!fs.existsSync(resolvedApk)) throw new Error(`Android APK not found: ${resolvedApk}`);
    } else {
      if (typeof buildAndroid !== "function") throw new Error(`Android target '${selectedTarget.name}' needs a build-capable runner or a prebuilt APK`);
      onProgress({ phase: "build", text: `Building Android target ${selectedTarget.name}` });
      const built = await buildAndroid({
        projectDir: root,
        gradleProjectDir: path.resolve(root, selectedTarget.build?.projectDir || "."),
        moduleDir: path.resolve(root, selectedTarget.sourcePath || "."),
        task: selectedTarget.build?.task || "assembleDebug",
        target: selectedTarget,
      });
      if (built?.error) throw Object.assign(new Error(built.error), { details: built.details || {} });
      resolvedApk = built?.apkPath || "";
      if (!resolvedApk || !fs.existsSync(resolvedApk)) throw new Error(`Android build for '${selectedTarget.name}' produced no readable APK`);
      runtime.build = built;
    }
    runtime.apkPath = resolvedApk;
    return { operation: "prepare-target", selectedTarget, runtime };
  }

  let resolvedApp = String(appPath || "").trim();
  if (resolvedApp) {
    resolvedApp = path.resolve(resolvedApp);
    if (!resolvedApp.endsWith(".app") || !fs.existsSync(resolvedApp)) throw new Error(`iOS simulator app not found: ${resolvedApp}`);
  } else {
    if (typeof buildIos !== "function") throw new Error(`iOS target '${selectedTarget.name}' needs a macOS/Xcode runner or a prebuilt simulator .app`);
    onProgress({ phase: "build", text: `Building iOS target ${selectedTarget.name}` });
    const built = await buildIos({
      container: path.resolve(root, selectedTarget.build?.container || selectedTarget.sourcePath || "."),
      scheme: String(scheme || selectedTarget.build?.proposedScheme || ""),
      configuration: String(configuration || selectedTarget.build?.configuration || "Debug"),
      target: selectedTarget,
    });
    if (built?.error) throw Object.assign(new Error(built.error), { details: built.details || {} });
    resolvedApp = built?.appPath || "";
    if (!resolvedApp || !fs.existsSync(resolvedApp)) throw new Error(`iOS build for '${selectedTarget.name}' produced no readable simulator .app`);
    runtime.build = built;
  }
  runtime.appPath = resolvedApp;
  runtime.bundleId = String(bundleId || selectedTarget.runtime?.bundleId || "").trim();
  if (typeof installIos === "function") {
    onProgress({ phase: "runtime", text: `Installing ${path.basename(resolvedApp)} on the simulator` });
    const installed = await installIos(resolvedApp);
    if (installed?.error) throw Object.assign(new Error(installed.error), { details: installed.details || {} });
    runtime.bundleId = installed?.bundleId || runtime.bundleId;
    runtime.install = installed;
  }
  return { operation: "prepare-target", selectedTarget, runtime };
}

export async function initializeProductProject({
  projectDir,
  mode = "inspect",
  outDir = ".tapp",
  ownedUrl = "",
  platform = "",
  target = "",
  bundleId = "",
  appId = "",
  apkPath,
  serial,
  scheme = "",
  configuration = "Debug",
  maxActions = 40,
  timeout = 600,
  maxContracts = 15,
  testEmail,
  testPassword,
  watch = false,
  runExploration,
  onProgress = () => {},
  onStatus = () => {},
} = {}) {
  const root = realProject(projectDir);
  if (!["inspect", "write", "refresh", "explore"].includes(mode)) throw new Error("mode must be inspect|write|refresh|explore");
  if (!Number.isInteger(Number(maxContracts)) || Number(maxContracts) < 1 || Number(maxContracts) > 50) throw new Error("maxContracts must be between 1 and 50");
  const paths = artifactPaths(root, outDir);
  const priorModel = readJson(paths.model);
  let exploration = null;
  let selectedTarget = null;
  if (mode === "explore") {
    if (typeof runExploration !== "function") throw new Error("The selected adapter did not provide a platform exploration capability");
    const selectedPlatform = String(platform || (ownedUrl ? "web" : appId || apkPath ? "android" : "")).toLowerCase();
    const inspected = await buildInitArtifacts({
      projectDir: root,
      ownedUrl,
      outDir,
      maxContracts: Number(maxContracts),
      defaultTargetId: priorModel?.application?.defaultTargetId || "",
    });
    selectedTarget = selectInitExplorationTarget(inspected.model, {
      root,
      platform: selectedPlatform,
      target,
      appId,
    });
    const sourceTarget = selectedTarget.sourcePath === "." ? root : path.resolve(root, selectedTarget.sourcePath);
    exploration = await runExploration({
      projectDir: root, platform: selectedTarget.platform, outDir, url: ownedUrl, target: sourceTarget,
      bundleId, appId: appId || selectedTarget.runtime?.applicationId || "", apkPath, serial, scheme, configuration, maxActions: Number(maxActions), timeout: Number(timeout),
      testEmail, testPassword, watch, onProgress: (progress) => onProgress({ ...progress, platform: selectedTarget.platform }), onStatus,
    });
    if (exploration?.error) throw Object.assign(new Error(exploration.error), { details: exploration.details || {} });
  }
  const built = await buildInitArtifacts({
    projectDir: root,
    ownedUrl: ownedUrl || (exploration?.platform === "web" && !exploration.managedRuntime ? exploration.target : ""),
    // Exploration chooses one runnable surface, but the repository model must retain every detected
    // application target. Otherwise selecting web would silently erase the native app (and vice versa).
    platform: mode === "explore" ? "" : String(platform || "").toLowerCase(),
    targetValidation: exploration?.targetValidation || null,
    defaultTargetId: selectedTarget?.id || priorModel?.application?.defaultTargetId || "",
    outDir,
    maxContracts: Number(maxContracts),
  });
  let written = null;
  if (mode !== "inspect") {
    const existing = fs.existsSync(paths.model) || fs.existsSync(paths.plan);
    written = writeInitArtifacts({
      ...built,
      root: built.root,
      outDir,
      refresh: mode === "refresh" || (mode === "explore" && existing),
      invalidateValidation: mode === "explore",
    });
  }
  const requirementScope = scopeProductRequirements(built.model, { selectedTargetId: selectedTarget?.id || "" });
  return { operation: "initialize", mode, model: built.model, plan: written?.plan || built.plan, exploration, selectedTarget, requirementScope, written, project: readProductProject({ projectDir: root, outDir }) };
}

function resolvePlan(root, outDir, planPath = "") {
  const paths = artifactPaths(root, outDir);
  const candidate = path.resolve(root, planPath || path.relative(root, paths.plan));
  const file = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
  if (!inside(root, file)) throw new Error("Release plan must remain inside the repository");
  return { file, plan: readJson(file, { required: true }) };
}

export function reviewProductPlan({ projectDir, outDir = ".tapp", planPath = "", approve = [], reject = [], defer = [] } = {}) {
  const root = realProject(projectDir);
  const resolved = resolvePlan(root, outDir, planPath);
  const plan = reviewReleasePlan(resolved.plan, { approve, reject, defer });
  atomicJson(resolved.file, plan);
  return { operation: "review-plan", plan, planPath: resolved.file, project: readProductProject({ projectDir: root, outDir }) };
}

export async function generateProductPlan({ projectDir, outDir = ".tapp", planPath = "" } = {}) {
  const root = realProject(projectDir);
  const resolved = resolvePlan(root, outDir, planPath);
  const result = await generateApprovedContractProposals(resolved.plan, { projectDir: root });
  atomicJson(resolved.file, result.plan);
  return { operation: "generate-plan", ...result, planPath: resolved.file, project: readProductProject({ projectDir: root, outDir }) };
}

export async function validateProductPlan({
  projectDir,
  outDir = ".tapp",
  planPath = "",
  items = [],
  platform = "",
  url = "",
  target = "",
  bundleId = "",
  appId = "",
  apkPath = "",
  serial = "",
  timeout = 600,
  testEmail,
  testPassword,
  startWebTarget,
  stopWebTarget,
  onProgress = () => {},
} = {}) {
  const root = realProject(projectDir);
  const resolved = resolvePlan(root, outDir, planPath);
  let plan = resolved.plan;
  const requested = new Set((items || []).map(String));
  const drafts = (plan.items || []).filter((item) => item.generation?.path && (!requested.size || requested.has(item.id) || requested.has(item.name)));
  if (!drafts.length) throw new Error("No generated contract drafts matched validation");
  const inferred = [...new Set(drafts.flatMap((item) => item.platforms || []))];
  const selectedPlatform = String(platform || (url ? "web" : appId ? "android" : inferred.length === 1 ? inferred[0] : "")).toLowerCase();
  if (!["ios", "android", "web"].includes(selectedPlatform)) throw new Error("A concrete ios|android|web platform is required");
  const platformDrafts = drafts.filter((item) => (item.platforms || []).includes(selectedPlatform));
  if (!platformDrafts.length) throw new Error(`No selected generated drafts apply to ${selectedPlatform}`);
  if (selectedPlatform === "android" && !appId) throw new Error("Android draft validation requires an application id");
  if (selectedPlatform === "ios" && !bundleId) throw new Error("iOS draft validation requires a bundle id");
  let managed = null;
  const results = [];
  try {
    if (selectedPlatform === "web" && !url) {
      if (typeof startWebTarget !== "function") throw new Error("No managed web-target capability was provided");
      managed = await startWebTarget({ root, requestedTarget: target, timeout, onStatus: (text) => onProgress({ phase: "runtime", text }) });
      if (managed?.error) throw new Error(managed.error);
      url = managed.url;
    }
    for (let index = 0; index < platformDrafts.length; index += 1) {
      const item = platformDrafts[index];
      onProgress({ phase: "validate", current: index + 1, total: platformDrafts.length, item: item.name, text: `Replaying ${item.title || item.name}` });
      const contractPath = path.resolve(root, item.generation.path);
      let execution;
      if (!inside(root, contractPath) || !fs.existsSync(contractPath)) {
        execution = { passed: false, stderr: "generated draft file missing", evidence: "" };
      } else {
        execution = await executeReleaseContract({ projectDir: root, contractPath, platform: selectedPlatform, url, bundleId, appId, apkPath, serial, timeout, testEmail, testPassword, onOutput: ({ text }) => onProgress({ phase: "execute", item: item.name, text: text.trim().slice(-500) }) });
      }
      let passed = execution.passed;
      let detail = passed ? "deterministic replay passed" : String(execution.stderr || execution.stdout || "replay failed").trim().slice(-1000);
      let taskUpdates = [];
      if (passed) {
        try { taskUpdates = recordGeneratedTaskProposalValidation({ projectDir: root, item, platform: selectedPlatform, evidence: execution.evidence, detail }); }
        catch (error) { passed = false; detail = `Replay passed but Task validation evidence could not be persisted: ${error.message || String(error)}`; }
      }
      plan = recordContractProposalValidation(plan, { id: item.id, platform: selectedPlatform, passed, evidence: execution.evidence, detail });
      if (taskUpdates.length) plan = mergeGeneratedTaskProposalValidation(plan, taskUpdates);
      results.push({ item: item.name, passed, detail, execution });
    }
  } finally {
    if (managed && typeof stopWebTarget === "function") await stopWebTarget(managed);
  }
  atomicJson(resolved.file, plan);
  return { operation: "validate-plan", platform: selectedPlatform, passed: results.every((item) => item.passed), results, plan, planPath: resolved.file, project: readProductProject({ projectDir: root, outDir }) };
}

export async function promoteProductPlan({ projectDir, outDir = ".tapp", planPath = "", items = [] } = {}) {
  const root = realProject(projectDir);
  const resolved = resolvePlan(root, outDir, planPath);
  const result = await promoteValidatedProposals(resolved.plan, { projectDir: root, ids: items || [] });
  atomicJson(resolved.file, result.plan);
  // Promotion changes the authoritative Task/contract inventory and UI Map coverage. Refresh the
  // derived application model immediately so no adapter can show a stale pre-promotion warning.
  const refreshed = await buildInitArtifacts({ projectDir: root, outDir });
  const written = writeInitArtifacts({ ...refreshed, root: refreshed.root, outDir, refresh: true });
  return { operation: "promote-plan", ...result, plan: written.plan, planPath: written.planPath, modelPath: written.modelPath, project: readProductProject({ projectDir: root, outDir }) };
}

export function prepareProductCi({ projectDir, outDir = ".tapp", modelPath = "", actionRef = DEFAULT_ACTION_REF, defaultBranch = "main" } = {}) {
  const root = realProject(projectDir);
  const modelFile = modelPath ? path.resolve(root, modelPath) : artifactPaths(root, outDir).model;
  if (!inside(root, modelFile)) throw new Error("Application model must remain inside the repository");
  const model = readJson(modelFile);
  if (!model) throw new Error("Application model not found; initialize and explore the project first");
  const rendered = renderGithubWorkflow({ projectDir: root, model, actionRef, defaultBranch });
  return { operation: "prepare-ci", ...rendered, project: readProductProject({ projectDir: root, outDir }) };
}

export function installProductCi({ projectDir, outDir = ".tapp", modelPath = "", actionRef = DEFAULT_ACTION_REF, defaultBranch = "main", workflowPath = ".github/workflows/tapp.yml", manifestPath = ".tapp/ci.json", replace = false, allowUnresolved = false } = {}) {
  const root = realProject(projectDir);
  const rendered = prepareProductCi({ projectDir: root, outDir, modelPath, actionRef, defaultBranch });
  if (rendered.manifest.unresolved.length && !allowUnresolved) throw new Error(`CI installation is unresolved: ${rendered.manifest.unresolved.map((item) => `${item.platform}:${item.message}`).join("; ")}`);
  const written = writeCiInstallation({ projectDir: root, workflow: rendered.workflow, manifest: rendered.manifest, workflowPath, manifestPath, replace });
  return { operation: "install-ci", ...written, project: readProductProject({ projectDir: root, outDir }) };
}

export async function runProductGate({
  projectDir,
  outDir = ".tapp",
  platform = "web",
  target = "",
  url = "",
  appPath = "",
  bundleId = "",
  appId = "",
  apkPath = "",
  serial = "",
  device = "",
  flows = "",
  scenarios = "",
  contracts = "",
  actions = 40,
  timeout = 600,
  baseline = "",
  failOn = "gate",
  testEmail,
  testPassword,
  onProgress = () => {},
} = {}) {
  const root = realProject(projectDir);
  const project = readProductProject({ projectDir: root, outDir });
  if (!project.model) throw new Error("Application model not found; initialize and explore the project first");
  const selected = selectApplicationTarget(project.model, { platform, target });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const runDir = path.join(productRunRoot(root), `${stamp}-${crypto.randomBytes(3).toString("hex")}`);
  fs.mkdirSync(runDir, { recursive: true });
  const reportPath = path.join(runDir, "gate-report.json");
  const markdownPath = path.join(runDir, "gate-report.md");
  const args = [path.join(packageRoot, "scripts", "ci-gate.sh"), "--platform", selected.platform, "--project-dir", root, "--target-key", selected.id, "--actions", String(actions), "--timeout", String(timeout), "--fail-on", failOn, "--json-out", reportPath, "--md-out", markdownPath];
  if (selected.platform === "web") {
    if (url) args.push("--url", url);
    else args.push("--web-target", selected.id);
  } else if (selected.platform === "android") {
    const selectedAppId = appId || selected.runtime?.applicationId || "";
    if (!selectedAppId) throw new Error(`Android gate for ${selected.name} requires an application id`);
    args.push("--app-id", selectedAppId);
    if (apkPath) {
      const absoluteApk = path.resolve(apkPath);
      if (!fs.existsSync(absoluteApk)) throw new Error(`Android APK not found: ${absoluteApk}`);
      args.push("--apk", absoluteApk);
    }
    if (serial) args.push("--serial", serial);
  } else {
    if (!appPath) throw new Error(`iOS gate for ${selected.name} requires a built simulator .app`);
    const absoluteApp = path.resolve(appPath);
    if (!fs.existsSync(absoluteApp)) throw new Error(`iOS simulator app not found: ${absoluteApp}`);
    args.push("--app", absoluteApp);
    if (bundleId) args.push("--bundle-id", bundleId);
  }
  if (device) args.push("--device", device);
  for (const [flag, value] of [["flows", flows], ["scenarios", scenarios], ["contracts", contracts]]) if (value) args.push(`--${flag}`, value);
  if (baseline) {
    const baselinePath = path.resolve(root, baseline);
    if (!inside(root, baselinePath) || !fs.existsSync(baselinePath)) throw new Error("Baseline must be an existing file inside the repository");
    args.push("--baseline", baselinePath);
  } else {
    const targetBaseline = existingBaselinePathForTarget(root, selected);
    if (fs.existsSync(targetBaseline)) args.push("--baseline", targetBaseline);
  }
  onProgress({ phase: "gate", text: `Running ${selected.platform}:${selected.name} release gate` });
  const env = {
    ...process.env,
    ...(typeof testEmail === "string" ? { OCQA_TEST_EMAIL: testEmail } : {}),
    ...(typeof testPassword === "string" ? { OCQA_TEST_PASSWORD: testPassword } : {}),
  };
  const execution = await runProductProcess("bash", args, { cwd: root, env, timeoutMs: Math.max(30, Math.min(3600, Number(timeout) || 600)) * 1000 + 60_000, onOutput: ({ text }) => onProgress({ phase: "gate", text: text.trim().slice(-1000) }) });
  const report = readJson(reportPath);
  return { operation: "run-gate", passed: execution.code === 0, code: execution.code, stdout: execution.stdout, stderr: execution.stderr, selectedTarget: selected, report, reportPath, markdownPath, runDir, project: readProductProject({ projectDir: root, outDir }) };
}

export function createProductBaseline({ projectDir, outDir = ".tapp", reportPath, platform = "web", target = "", replace = false, baselinePath = "" } = {}) {
  const root = realProject(projectDir);
  const project = readProductProject({ projectDir: root, outDir });
  const selected = selectApplicationTarget(project.model, { platform, target });
  const source = path.resolve(reportPath || "");
  const report = readJson(source, { required: true });
  const written = writeTargetBaseline({ projectDir: root, target: selected, report, sourceReport: source, outPath: baselinePath ? path.resolve(root, baselinePath) : "", replace });
  return { operation: "create-baseline", selectedTarget: selected, ...written, project: readProductProject({ projectDir: root, outDir }) };
}

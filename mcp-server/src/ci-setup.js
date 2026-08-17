import fs from "node:fs";
import path from "node:path";
import { existingProjectArtifactPath, projectArtifactDirectory } from "./project-paths.js";

function inside(root, candidate) {
  const value = path.relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${path.sep}`));
}

export function targetSlug(value) {
  const slug = String(value || "target").trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return slug || "target";
}

export function selectApplicationTarget(model, { platform = "", target = "", useDefault = false } = {}) {
  if (model?.kind !== "tapp-application-model" || !Array.isArray(model.targets)) {
    throw new Error("Expected a Tapp application model; run tapp init first");
  }
  const selectedPlatform = String(platform || "").toLowerCase();
  let candidates = model.targets.filter((item) => !selectedPlatform || item.platform === selectedPlatform);
  const requested = String(target || "").trim();
  if (requested) {
    const normalized = requested.replaceAll("\\", "/").replace(/^\.\//, "");
    candidates = candidates.filter((item) => [item.id, item.name, item.sourcePath].some((value) => String(value || "").replaceAll("\\", "/") === normalized));
  }
  // Target-resolution ladder (ADR-0005 §5): explicit narrowing (above) → exactly one candidate →
  // the model's recorded default target (opt-in: `explore` uses it, but the gate/baseline stay
  // strict so CI never silently picks a target) → otherwise list the choices and stop.
  if (candidates.length > 1 && useDefault && !requested) {
    const def = String(model.application?.defaultTargetId || "").trim();
    const chosen = def && candidates.find((item) => item.id === def);
    if (chosen) return chosen;
  }
  if (candidates.length !== 1) {
    const summary = candidates.length ? candidates : model.targets.filter((item) => !selectedPlatform || item.platform === selectedPlatform);
    throw new Error(candidates.length
      ? `Multiple targets match; select one with --target (${summary.map((item) => `${item.platform}:${item.name}`).join(", ")})`
      : `No application target matches${selectedPlatform ? ` platform '${selectedPlatform}'` : ""}${requested ? ` and '${requested}'` : ""}`);
  }
  return candidates[0];
}

// For a bare `tapp explore` in a repo: if the model's default target is a web target with a recorded
// owned URL, return that URL so exploration hits it directly (the `init --url X` → `explore` path).
// Targets that must be built/started from source need the prepare pipeline (wired separately), so
// this returns null and the caller falls back to its normal target resolution.
export function defaultWebExploreUrl(model) {
  let target;
  try {
    target = selectApplicationTarget(model, { useDefault: true });
  } catch {
    return null; // no model, or ambiguous with no recorded default
  }
  if (target?.platform !== "web") return null;
  const url = String(target.runtime?.ownedUrl || "");
  return /^https?:\/\//i.test(url) ? url : null;
}

export function baselinePathForTarget(projectDir, target) {
  const root = fs.realpathSync(path.resolve(projectDir));
  return path.join(root, ".tapp", "baselines", target.platform, `${targetSlug(target.id)}.json`);
}

export function existingBaselinePathForTarget(projectDir, target) {
  const root = fs.realpathSync(path.resolve(projectDir));
  return existingProjectArtifactPath(root, "baselines", target.platform, `${targetSlug(target.id)}.json`);
}

export function validateBaselineReport(report, { platform, targetId } = {}) {
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("Baseline source must be a full Tapp gate report JSON object");
  if (!Array.isArray(report.findings) || !Array.isArray(report.screens)) throw new Error("Baseline source is missing Tapp QA findings/screens evidence");
  if (report.platform !== platform) throw new Error(`Baseline platform '${report.platform || "unknown"}' does not match target platform '${platform}'`);
  const reportTarget = String(report.targetKey || report.baselineIdentity?.targetId || "").trim();
  if (!reportTarget) throw new Error("Baseline source is missing its targetKey; Tapp will not guess which same-platform application produced the evidence");
  if (reportTarget !== targetId) throw new Error(`Baseline target '${reportTarget}' does not match application-model target '${targetId}'`);
  // A trusted baseline must be a clean PASS. The gate outcome is the single authoritative signal
  // (ADR-0005) — reject fail, inconclusive, error, or a missing/unknown outcome, naming which.
  const outcome = report.gate?.outcome;
  if (outcome !== "pass") {
    const why = outcome === "inconclusive" ? "An inconclusive run"
      : outcome === "fail" ? "A failing run"
      : `A non-passing run (${outcome || "no gate outcome"})`;
    throw new Error(`${why} cannot become a trusted baseline; only a passing gate run can`);
  }
  for (const collection of ["flows", "scenarios", "contracts"]) {
    const failed = (report[collection] || []).filter((item) => item.passed !== true);
    if (failed.length) throw new Error(`Baseline source contains ${failed.length} failed ${collection}`);
  }
  return {
    schemaVersion: 1,
    platform,
    targetId,
    conclusive: true,
    outcome: report.gate?.outcome ?? null,
    screensExplored: Number(report.screensExplored || report.screens.length),
    actionsPerformed: Number(report.actionsPerformed || 0),
    suite: {
      flows: (report.flows || []).length,
      scenarios: (report.scenarios || []).length,
      contracts: (report.contracts || []).length,
    },
  };
}

function captureEvidenceReference(value, suffix = "") {
  const normalized = String(value || "").replaceAll("\\", "/");
  const match = normalized.match(/(?:^|\/)captures\/([^/]+)(?:\/|$)/);
  return match ? `tapp-capture:${match[1]}${suffix ? `/${suffix}` : ""}` : "";
}

function portableBaselineReport(report) {
  const artifact = JSON.parse(JSON.stringify(report));
  const markersEvidence = captureEvidenceReference(artifact.relativeMarkersFilePath, "ocqa-markers.txt");
  if (markersEvidence) artifact.markersEvidence = markersEvidence;
  delete artifact.relativeMarkersFilePath;

  if (artifact.uiMap && typeof artifact.uiMap === "object" && !Array.isArray(artifact.uiMap)) {
    const evidence = captureEvidenceReference(artifact.uiMap.path, "ui-map.json");
    artifact.uiMap = { ...artifact.uiMap, ...(evidence ? { evidence } : {}) };
    delete artifact.uiMap.path;
  }
  if (artifact.capture && typeof artifact.capture === "object" && !Array.isArray(artifact.capture)) {
    const id = String(artifact.capture.id || "").trim();
    const evidence = id ? `tapp-capture:${id}` : captureEvidenceReference(artifact.capture.path || artifact.capture.relativePath);
    artifact.capture = { ...(id ? { id } : {}), ...(evidence ? { evidence } : {}) };
  }
  for (const field of ["reportHtml", "recording"]) {
    if (!artifact[field]) continue;
    const evidence = captureEvidenceReference(artifact[field], path.basename(String(artifact[field])));
    if (evidence) artifact[`${field}Evidence`] = evidence;
    delete artifact[field];
  }
  return artifact;
}

export function writeTargetBaseline({ projectDir, target, report, sourceReport = "", outPath = "", replace = false } = {}) {
  const root = fs.realpathSync(path.resolve(projectDir || process.cwd()));
  if (!target?.id || !["ios", "android", "web"].includes(target.platform)) throw new Error("A concrete application-model target is required");
  const validation = validateBaselineReport(report, { platform: target.platform, targetId: target.id });
  const destination = path.resolve(outPath || baselinePathForTarget(root, target));
  if (!inside(root, destination)) throw new Error("Baseline output must remain inside the repository");
  if (fs.existsSync(destination) && !replace) throw new Error(`Baseline already exists at ${path.relative(root, destination)}; inspect it or pass --replace after a reviewed conclusive run`);
  const source = sourceReport ? path.resolve(sourceReport) : "";
  const sourceLabel = source && inside(root, source) ? path.relative(root, source).replaceAll(path.sep, "/") : source ? path.basename(source) : "generated gate report";
  const artifact = {
    ...portableBaselineReport(report),
    baselineIdentity: {
      ...validation,
      createdAt: new Date().toISOString(),
      sourceReport: sourceLabel,
      policy: "platform-and-target-specific; replace only from a reviewed successful conclusive gate",
    },
  };
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, JSON.stringify(artifact, null, 2) + "\n");
  fs.renameSync(temporary, destination);
  return { path: destination, relativePath: path.relative(root, destination).replaceAll(path.sep, "/"), artifact, validation };
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function posix(value) {
  return String(value || "").replaceAll(path.sep, "/").replace(/^\.\//, "");
}

function suiteDirectories(root, target, kind) {
  const candidates = [path.join(root, projectArtifactDirectory(root), kind)];
  if (target.sourcePath && target.sourcePath !== ".") {
    const targetRoot = path.join(root, target.sourcePath);
    candidates.push(path.join(targetRoot, projectArtifactDirectory(targetRoot), kind));
  }
  return [...new Set(candidates)].filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory())
    .map((candidate) => `${posix(path.relative(root, candidate))}/*.yml`);
}

function contractsForTarget(model, target) {
  const source = posix(target.sourcePath || ".");
  return (model.artifacts?.contracts || [])
    .filter((contract) => (contract.platforms || []).includes(target.platform))
    .filter((contract) => {
      const scope = posix(contract.scope || ".");
      return scope === "." || source === "." || source === scope || source.startsWith(`${scope}/`) || scope.startsWith(`${source}/`);
    });
}

function contractPaths(model, target) {
  return contractsForTarget(model, target).map((contract) => posix(contract.path)).sort();
}

function credentialConfiguration(model, targetContracts = []) {
  const hasContractActorMetadata = targetContracts.some((contract) => Array.isArray(contract.actors));
  const actors = hasContractActorMetadata
    ? [...targetContracts.flatMap((contract) => contract.actors || []).reduce((byName, actor) => {
      const prior = byName.get(actor.name) || { name: actor.name, session: actor.session || "default", credentialRequirements: [], credentialBindings: {} };
      for (const requirement of actor.credentialRequirements || []) if (!prior.credentialRequirements.includes(requirement)) prior.credentialRequirements.push(requirement);
      for (const [key, value] of Object.entries(actor.credentialBindings || {})) prior.credentialBindings[key] ||= value;
      if (actor.session === "default") prior.session = "default";
      byName.set(actor.name, prior);
      return byName;
    }, new Map()).values()]
    : (() => {
      const contractNames = new Set(targetContracts.map((contract) => contract.name));
      return (model.actors || []).filter((actor) => actor.configured === true || !(actor.contracts || []).length || actor.contracts.some((name) => contractNames.has(name)));
    })();
  const requirements = new Set(actors.flatMap((actor) => actor.credentialRequirements || []));
  const primary = actors.find((actor) => actor.session === "default") || actors[0] || {};
  const bindings = new Set(actors.flatMap((actor) => Object.values(actor.credentialBindings || {})));
  if (!bindings.size) {
    if (requirements.has("email")) bindings.add("TAPP_TEST_EMAIL");
    if (requirements.has("password")) bindings.add("TAPP_TEST_PASSWORD");
  }
  for (const name of bindings) if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(String(name))) throw new Error(`Actor credential binding '${name}' is not a safe environment-variable name; rerun tapp init from valid .tapp/project.json`);
  const inputs = {};
  const primaryEmail = primary.credentialBindings?.email || (!primary.credentialBindings && requirements.has("email") ? "TAPP_TEST_EMAIL" : "");
  const primaryPassword = primary.credentialBindings?.password || (!primary.credentialBindings && requirements.has("password") ? "TAPP_TEST_PASSWORD" : "");
  if (primaryEmail) inputs["test-email"] = `\${{ secrets.${primaryEmail} }}`;
  if (primaryPassword) inputs["test-password"] = `\${{ secrets.${primaryPassword} }}`;
  const secrets = [...bindings].sort();
  const environment = Object.fromEntries(secrets.map((name) => [name, `\${{ secrets.${name} }}`]));
  return { inputs, environment, secrets };
}

function targetInputs(root, model, target) {
  const inputs = { platform: target.platform, "target-key": target.id };
  const unresolved = [];
  if (target.platform === "ios") {
    if (!target.build?.container) unresolved.push("Xcode project/workspace is unknown");
    if (!target.build?.proposedScheme || target.status !== "configured") unresolved.push("shared iOS scheme has not been validated");
    if (target.build?.container) inputs.project = posix(target.build.container);
    if (target.build?.proposedScheme) inputs.scheme = target.build.proposedScheme;
    inputs.configuration = target.build?.configuration || "Debug";
  } else if (target.platform === "android") {
    if (!target.runtime?.applicationId) unresolved.push("Android application id is unknown");
    const androidProject = posix(target.build?.projectDir || ".");
    const androidProjectPath = path.resolve(root, androidProject);
    const androidProjectRelative = path.relative(root, androidProjectPath);
    if (path.isAbsolute(androidProjectRelative) || androidProjectRelative === ".." || androidProjectRelative.startsWith(`..${path.sep}`)) unresolved.push("Android Gradle project resolves outside the repository");
    else if (!fs.existsSync(path.join(androidProjectPath, "gradlew"))) unresolved.push(`Gradle wrapper is missing from ${androidProject}; commit gradlew or rerun tapp init from the Gradle repository root`);
    inputs["android-project"] = androidProject;
    inputs["android-task"] = target.build?.task || "assembleDebug";
    if (target.runtime?.applicationId) inputs["android-app-id"] = target.runtime.applicationId;
    inputs["android-serial"] = "emulator-5554";
  } else {
    if (target.build?.dependencyStatus === "missing-lockfile") unresolved.push("browser dependency lockfile is missing");
    if (target.runtime?.management === "customer-managed" && target.runtime?.ownedUrl) inputs.url = target.runtime.ownedUrl;
    else if (target.runtime?.management === "tapp-managed") inputs["web-target"] = target.id;
    else unresolved.push("browser runtime has neither an owned URL nor a deterministic managed start path");
  }
  const flows = suiteDirectories(root, target, "flows");
  const scenarios = target.platform === "web" ? suiteDirectories(root, target, "scenarios") : [];
  const targetContracts = contractsForTarget(model, target);
  const contracts = targetContracts.map((contract) => posix(contract.path)).sort();
  if (flows.length) inputs.flows = flows.join(" ");
  if (scenarios.length) inputs.scenarios = scenarios.join(" ");
  if (contracts.length) inputs.contracts = contracts.join(" ");
  const baselinePath = existingBaselinePathForTarget(root, target);
  if (fs.existsSync(baselinePath)) inputs.baseline = posix(path.relative(root, baselinePath));
  const credentials = credentialConfiguration(model, targetContracts);
  Object.assign(inputs, credentials.inputs);
  return { inputs, environment: credentials.environment, requiredSecrets: credentials.secrets, unresolved, baselinePath: fs.existsSync(baselinePath) ? posix(path.relative(root, baselinePath)) : null, contracts };
}

function jobId(target, occupied) {
  const base = targetSlug(`tapp-${target.platform}-${target.name}`).replaceAll("-", "_");
  let value = base;
  let suffix = 2;
  while (occupied.has(value)) value = `${base}_${suffix++}`;
  occupied.add(value);
  return value;
}

const CHECKOUT_SHA = "11d5960a326750d5838078e36cf38b85af677262";
const SETUP_JAVA_SHA = "0f481fcb613427c0f801b606911222b5b6f3083a";

export function renderGithubWorkflow({ projectDir, model, actionRef, defaultBranch = "main" } = {}) {
  const root = fs.realpathSync(path.resolve(projectDir || process.cwd()));
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(String(actionRef || ""))) throw new Error("--action-ref must be owner/repository@release-tag-or-sha");
  if (!/^[A-Za-z0-9._\/-]+$/.test(defaultBranch) || defaultBranch.startsWith("/")) throw new Error("--default-branch contains unsupported characters");
  if (model?.kind !== "tapp-application-model" || !Array.isArray(model.targets) || !model.targets.length) throw new Error("Application model has no targets; run tapp init first");
  const occupied = new Set();
  const jobs = [];
  const manifestTargets = [];
  for (const target of model.targets) {
    const id = jobId(target, occupied);
    const configured = targetInputs(root, model, target);
    manifestTargets.push({ id: target.id, name: target.name, platform: target.platform, job: id, baseline: configured.baselinePath, contracts: configured.contracts, requiredSecrets: configured.requiredSecrets, unresolved: configured.unresolved, inputs: configured.inputs });
    const lines = [];
    lines.push(`  ${id}:`);
    lines.push(`    name: ${yamlString(`Tapp · ${target.platform} · ${target.name}`)}`);
    lines.push(`    runs-on: ${target.platform === "ios" ? "macos-15" : "ubuntu-24.04"}`);
    lines.push(`    timeout-minutes: ${target.platform === "ios" ? 45 : target.platform === "android" ? 40 : 25}`);
    lines.push("    steps:");
    lines.push(`      - uses: actions/checkout@${CHECKOUT_SHA} # v4`);
    if (target.platform === "android") {
      lines.push(`      - uses: actions/setup-java@${SETUP_JAVA_SHA} # v5.5.0`);
      lines.push("        with:");
      lines.push("          distribution: temurin");
      lines.push("          java-version: \"17\"");
      lines.push("          cache: gradle");
      lines.push("      - name: Start Android API 35 emulator");
      lines.push("        shell: bash");
      lines.push("        run: |");
      lines.push("          set -euo pipefail");
      lines.push("          yes | sdkmanager --licenses >/dev/null || true");
      lines.push('          sdkmanager "platform-tools" "emulator" "platforms;android-35" "system-images;android-35;google_apis;x86_64"');
      lines.push('          echo no | avdmanager create avd --force --name tapp-ci --package "system-images;android-35;google_apis;x86_64"');
      lines.push("          sudo chmod 666 /dev/kvm");
      lines.push('          nohup "$ANDROID_HOME/emulator/emulator" -avd tapp-ci -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect >"$RUNNER_TEMP/tapp-emulator.log" 2>&1 &');
      lines.push("          adb wait-for-device");
      lines.push("          for attempt in $(seq 1 120); do");
      lines.push('            [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d \'\\r\')" == "1" ]] && exit 0');
      lines.push("            sleep 2");
      lines.push("          done");
      lines.push('          cat "$RUNNER_TEMP/tapp-emulator.log"');
      lines.push("          exit 1");
    }
    lines.push("      - name: Tapp release gate");
    lines.push(`        uses: ${actionRef}`);
    lines.push("        with:");
    for (const [key, value] of Object.entries(configured.inputs)) lines.push(`          ${key}: ${yamlString(value)}`);
    if (Object.keys(configured.environment).length) {
      lines.push("        env:");
      for (const [key, value] of Object.entries(configured.environment)) lines.push(`          ${key}: ${yamlString(value)}`);
    }
    jobs.push(lines.join("\n"));
  }
  const workflow = [
    "# Generated by `tapp ci install` from .tapp/application-model.json.",
    "# Review this patch. Tapp never overwrites it silently.",
    "name: Tapp release gate",
    "",
    "on:",
    "  pull_request:",
    "  push:",
    `    branches: [${yamlString(defaultBranch)}]`,
    "",
    "permissions:",
    "  actions: read",
    "  contents: read",
    "  pull-requests: write",
    "",
    "concurrency:",
    "  group: tapp-${{ github.workflow }}-${{ github.ref }}",
    "  cancel-in-progress: true",
    "",
    "jobs:",
    jobs.join("\n\n"),
    "",
  ].join("\n");
  const unresolved = manifestTargets.flatMap((target) => target.unresolved.map((message) => ({ targetId: target.id, platform: target.platform, message })));
  const targetRequirementSuffixes = new Set(["scheme", "application-id", "owned-url", "dependency-lock"]);
  for (const requirement of (model.requirements || []).filter((item) => item.severity === "blocking")) {
    const target = model.targets.find((candidate) => String(requirement.id || "").startsWith(`${candidate.id}:`));
    const suffix = target ? String(requirement.id).slice(target.id.length + 1) : "";
    if (target && targetRequirementSuffixes.has(suffix)) continue;
    const message = `${requirement.message}${requirement.remediation ? ` Next: ${requirement.remediation}` : ""}`;
    if (!unresolved.some((item) => item.message === message)) unresolved.push({ targetId: target?.id || "application-model", platform: target?.platform || "repository", message });
  }
  const requiredSecrets = [...new Set(manifestTargets.flatMap((target) => target.requiredSecrets))].sort();
  const manifest = {
    schemaVersion: 1,
    kind: "tapp-ci-installation",
    status: unresolved.length ? "requires-configuration" : "ready-for-review",
    workflowPath: ".github/workflows/tapp.yml",
    actionRef,
    actionRefImmutable: /@[a-f0-9]{40}$/.test(actionRef),
    defaultBranch,
    targets: manifestTargets,
    unresolved,
    policy: { criticalContracts: "every PR", diffRelevantContracts: "every PR", autonomousExploration: "bounded every PR", baseline: "platform-and-target-specific", aiRequired: false },
    security: { customerValuesInterpolatedIntoShellSource: false, secrets: requiredSecrets, thirdPartyActionsPinned: true },
    generatedAt: new Date().toISOString(),
  };
  return { workflow, manifest };
}

export function writeCiInstallation({ projectDir, workflow, manifest, workflowPath = ".github/workflows/tapp.yml", manifestPath = ".tapp/ci.json", replace = false } = {}) {
  const root = fs.realpathSync(path.resolve(projectDir || process.cwd()));
  const destinations = [path.resolve(root, workflowPath), path.resolve(root, manifestPath)];
  for (const destination of destinations) if (!inside(root, destination)) throw new Error("CI installation outputs must remain inside the repository");
  const existing = destinations.filter((destination) => fs.existsSync(destination));
  if (existing.length && !replace) throw new Error(`CI installation never overwrites existing files: ${existing.map((item) => posix(path.relative(root, item))).join(", ")}`);
  for (const destination of destinations) fs.mkdirSync(path.dirname(destination), { recursive: true });
  const renderedManifest = { ...manifest, workflowPath: posix(path.relative(root, destinations[0])) };
  const values = [workflow.endsWith("\n") ? workflow : workflow + "\n", JSON.stringify(renderedManifest, null, 2) + "\n"];
  for (let index = 0; index < destinations.length; index += 1) {
    const temporary = `${destinations[index]}.tmp-${process.pid}-${Date.now()}-${index}`;
    fs.writeFileSync(temporary, values[index]);
    fs.renameSync(temporary, destinations[index]);
  }
  return { workflowPath: destinations[0], manifestPath: destinations[1], manifest: renderedManifest };
}

#!/usr/bin/env node
// tapp CLI — ship with proof.
//
//   Zero-config verbs (the same engine the MCP tools use, exported by mcp-server/src/index.js):
//   tapp explore <bundleId|appId|url> Autonomous exploration → findings + evidence (observation)
//   tapp open <bundleId>     Launch app → screen summary + screenshot file
//   tapp tree <bundleId>     Accessibility tree of the current screen
//   tapp shot                Screenshot the booted simulator
//   tapp report [captureId]  Open the HTML evidence page
//   tapp app [repo]          Open the browser release-contract workspace
//   tapp ci ...              Merge-blocking release gate (passthrough to ci-gate.sh)
//
//   tapp mcp        Start the MCP server on stdio (inline screenshots + interactive sessions)
//   tapp install    Prebuild the exploration harness for the booted simulator
//   tapp doctor     Check the toolchain (Xcode, simctl, node, harness cache)
//
// All writable output (captures, harness build cache) goes to ~/.tapp (override
// with TAPP_HOME). The package directory itself is never written to.

import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existingProjectArtifactPath, isProjectArtifactDirectory } from "../mcp-server/src/project-paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));

// Redirect all writable output away from the (possibly read-only) package dir.
// The old environment alias remains a read-only fallback for older integrations.
const tappHome = (process.env.TAPP_HOME || path.join(os.homedir(), ".tapp")).trim();
process.env.TAPP_HOME = tappHome;
// TAPP_HOME is created lazily (just before the switch) so `--help`, `help`, and `version` never
// write anything — not even the home directory.

let [, , command = "help", ...rest] = process.argv;

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return {
    code: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function ok(label, detail = "") {
  console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
}
function bad(label, detail = "") {
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
}

function bootedSims() {
  const r = run("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
  if (r.code !== 0) return [];
  try {
    const d = JSON.parse(r.stdout);
    return Object.values(d.devices || {})
      .flat()
      .filter((x) => x.state === "Booted");
  } catch {
    return [];
  }
}

function bootBestSimulator(preferredName = "iPhone 16 Pro") {
  const r = run("xcrun", ["simctl", "list", "devices", "available", "-j"]);
  if (r.code !== 0) return null;
  let candidates = [];
  try {
    const d = JSON.parse(r.stdout);
    // Newest runtime first, iPhones only, preferred name wins.
    candidates = Object.entries(d.devices || {})
      .sort(([a], [b]) => b.localeCompare(a))
      .flatMap(([, devices]) => devices)
      .filter((x) => (x.isAvailable ?? true) && x.name.startsWith("iPhone"));
  } catch {
    return null;
  }
  const pick = candidates.find((x) => x.name === preferredName) || candidates[0];
  if (!pick) return null;
  console.log(`Booting ${pick.name} (${pick.udid})…`);
  run("xcrun", ["simctl", "boot", pick.udid]);
  const status = run("xcrun", ["simctl", "bootstatus", pick.udid, "-b"]);
  return status.code === 0 ? pick : null;
}

function harnessXctestrun() {
  const dir = path.join(tappHome, "harness-derived", "Build", "Products");
  try {
    const found = fs.readdirSync(dir).find((f) => f.endsWith(".xctestrun"));
    return found ? path.join(dir, found) : null;
  } catch {
    return null;
  }
}

// Flags/positionals for the zero-config verbs (qa/open/tree/shot). `--key value` or bare `--key`.
function parseVerbArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

function repeatedFlagValues(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== `--${name}`) continue;
    const value = argv[index + 1];
    if (value !== undefined && !value.startsWith("--")) values.push(value);
  }
  return values;
}

function iosLaunchOptions(flags, argv) {
  const appLaunchArgs = repeatedFlagValues(argv, "launch-arg");
  let appLaunchEnv;
  if (typeof flags["launch-env"] === "string") {
    try {
      const parsed = JSON.parse(flags["launch-env"]);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.values(parsed).some((value) => typeof value !== "string")) {
        throw new Error("expected a JSON object with string values");
      }
      appLaunchEnv = parsed;
    } catch (error) {
      console.error(`❌ --launch-env must be a JSON object with string values: ${error.message}`);
      process.exit(2);
    }
  }
  return {
    ...(appLaunchArgs.length ? { appLaunchArgs } : {}),
    ...(appLaunchEnv ? { appLaunchEnv } : {}),
  };
}

const engineImport = () => import(path.join(packageRoot, "mcp-server", "src", "index.js"));

function requireMacFor(what) {
  if (process.platform === "darwin") return;
  console.error(`❌ ${what} requires macOS (Xcode + iOS simulator). The web beta runs anywhere: tapp explore https://localhost:3000`);
  process.exit(1);
}

function ensureIOSHarness() {
  const result = spawnSync("bash", [path.join(packageRoot, "scripts", "quick-capture.sh"), "build-harness"], {
    stdio: "inherit",
    env: process.env,
  });
  if ((result.status ?? 1) !== 0) {
    console.error("❌ Could not prepare the iOS test harness.");
    process.exit(result.status ?? 1);
  }
}

function requestedPlatform(flags, target = "") {
  if (typeof flags.platform === "string") return flags.platform.toLowerCase();
  if (/^https?:\/\//i.test(target)) return "web";
  if (/\.apk$/i.test(target)) return "android";
  return "ios";
}

function androidTarget(flags, target = "") {
  const targetIsApk = /\.apk$/i.test(target);
  const apkPath = targetIsApk ? path.resolve(target) : typeof flags.apk === "string" ? path.resolve(flags.apk) : "";
  const appId = typeof flags["app-id"] === "string" ? flags["app-id"] : targetIsApk ? "" : target;
  if (!appId) {
    console.error("❌ Android needs an application id: --app-id com.example.app (an APK alone does not reliably identify the launch target)");
    process.exit(2);
  }
  if (apkPath && !fs.existsSync(apkPath)) {
    console.error(`❌ APK not found: ${apkPath}`);
    process.exit(2);
  }
  return { appId, apkPath: apkPath || undefined, serial: typeof flags.serial === "string" ? flags.serial : undefined };
}

function saveShot(img, outFlag, name) {
  const out = outFlag || path.join(tappHome, "shots", name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(img.data, "base64"));
  return out;
}

function printEngineError(r) {
  console.error(`❌ ${r.error}`);
  if (r.details && Array.isArray(r.details.errors) && r.details.errors.length) {
    console.error(r.details.errors.map((e) => "  " + e.trim()).join("\n"));
  }
}

// Turn whatever the user gave us (nothing / repo dir / .app / bundle id) into an installed
// bundle id, narrating build/install progress on stderr.
async function resolveTargetOrExit(engine, input) {
  const resolved = await engine.resolveAppTarget(input || "", { onStatus: (s) => console.error(`⏳ ${s}`) });
  if (resolved.error) {
    printEngineError(resolved);
    process.exit(1);
  }
  if (resolved.via) console.error(`🎯 Target: ${resolved.bundleId} — ${resolved.via}`);
  return resolved.bundleId;
}

function safeCommandUsage(verb) {
  const usage = {
    explore: "tapp explore [target] [--platform ios|android|web] [--actions N] [--timeout SEC] [--email VALUE] [--password VALUE] [--baseline FILE] [--json FILE]\n  iOS launch configuration: [--launch-arg VALUE ...] [--launch-env '{\"KEY\":\"VALUE\"}']\n  Android: [--app-id ID] [--apk FILE] [--serial ID] [--keep-data]",
    init: "tapp init [repo] [--explore] [--refresh] [--platform PLATFORM] [--target NAME] [--url URL] [--dry-run]",
    open: "tapp open [target] [--platform ios|android|web] [--out FILE] [--tap TEXT] [--wait-for TEXT]",
    tree: "tapp tree [target] [--platform ios|android|web] [--json] [--tap TEXT] [--wait-for TEXT]",
    shot: "tapp shot [--out FILE]",
    apps: "tapp apps",
    build: "tapp build [repo] [--scheme NAME] [--configuration NAME]",
    flow: "tapp flow validate FILE [--platform PLATFORM] [--map FILE]\ntapp flow run FILE [--email VALUE] [--password VALUE]",
    task: "tapp task validate FILE [--platform PLATFORM] [--map FILE]\ntapp task compile FILE --platform PLATFORM [--inputs JSON] [--out FILE]\ntapp task run FILE --platform PLATFORM [--url URL|--bundle-id ID|--app-id ID] [--inputs JSON]",
    contract: "tapp contract validate FILE [--platform PLATFORM] [--map FILE]\ntapp contract compile FILE --platform PLATFORM [--out FILE]\ntapp contract run FILE --platform PLATFORM [--url URL|--bundle-id ID|--app-id ID]",
    scenario: "tapp scenario validate FILE [--project-dir DIR]\ntapp scenario run FILE --platform web --url URL [--project-dir DIR]",
    map: "tapp map build MARKERS [--platform PLATFORM] [--out FILE] [--replace]\ntapp map inspect [FILE]\ntapp map diff BEFORE AFTER [--comparable]",
    pr: "tapp pr plan [--base REF|--changed-files FILE] [--head REF] [--platform PLATFORM] [--out FILE]\ntapp pr gate PLAN [gate target/options]\ntapp pr adopt PLAN --item ID [--project-dir DIR]",
    plan: "tapp plan show [FILE]\ntapp plan review [FILE] --approve NAME[,NAME] --reject NAME[,NAME] --defer NAME[,NAME]\ntapp plan generate|validate|promote [FILE] [options]",
    baseline: "tapp baseline create [repo] [--platform PLATFORM] [--target NAME] [--from GATE.json] [--replace]",
    actor: "tapp actor set NAME --email-env ENV --password-env ENV [--project-dir DIR]\ntapp actor list [repo]",
    app: "tapp app [repo] [--no-open] [--port PORT]",
    report: "tapp report [captureId|latest]",
    doctor: "tapp doctor",
    install: "tapp install",
    mcp: "tapp mcp",
  };
  return usage[verb] || `tapp ${verb}`;
}

// Safe help: `--help`/`-h` on ANY verb prints the command reference and does NOTHING else — never
// builds, launches, writes, or opens (ADR-0005 manual-testing requirement). `ci` keeps its own
// richer `--help` (a safe usage print in ci-gate.sh); help/version don't need interception.
if ((rest.includes("--help") || rest.includes("-h")) && !["help", "version", "--version", "-v", "ci"].includes(command)) {
  console.log(`Usage:\n  ${safeCommandUsage(command).replaceAll("\n", "\n  ")}\n\nℹ️  --help never builds, launches, writes, or opens. Full command reference:\n`);
  command = "help";
  rest = [];
}

// Create TAPP_HOME only for commands that actually use it — never for help/version/--help.
if (!["help", "version", "--version", "-v"].includes(command)) {
  fs.mkdirSync(tappHome, { recursive: true });
}

switch (command) {
  case "mcp": {
    // Agents spawn `tapp mcp`; the engine module is import-safe, so start explicitly.
    const { startMcpServer } = await engineImport();
    await startMcpServer();
    break;
  }

  case "init": {
    const { flags, positionals } = parseVerbArgs(rest);
    const projectDir = path.resolve(positionals[0] || process.cwd());
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
      console.error(`❌ Repository directory not found: ${projectDir}`);
      process.exit(2);
    }
    const maxContracts = flags["max-contracts"] === undefined ? 15 : Number(flags["max-contracts"]);
    if (!Number.isInteger(maxContracts) || maxContracts < 1 || maxContracts > 50) {
      console.error("❌ --max-contracts must be an integer from 1 to 50");
      process.exit(2);
    }
    const explore = flags.explore === true;
    if (explore && flags["dry-run"] === true) {
      console.error("❌ --explore writes grounded UI Map evidence and cannot be combined with --dry-run");
      process.exit(2);
    }
    const outDir = typeof flags["out-dir"] === "string" ? flags["out-dir"] : ".tapp";
    const artifactDir = path.resolve(projectDir, outDir);
    if (!artifactDir.startsWith(projectDir + path.sep) && artifactDir !== projectDir) {
      console.error("❌ --out-dir must remain inside the repository");
      process.exit(2);
    }
    const platform = typeof flags.platform === "string" ? flags.platform.toLowerCase()
      : typeof flags.url === "string" ? "web"
      : typeof flags["app-id"] === "string" || typeof flags.apk === "string" ? "android" : "ios";
    if (explore && platform === "ios") requireMacFor("iOS init exploration");
    const actions = flags.actions === undefined ? 40 : Number(flags.actions);
    const timeout = flags.timeout === undefined ? 600 : Number(flags.timeout);
    if (!Number.isInteger(actions) || actions < 1 || !Number.isInteger(timeout) || timeout < 1) {
      console.error("❌ --actions and --timeout must be positive integers");
      process.exit(2);
    }
    const engine = explore ? await engineImport() : null;
    const { initializeProductProject } = await import(path.join(packageRoot, "mcp-server", "src", "product-operations.js"));
    let result;
    try {
      result = await initializeProductProject({
        projectDir,
        mode: flags["dry-run"] === true ? "inspect" : explore ? "explore" : flags.refresh === true ? "refresh" : "write",
        ownedUrl: typeof flags.url === "string" ? flags.url : "",
        platform: typeof flags.platform === "string" ? flags.platform.toLowerCase() : explore ? platform : "",
        target: typeof flags.target === "string" ? flags.target : projectDir,
        bundleId: typeof flags["bundle-id"] === "string" ? flags["bundle-id"] : "",
        appId: typeof flags["app-id"] === "string" ? flags["app-id"] : "",
        apkPath: typeof flags.apk === "string" ? path.resolve(flags.apk) : undefined,
        serial: typeof flags.serial === "string" ? flags.serial : undefined,
        maxActions: actions,
        timeout,
        testEmail: typeof flags.email === "string" ? flags.email : undefined,
        testPassword: typeof flags.password === "string" ? flags.password : undefined,
        runExploration: engine?.runInitExploration,
        onProgress: (progress) => process.stderr.write(`\r🔍 Import exploration… ${progress.action}/${progress.max || actions} actions · ${progress.states} ${platform === "web" ? "pages reached" : platform === "ios" ? "structural states observed" : "screens reached"}   `),
        onStatus: (status) => console.error(`⏳ ${status}`),
        outDir,
        maxContracts,
      });
    } catch (error) {
      if (explore) process.stderr.write("\n");
      console.error(`❌ Could not initialize repository: ${error.message || String(error)}`);
      process.exit(2);
    }
    if (explore) process.stderr.write("\n");
    const built = { model: result.model, plan: result.plan };
    const written = result.written;
    const exploration = result.exploration;
    if (typeof flags["json-out"] === "string") {
      const out = path.resolve(flags["json-out"]);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ model: built.model, plan: written?.plan || built.plan, ...(exploration ? { exploration } : {}) }, null, 2) + "\n");
    }
    const blocking = built.model.requirements.filter((item) => item.severity === "blocking");
    const pending = (written?.plan || built.plan).items.filter((item) => item.decision === "pending");
    console.log(`🧭 Tapp init — ${built.model.application.name}`);
    console.log(`   targets: ${built.model.targets.length ? built.model.targets.map((target) => `${target.platform}:${target.name}`).join(", ") : "none"}`);
    console.log(`   UI Map: ${built.model.uiMap.status} · ${built.model.uiMap.nodeCount} states · ${built.model.uiMap.edgeCount} transitions`);
    if (exploration) console.log(`   Exploration: ${(exploration.findings || []).length} finding(s)${exploration.inconclusive ? " (inconclusive)" : ""} · ${exploration.uiMap.nodeCount} states · evidence: ${exploration.reportHtml || exploration.capture?.path || "capture recorded"}`);
    if (exploration?.managedRuntime) console.log(`   Managed web runtime: built/started ${exploration.target} for exploration and stopped it afterward · log: ${exploration.runtime.logPath}`);
    console.log(`   release plan: ${(written?.plan || built.plan).items.length} item(s) · ${pending.length} pending review · ${blocking.length} blocking requirement(s)`);
    for (const requirement of built.model.requirements) console.log(`   ${requirement.severity === "blocking" ? "❌" : "⚠️"} ${requirement.message} Next: ${requirement.remediation}`);
    if (written) console.log(`   model: ${written.modelPath}\n   plan: ${written.planPath}`);
    else console.log("   dry run: repository files were not changed");
    break;
  }

  case "plan": {
    const { flags, positionals } = parseVerbArgs(rest);
    const verb = positionals[0] || "show";
    const planPath = positionals[1] ? path.resolve(positionals[1]) : existingProjectArtifactPath(process.cwd(), "release-plan.json");
    if (!fs.existsSync(planPath)) {
      console.error(`❌ Release plan not found: ${planPath}`);
      process.exit(2);
    }
    let plan;
    try { plan = JSON.parse(fs.readFileSync(planPath, "utf8")); }
    catch (error) { console.error(`❌ Invalid release plan: ${error.message}`); process.exit(2); }
    if (verb === "show") {
      console.log(`📋 ${plan.application?.name || "Tapp"} release plan — ${plan.status}`);
      for (const item of plan.items || []) console.log(`   ${item.decision === "approved" || item.decision === "accepted" ? "✅" : item.decision === "rejected" ? "❌" : "⏳"} ${item.name} · ${item.criticality} · ${item.decision} · ${item.origin}`);
      break;
    }
    if (verb === "generate") {
      const projectDir = path.resolve(typeof flags["project-dir"] === "string" ? flags["project-dir"] : process.cwd());
      const { generateProductPlan } = await import(path.join(packageRoot, "mcp-server", "src", "product-operations.js"));
      let generated;
      try { generated = await generateProductPlan({ projectDir, planPath }); }
      catch (error) { console.error(`❌ Could not generate contract drafts: ${error.message || String(error)}`); process.exit(2); }
      console.log(`🧩 Contract drafts — ${generated.generated.length} compile-checked/untrusted · ${generated.blocked.length} blocked · ${generated.generatedTasks.length} grounded Task draft(s)`);
      for (const task of generated.generatedTasks) console.log(`   🧭 ${task.name} → ${task.path} (${task.platforms.join(", ")}); real replay still required`);
      for (const item of generated.generated) console.log(`   ✅ ${item.name} → ${item.path} (${item.staticValidation.map((entry) => `${entry.platform}:${entry.deterministicSteps}`).join(", ")}); real replay still required`);
      for (const item of generated.blocked) console.log(`   ⚠️ ${item.name}: ${item.reason}`);
      break;
    }
    if (verb === "validate") {
      const projectDir = path.resolve(typeof flags["project-dir"] === "string" ? flags["project-dir"] : process.cwd());
      const { validateProductPlan } = await import(path.join(packageRoot, "mcp-server", "src", "product-operations.js"));
      const engine = await engineImport();
      let validation;
      try {
        validation = await validateProductPlan({
          projectDir, planPath,
          items: typeof flags.item === "string" ? flags.item.split(",").map((item) => item.trim()).filter(Boolean) : [],
          platform: typeof flags.platform === "string" ? flags.platform.toLowerCase() : "",
          url: typeof flags.url === "string" ? flags.url : "",
          target: typeof flags.target === "string" ? flags.target : "",
          bundleId: typeof flags["bundle-id"] === "string" ? flags["bundle-id"] : "",
          appId: typeof flags["app-id"] === "string" ? flags["app-id"] : "",
          apkPath: typeof flags.apk === "string" ? path.resolve(flags.apk) : "",
          serial: typeof flags.serial === "string" ? flags.serial : "",
          timeout: flags.timeout,
          testEmail: typeof flags.email === "string" ? flags.email : undefined,
          testPassword: typeof flags.password === "string" ? flags.password : undefined,
          startWebTarget: engine.startManagedWebTarget,
          stopWebTarget: engine.stopManagedWebTarget,
          onProgress: (entry) => { if (entry.text) console.error(`⏳ ${entry.text}`); },
        });
      } catch (error) {
        console.error(`❌ Could not validate contract drafts: ${error.message || String(error)}`);
        process.exit(2);
      }
      for (const item of validation.results) {
        if (item.execution.stdout) process.stdout.write(item.execution.stdout + "\n");
        if (item.execution.stderr) process.stderr.write(item.execution.stderr + "\n");
      }
      const failed = validation.results.filter((item) => !item.passed).length;
      console.log(`🔎 Draft validation — ${validation.results.length - failed} passed · ${failed} failed on ${validation.platform}; trust requires every declared platform`);
      if (failed) process.exit(1);
      break;
    }
    if (verb === "promote") {
      const projectDir = path.resolve(typeof flags["project-dir"] === "string" ? flags["project-dir"] : process.cwd());
      const ids = typeof flags.item === "string" ? flags.item.split(",").map((item) => item.trim()).filter(Boolean) : [];
      const { promoteProductPlan } = await import(path.join(packageRoot, "mcp-server", "src", "product-operations.js"));
      let promoted;
      try { promoted = await promoteProductPlan({ projectDir, planPath, items: ids }); }
      catch (error) { console.error(`❌ Could not promote validated proposals: ${error.message || String(error)}`); process.exit(2); }
      console.log(`📦 Promoted validated proposals — ${promoted.promotedTasks.length} Task(s) · ${promoted.promotedContracts.length} release contract(s) · UI Map coverage updated`);
      for (const task of promoted.promotedTasks) console.log(`   🧭 ${task.name} → ${task.path}`);
      for (const contract of promoted.promotedContracts) console.log(`   ✅ ${contract.name} → ${contract.path}`);
      break;
    }
    if (verb !== "review") {
      console.error("usage: tapp plan show [.tapp/release-plan.json]\n       tapp plan review [.tapp/release-plan.json] --approve name[,name] --reject name[,name] --defer name[,name]\n       tapp plan generate [.tapp/release-plan.json] [--project-dir DIR]\n       tapp plan validate [.tapp/release-plan.json] --project-dir DIR --platform web [--url URL] [--target NAME|PATH]\n       tapp plan promote [.tapp/release-plan.json] --project-dir DIR [--item name[,name]]");
      process.exit(2);
    }
    const list = (value) => typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
    const decisions = { approve: list(flags.approve), reject: list(flags.reject), defer: list(flags.defer) };
    if (!Object.values(decisions).some((items) => items.length)) {
      console.error("❌ Provide at least one --approve, --reject, or --defer decision");
      process.exit(2);
    }
    const { reviewProductPlan } = await import(path.join(packageRoot, "mcp-server", "src", "product-operations.js"));
    const reviewProjectDir = typeof flags["project-dir"] === "string" ? path.resolve(flags["project-dir"])
      : isProjectArtifactDirectory(path.basename(path.dirname(planPath))) ? path.dirname(path.dirname(planPath)) : path.dirname(planPath);
    try { plan = reviewProductPlan({ projectDir: reviewProjectDir, planPath, ...decisions }).plan; }
    catch (error) { console.error(`❌ Could not review release plan: ${error.message || String(error)}`); process.exit(2); }
    console.log(`✅ Release plan updated — ${plan.items.filter((item) => ["approved", "accepted"].includes(item.decision)).length} accepted/approved · ${plan.items.filter((item) => item.decision === "rejected").length} rejected · ${plan.items.filter((item) => item.decision === "pending").length} pending`);
    break;
  }

  // ---- Zero-config verbs: the same engine the MCP tools use (exported by index.js),
  // invokable by any agent or human with no server setup at all.

  case "explore":
  case "qa": {
    // `explore` is the canonical verb (ADR-0005: exploration observes; the gate judges). `qa` is a
    // hidden deprecated alias.
    if (command === "qa") console.error("note: 'qa' is now 'explore' — 'qa' still works for now.\n");
    const { flags, positionals } = parseVerbArgs(rest);
    const launchOptions = iosLaunchOptions(flags, rest);
    let target = positionals[0] || "";
    let baselineFindings;
    if (flags.baseline) {
      try {
        const parsed = JSON.parse(fs.readFileSync(flags.baseline, "utf8"));
        baselineFindings = Array.isArray(parsed) ? parsed : parsed.findings;
      } catch (e) {
        console.error(`❌ Could not read baseline ${flags.baseline}: ${e.message}`);
        process.exit(2);
      }
    }
    const engine = await engineImport();
    // Source-preparing bare explore (ADR-0005 §5): no explicit target + a repo application model →
    // drive the model's default target end to end. Managed web is built/started/waited-for and
    // always stopped; iOS is built + installed on the simulator; Android is built to an APK +
    // installed. `--platform`/`--target` narrow which model target is chosen. With no model we fall
    // through to the ordinary target resolution below, so nothing regresses.
    if (!target && !flags["app-id"] && !flags.apk) {
      const modelPath = existingProjectArtifactPath(process.cwd(), "application-model.json");
      if (modelPath && fs.existsSync(modelPath)) {
        const modelPlatform = typeof flags.platform === "string" ? flags.platform.toLowerCase() : "";
        if (modelPlatform === "ios") requireMacFor("iOS testing");
        const onProgress = (p) =>
          process.stderr.write(`\r🔍 Exploring… ${p.action}/${p.max || flags.actions || 60} actions · ${p.states} states observed   `);
        const r = await engine.runExploreTarget({
          projectDir: process.cwd(),
          platform: modelPlatform,
          target: typeof flags.target === "string" ? flags.target : "",
          maxActions: flags.actions,
          timeout: flags.timeout,
          testEmail: flags.email,
          testPassword: flags.password,
          ...launchOptions,
          baselineFindings,
          surface: "cli",
          onProgress,
          onStatus: (t) => console.error(`ℹ️  ${t}`),
        });
        process.stderr.write("\n");
        if (r.error) { printEngineError(r); process.exit(1); }
        console.log(r.text);
        if (flags.json && typeof flags.json === "string") {
          fs.writeFileSync(flags.json, JSON.stringify(r.structured, null, 2));
          console.log(`\n📄 Full report JSON: ${flags.json} (pass as --baseline next run to diff regressions)`);
        }
        break;
      }
    }
    const platform = requestedPlatform(flags, target);
    if (!["ios", "android", "web"].includes(platform)) {
      console.error("❌ --platform must be ios|android|web");
      process.exit(2);
    }
    if (platform === "ios") requireMacFor("iOS testing");
    if (platform !== "ios" && Object.keys(launchOptions).length) {
      console.error("❌ --launch-arg and --launch-env apply only to iOS targets");
      process.exit(2);
    }
    if (platform === "web" && !/^https?:\/\//i.test(target)) {
      console.error("❌ Web QA needs an http(s) URL");
      process.exit(2);
    }
    const bundleId = platform === "ios" ? await resolveTargetOrExit(engine, target) : null;
    const android = platform === "android" ? androidTarget(flags, target) : null;
    const progressMetric = platform === "web" ? "pages reached" : platform === "ios" ? "structural states observed" : "screens reached";
    const onProgress = (p) =>
      process.stderr.write(`\r🔍 Exploring… ${p.action}/${p.max || flags.actions || 60} actions · ${p.states} ${progressMetric}   `);
    const r = platform === "web"
      ? await engine.runQaWeb({
          url: target,
          maxActions: flags.actions,
          timeout: flags.timeout,
          testEmail: flags.email,
          testPassword: flags.password,
          baselineFindings,
          surface: "cli",
          onProgress,
        })
      : platform === "android"
      ? await engine.runQaAndroid({
          ...android,
          maxActions: flags.actions,
          timeout: flags.timeout,
          testEmail: flags.email,
          testPassword: flags.password,
          baselineFindings,
          clearData: flags["keep-data"] !== true,
          surface: "cli",
          onProgress,
        })
      : await engine.runQaIos({
          bundleId,
          maxActions: flags.actions,
          timeout: flags.timeout,
          args: { testEmail: flags.email, testPassword: flags.password, baselineFindings, ...launchOptions },
          surface: "cli",
          onProgress,
        });
    process.stderr.write("\n");
    if (r.error) {
      printEngineError(r);
      process.exit(1);
    }
    console.log(r.text);
    if (flags.json && typeof flags.json === "string") {
      fs.writeFileSync(flags.json, JSON.stringify(r.structured, null, 2));
      console.log(`\n📄 Full report JSON: ${flags.json} (pass as --baseline next run to diff regressions)`);
    }
    break;
  }

  case "open": {
    const { flags, positionals } = parseVerbArgs(rest);
    const engine = await engineImport();
    const platform = requestedPlatform(flags, positionals[0] || "");
    if (platform === "web") {
      const url = positionals[0] || "";
      if (!/^https?:\/\//i.test(url)) {
        console.error("❌ Web open needs an http(s) URL");
        process.exit(2);
      }
      try {
        const { inspectWebPage } = await import(path.join(packageRoot, "mcp-server", "src", "web-explorer.js"));
        const snap = await inspectWebPage({
          url,
          timeoutMs: Number(flags.timeout) * 1000 || 15_000,
          tapText: typeof flags.tap === "string" ? flags.tap : "",
          waitForText: typeof flags["wait-for"] === "string" ? flags["wait-for"] : "",
        });
        const out = typeof flags.out === "string" ? path.resolve(flags.out) : path.join(tappHome, "shots", `web-${Date.now()}.png`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, snap.image);
        console.log(`🌐 Opened \`${snap.url}\`\n`);
        if (typeof flags.tap === "string") console.log(`👆 Tapped \`${flags.tap}\`\n`);
        if (typeof flags["wait-for"] === "string") console.log(`⏳ Found \`${flags["wait-for"]}\`\n`);
        console.log(engine.formatScreen(snap.screenTitle, snap.elements));
        console.log(`\n📸 Screenshot: ${out}`);
        if (!snap.settled) console.error("⚠️ Page still showed a loading or changing state when the bounded wait ended.");
      } catch (error) {
        console.error(`❌ ${error.message || String(error)}`);
        process.exit(1);
      }
      break;
    }
    if (platform === "android") {
      const target = androidTarget(flags, positionals[0] || "");
      const { AndroidDriver } = await import(path.join(packageRoot, "mcp-server", "src", "android-driver.js"));
      const driver = new AndroidDriver(target);
      await driver.ensureDevice();
      if (target.apkPath) await driver.install(target.apkPath);
      const snap = await driver.launch({ clearData: flags["clear-data"] === true });
      const data = await driver.screenshot();
      console.log(`🚀 Launched \`${target.appId}\` (Android)\n`);
      console.log(engine.formatScreen(snap.screenTitle, snap.elements));
      const out = typeof flags.out === "string" ? flags.out : path.join(tappHome, "shots", `${target.appId}-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data);
      console.log(`\n📸 Screenshot: ${out}`);
      break;
    }
    requireMacFor("tapp open");
    const sim = await engine.ensureBootedSim({ autoBoot: true });
    if (sim.error) {
      console.error(`❌ ${sim.error}`);
      process.exit(1);
    }
    if (sim.autoBooted) console.error(`📱 Booted ${sim.booted.name}`);
    const bundleId = await resolveTargetOrExit(engine, positionals[0]);
    const r = await engine.openApp(bundleId, {}, 1000);
    if (r.error) {
      console.error(`❌ ${r.error}`);
      process.exit(1);
    }
    console.log(`🚀 Launched \`${bundleId}\`\n`);
    console.log(engine.formatScreen(r.screenTitle, r.elements));
    if (r.img && !r.img.error) {
      const out = saveShot(r.img, typeof flags.out === "string" ? flags.out : null, `${bundleId}-${Date.now()}.jpg`);
      console.log(`\n📸 Screenshot: ${out}`);
    }
    break;
  }

  case "tree": {
    const { flags, positionals } = parseVerbArgs(rest);
    const engine = await engineImport();
    const platform = requestedPlatform(flags, positionals[0] || "");
    if (platform === "web") {
      const url = positionals[0] || "";
      if (!/^https?:\/\//i.test(url)) {
        console.error("❌ Web tree needs an http(s) URL");
        process.exit(2);
      }
      try {
        const { inspectWebPage } = await import(path.join(packageRoot, "mcp-server", "src", "web-explorer.js"));
        const snap = await inspectWebPage({
          url,
          timeoutMs: Number(flags.timeout) * 1000 || 15_000,
          screenshot: false,
          tapText: typeof flags.tap === "string" ? flags.tap : "",
          waitForText: typeof flags["wait-for"] === "string" ? flags["wait-for"] : "",
        });
        if (flags.json) console.log(JSON.stringify({ platform: "web", url: snap.url, screenTitle: snap.screenTitle, settled: snap.settled, elements: snap.elements }, null, 2));
        else console.log(engine.formatScreen(snap.screenTitle, snap.elements));
        if (!snap.settled) console.error("⚠️ Page still showed a loading or changing state when the bounded wait ended.");
      } catch (error) {
        console.error(`❌ ${error.message || String(error)}`);
        process.exit(1);
      }
      break;
    }
    if (platform === "android") {
      const input = positionals[0] || "";
      const hasTarget = !!(input || flags["app-id"] || flags.apk);
      const target = hasTarget
        ? androidTarget(flags, input)
        : { serial: typeof flags.serial === "string" ? flags.serial : undefined };
      const { AndroidDriver } = await import(path.join(packageRoot, "mcp-server", "src", "android-driver.js"));
      const driver = new AndroidDriver(target);
      await driver.ensureDevice();
      if (target.apkPath) await driver.install(target.apkPath);
      const snap = target.appId ? await driver.launch() : await driver.snapshot();
      if (flags.json) console.log(JSON.stringify({ platform: "android", appId: target.appId || null, activity: snap.activity, screenTitle: snap.screenTitle, elements: snap.elements }, null, 2));
      else console.log(engine.formatScreen(snap.screenTitle, snap.elements));
      break;
    }
    requireMacFor("tapp tree");
    const sim = await engine.ensureBootedSim({ autoBoot: true });
    if (sim.error) {
      console.error(`❌ ${sim.error}`);
      process.exit(1);
    }
    const bundleId = await resolveTargetOrExit(engine, positionals[0]);
    const r = await engine.captureUiTree(bundleId);
    if (r.error) {
      console.error(`❌ ${r.error}`);
      process.exit(1);
    }
    if (flags.json) {
      console.log(JSON.stringify({ screenTitle: r.screenTitle, elements: r.elements }, null, 2));
    } else {
      console.log(engine.formatScreen(r.screenTitle, r.elements));
      console.log("\n(full element list: tapp tree " + bundleId + " --json)");
    }
    break;
  }

  case "shot":
  case "screenshot": {
    requireMacFor("tapp shot");
    const { flags } = parseVerbArgs(rest);
    const engine = await engineImport();
    const img = await engine.captureScreenshotImage(flags.width ? Number(flags.width) : 1000);
    if (img.error) {
      console.error(`❌ ${img.error}`);
      process.exit(1);
    }
    const out = saveShot(img, typeof flags.out === "string" ? flags.out : null, `shot-${Date.now()}.jpg`);
    console.log(`📸 ${out} (${Math.round(img.bytes / 1024)}KB)`);
    break;
  }

  case "apps": {
    requireMacFor("tapp apps");
    const engine = await engineImport();
    const sim = await engine.ensureBootedSim({ autoBoot: true });
    if (sim.error) {
      console.error(`❌ ${sim.error}`);
      process.exit(1);
    }
    const la = await engine.listInstalledUserApps();
    if (la.error) {
      printEngineError(la);
      process.exit(1);
    }
    if (!la.apps.length) {
      console.log("No user apps installed on the booted simulator. Install one: tapp build (from your app repo), or xcrun simctl install booted path/to/App.app");
      break;
    }
    console.log("📱 Installed on the booted simulator:\n");
    for (const a of la.apps) console.log(`  ${a.bundleId}  (${a.name})`);
    console.log(`\nTest one: tapp explore <bundleId>`);
    break;
  }

  case "build": {
    requireMacFor("tapp build");
    const { flags, positionals } = parseVerbArgs(rest);
    const engine = await engineImport();
    const dir = positionals[0] ? path.resolve(positionals[0]) : process.cwd();
    console.error("⏳ Building for the simulator (a first build can take a few minutes)…");
    const built = await engine.buildAppForSim({
      dir,
      scheme: typeof flags.scheme === "string" ? flags.scheme : undefined,
      configuration: typeof flags.configuration === "string" ? flags.configuration : "Debug",
    });
    if (built.error) {
      printEngineError(built);
      process.exit(1);
    }
    const sim = await engine.ensureBootedSim({ autoBoot: true });
    if (sim.error) {
      console.error(`❌ ${sim.error}`);
      process.exit(1);
    }
    const inst = await engine.installAppOnBootedSim(built.appPath);
    if (inst.error) {
      printEngineError(inst);
      process.exit(1);
    }
    console.log(`🔨 Built ${path.basename(built.appPath)} (scheme ${built.scheme}) — installed as ${inst.bundleId}`);
    console.log(`\nNext: tapp explore ${inst.bundleId}`);
    break;
  }

  case "task": {
    const { flags, positionals } = parseVerbArgs(rest);
    const verb = positionals[0] || "validate";
    const taskPath = positionals[1] ? path.resolve(positionals[1]) : "";
    if (!["validate", "compile", "run"].includes(verb) || !taskPath) {
      console.error("usage: tapp task validate <task.yml> [--platform ios|android|web] [--map .tapp/ui-map.json]\n       tapp task compile <task.yml> --platform PLATFORM [--inputs '{\"name\":\"value\"}'] [--out compiled.json]\n       tapp task run <task.yml> --platform PLATFORM [--url URL|--bundle-id ID|--app-id ID] [--inputs JSON]");
      process.exit(2);
    }
    if (!fs.existsSync(taskPath)) { console.error(`❌ Task not found: ${taskPath}`); process.exit(2); }
    const { applyTaskCoverage, compileTaskSteps, loadTaskFile, loadTaskRegistry, validateTaskAgainstUiMap } = await import(path.join(packageRoot, "mcp-server", "src", "task-runtime.js"));
    let task;
    try { task = loadTaskFile(taskPath); }
    catch (error) { console.error(`❌ ${error.message}`); process.exit(2); }
    const platform = typeof flags.platform === "string" ? flags.platform.toLowerCase()
      : verb === "run" ? (typeof flags.url === "string" ? "web" : typeof flags["app-id"] === "string" || typeof flags.apk === "string" ? "android" : "ios") : "";
    if (platform && !["ios", "android", "web"].includes(platform)) { console.error("❌ --platform must be ios|android|web"); process.exit(2); }
    let grounding = { errors: [], warnings: [] };
    let groundingMap = null;
    let groundingMapPath = null;
    if (typeof flags.map === "string") {
      groundingMapPath = path.resolve(flags.map);
      if (!fs.existsSync(groundingMapPath)) { console.error(`❌ UI Map not found: ${groundingMapPath}`); process.exit(2); }
      groundingMap = JSON.parse(fs.readFileSync(groundingMapPath, "utf8"));
      grounding = validateTaskAgainstUiMap(task, groundingMap, platform);
    }
    if (grounding.errors.length) { console.error(`❌ Task is not grounded: ${grounding.errors.join("; ")}`); process.exit(2); }
    if (flags["update-map"] === true) {
      if (!groundingMap || !groundingMapPath) { console.error("❌ --update-map requires --map <ui-map.json>"); process.exit(2); }
      fs.writeFileSync(groundingMapPath, JSON.stringify(applyTaskCoverage(groundingMap, task), null, 2) + "\n");
    }
    if (verb === "validate") {
      console.log(`✅ Valid Task — ${task.name} v${task.version}`);
      console.log(`   inputs: ${Object.keys(task.inputs || {}).join(", ") || "none"} · outputs: ${Object.keys(task.outputs || {}).join(", ") || "none"}`);
      console.log(`   coverage: ${(task.coverage?.nodes || []).length} states · ${(task.coverage?.edges || []).length} transitions`);
      for (const warning of grounding.warnings) console.log(`   ⚠️  ${warning}`);
      if (flags["update-map"] === true) console.log(`   map coverage updated: ${groundingMapPath}`);
      break;
    }
    let inputs = {};
    if (typeof flags.inputs === "string") {
      try { inputs = JSON.parse(flags.inputs); }
      catch { console.error("❌ --inputs must be a JSON object"); process.exit(2); }
      if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) { console.error("❌ --inputs must be a JSON object"); process.exit(2); }
    }
    let registry;
    try {
      registry = loadTaskRegistry({ sourcePath: taskPath });
      if (!registry.has(task.name)) registry.set(task.name, task);
    } catch (error) { console.error(`❌ ${error.message}`); process.exit(2); }
    const vars = {};
    const plan = [];
    let compiled;
    try { compiled = compileTaskSteps({ steps: [{ task: task.name, with: inputs }], registry, platform, flowVars: vars, plan }); }
    catch (error) { console.error(`❌ Could not compile Task: ${error.message}`); process.exit(2); }
    const flow = {
      name: `Task: ${task.name}`, kind: "flow", platform,
      app: typeof flags["bundle-id"] === "string" ? flags["bundle-id"] : typeof flags["app-id"] === "string" ? flags["app-id"] : task.app || "",
      url: typeof flags.url === "string" ? flags.url : task.url || "",
      reset: task.reset || "launch", vars: compiled.vars, steps: compiled.steps, taskPlan: compiled.plan,
    };
    const out = path.resolve(typeof flags.out === "string" ? flags.out : path.join(tappHome, "tasks", `${task.name}-${process.pid}-${Date.now()}.json`));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(flow, null, 2) + "\n");
    if (verb === "compile") {
      console.log(`✅ Compiled Task '${task.name}' → ${flow.steps.length} deterministic Flow steps\n${out}`);
      break;
    }
    const runArgs = [path.join(packageRoot, "bin", "tapp.js"), "flow", "run", out, "--platform", platform];
    for (const key of ["url", "bundle-id", "app-id", "apk", "serial", "email", "password"]) {
      if (typeof flags[key] === "string") runArgs.push(`--${key}`, flags[key]);
    }
    const result = spawnSync(process.execPath, runArgs, { stdio: "inherit", env: process.env });
    process.exit(result.status ?? 1);
  }

  case "flow": {
    const { flags, positionals } = parseVerbArgs(rest);
    const verb = positionals[0] || "run";
    const flowPath = positionals[1] || (verb === "run" || verb === "validate" ? "" : verb);
    if (!["run", "validate"].includes(verb) || !flowPath) {
      console.error("usage: tapp flow run <flow.yml> [--platform ios|android|web] [--url URL] [--app-id ID] [--apk FILE] [--serial ID]\n       tapp flow validate <flow.yml>");
      process.exit(2);
    }
    const absolute = path.resolve(flowPath);
    if (!fs.existsSync(absolute)) {
      console.error(`❌ Flow not found: ${absolute}`);
      process.exit(2);
    }
    const { loadFlowFile } = await import(path.join(packageRoot, "mcp-server", "src", "flow-runtime.js"));
    let flow;
    try { flow = loadFlowFile(absolute); } catch (error) {
      console.error(`❌ Invalid Flow: ${error.message}`);
      process.exit(2);
    }
    if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
      console.error("❌ Invalid Flow: steps must be a non-empty array");
      process.exit(2);
    }
    const platform = String(flags.platform || flow.platform || (flow.url || /^https?:\/\//i.test(flow.app || "") ? "web" : "ios")).toLowerCase();
    if (!["ios", "android", "web"].includes(platform)) {
      console.error(`❌ Unsupported Flow platform: ${platform}`);
      process.exit(2);
    }
    if (verb === "validate") {
      const taskCount = Array.isArray(flow.taskPlan) ? flow.taskPlan.length : 0;
      console.log(`✅ Valid ${platform} Flow — ${flow.name} (${flow.steps.length} deterministic steps${taskCount ? ` compiled from ${taskCount} Task call${taskCount === 1 ? "" : "s"}` : ""})`);
      break;
    }
    const token = `${process.pid}-${Date.now()}`;
    const flowLog = path.join(tappHome, "flows", `${token}.log`);
    const evidenceDir = path.join(tappHome, "captures", `flow-${platform}-${token}`);
    fs.mkdirSync(path.dirname(flowLog), { recursive: true });
    const env = { ...process.env, FLOW_LOG: flowLog, TAPP_FLOW_EVIDENCE_DIR: evidenceDir };
    if (typeof flags.email === "string") env.OCQA_TEST_EMAIL = flags.email;
    if (typeof flags.password === "string") env.OCQA_TEST_PASSWORD = flags.password;
    let invocation;
    if (platform === "web") {
      const url = typeof flags.url === "string" ? flags.url : flow.url || flow.app;
      if (!url) { console.error("❌ Web Flow needs `url:` or --url"); process.exit(2); }
      invocation = [process.execPath, [path.join(packageRoot, "scripts", "run-web-flow.js"), absolute, url]];
    } else if (platform === "android") {
      const target = androidTarget(flags, typeof flags["app-id"] === "string" ? flags["app-id"] : flow.app || "");
      invocation = [process.execPath, [path.join(packageRoot, "scripts", "run-android-flow.js"), absolute, target.appId, target.apkPath || "", target.serial || ""]];
    } else {
      requireMacFor("iOS Flow replay");
      ensureIOSHarness();
      invocation = ["bash", [path.join(packageRoot, "scripts", "run-flow.sh"), absolute, typeof flags["bundle-id"] === "string" ? flags["bundle-id"] : flow.app || ""]];
    }
    const result = spawnSync(invocation[0], invocation[1], { stdio: "inherit", env });
    console.log(`\nEvidence: ${evidenceDir}`);
    process.exit(result.status ?? 1);
  }

  case "contract": {
    const { flags, positionals } = parseVerbArgs(rest);
    const verb = positionals[0] || "validate";
    const contractPath = positionals[1] ? path.resolve(positionals[1]) : "";
    if (!["validate", "compile", "run"].includes(verb) || !contractPath) {
      console.error("usage: tapp contract validate <name.contract.ts> [--platform ios|android|web] [--map .tapp/ui-map.json]\n       tapp contract compile <name.contract.ts> --platform PLATFORM [--out compiled.json]\n       tapp contract run <name.contract.ts> --platform PLATFORM [--url URL|--bundle-id ID|--app-id ID]");
      process.exit(2);
    }
    const {
      applyReleaseContractCoverage,
      compileReleaseContract,
      loadReleaseContractFile,
      validateReleaseContractAgainstUiMap,
    } = await import(path.join(packageRoot, "mcp-server", "src", "release-contract.js"));
    let contract;
    try { contract = await loadReleaseContractFile(contractPath); }
    catch (error) { console.error(`❌ ${error.message}`); process.exit(2); }
    const platform = String(flags.platform || (contract.platforms.length === 1 ? contract.platforms[0] : "")).toLowerCase();
    if (platform && !["ios", "android", "web"].includes(platform)) { console.error("❌ --platform must be ios|android|web"); process.exit(2); }
    let grounding = { errors: [], warnings: [] };
    let groundingMap = null;
    let groundingMapPath = "";
    if (typeof flags.map === "string") {
      groundingMapPath = path.resolve(flags.map);
      if (!fs.existsSync(groundingMapPath)) { console.error(`❌ UI Map not found: ${groundingMapPath}`); process.exit(2); }
      groundingMap = JSON.parse(fs.readFileSync(groundingMapPath, "utf8"));
      grounding = validateReleaseContractAgainstUiMap(contract, groundingMap);
    }
    if (grounding.errors.length) { console.error(`❌ Release Contract is not grounded: ${grounding.errors.join("; ")}`); process.exit(2); }
    if (flags["update-map"] === true) {
      if (!groundingMapPath) { console.error("❌ --update-map requires --map <ui-map.json>"); process.exit(2); }
      fs.writeFileSync(groundingMapPath, JSON.stringify(applyReleaseContractCoverage(groundingMap, contract), null, 2) + "\n");
    }
    if (verb === "validate") {
      console.log(`✅ Valid Release Contract — ${contract.title} (${contract.criticality}, ${Object.keys(contract.actors).length} actor${Object.keys(contract.actors).length === 1 ? "" : "s"})`);
      console.log(`   platforms: ${contract.platforms.join(", ")} · ${contract.steps.length} business steps · ${contract.businessValue}`);
      for (const warning of grounding.warnings) console.log(`   ⚠️  ${warning}`);
      if (flags["update-map"] === true) console.log(`   map coverage updated: ${groundingMapPath}`);
      break;
    }
    let compiled;
    try { compiled = compileReleaseContract(contract, { platform, sourcePath: contractPath }); }
    catch (error) { console.error(`❌ Could not compile Release Contract: ${error.message}`); process.exit(2); }
    const out = path.resolve(typeof flags.out === "string" ? flags.out : path.join(tappHome, "contracts", `${contract.name}-${process.pid}-${Date.now()}.json`));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(compiled, null, 2) + "\n");
    if (verb === "compile") {
      console.log(`✅ Compiled Release Contract '${contract.name}' → ${compiled.steps.length} deterministic steps (${compiled.kind})\n${out}`);
      break;
    }
    const runArgs = [path.join(packageRoot, "bin", "tapp.js"), compiled.kind === "scenario" ? "scenario" : "flow", "run", out];
    for (const key of ["url", "bundle-id", "app-id", "apk", "serial", "email", "password"]) {
      if (typeof flags[key] === "string") runArgs.push(`--${key}`, flags[key]);
    }
    if (compiled.kind !== "scenario") runArgs.push("--platform", platform);
    const result = spawnSync(process.execPath, runArgs, { stdio: "inherit", env: process.env });
    process.exit(result.status ?? 1);
  }

  case "pr": {
    const { flags, positionals } = parseVerbArgs(rest);
    const verb = positionals[0] || "plan";
    if (!['plan', 'adopt'].includes(verb)) {
      console.error("usage: tapp pr plan --base BASE [--head HEAD] [--project-dir DIR] [--platform PLATFORM] [--map PATH] [--json-out PATH]\n       tapp pr plan --changed-files 'src/a.ts,src/b.ts' [options]\n       tapp pr plan --changed-files-file /path/to/files.json [options]\n       tapp pr adopt <executed-pr-plan.json> --item ID [--project-dir DIR]");
      process.exit(2);
    }
    const projectDir = path.resolve(typeof flags["project-dir"] === "string" ? flags["project-dir"] : process.cwd());
    if (verb === "adopt") {
      const prPlanPath = positionals[1];
      if (!prPlanPath || typeof flags.item !== "string") {
        console.error("usage: tapp pr adopt <executed-pr-plan.json> --item ID [--project-dir DIR] [--release-plan PATH]");
        process.exit(2);
      }
      const { adoptPrCoverageProposal } = await import(path.join(packageRoot, "mcp-server", "src", "pr-selection.js"));
      try {
        const adopted = adoptPrCoverageProposal({ projectDir, prPlanPath, item: flags.item, releasePlanPath: typeof flags["release-plan"] === "string" ? flags["release-plan"] : undefined });
        console.log(`📥 ${adopted.mode === "reconciled-existing" ? "Reconciled PR evidence into" : "Adopted"} ${adopted.item.name}${adopted.mode === "reconciled-existing" ? ` while preserving decision '${adopted.item.decision}'` : " as a pending release-plan item"}; no Task or contract was generated or trusted`);
        console.log(`   plan: ${adopted.path}\n   next: tapp plan review ${adopted.path} --approve ${adopted.item.id}`);
      } catch (error) { console.error(`❌ Could not adopt PR coverage proposal: ${error.message || String(error)}`); process.exit(2); }
      break;
    }
    const { buildPrContractPlan, changedFilesFromGit, changedSymbolEvidenceFromGit, parseChangedFiles, readChangedFilesFile } = await import(path.join(packageRoot, "mcp-server", "src", "pr-selection.js"));
    let changedFiles = [];
    let changedSymbolEvidence = [];
    if (typeof flags["changed-files"] === "string") {
      try { changedFiles = parseChangedFiles(flags["changed-files"]); }
      catch { console.error("❌ --changed-files must be a comma list or JSON string array"); process.exit(2); }
    } else if (typeof flags["changed-files-file"] === "string") {
      try { changedFiles = readChangedFilesFile(flags["changed-files-file"]); }
      catch (error) { console.error(`❌ ${error.message || String(error)}`); process.exit(2); }
    } else if (typeof flags.base === "string") {
      const head = typeof flags.head === "string" ? flags.head : "HEAD";
      try {
        changedFiles = changedFilesFromGit({ projectDir, base: flags.base, head });
        changedSymbolEvidence = changedSymbolEvidenceFromGit({ projectDir, base: flags.base, head });
      }
      catch (error) { console.error(`❌ ${error.message || String(error)}`); process.exit(2); }
    } else {
      console.error("❌ Provide --base <ref>, --changed-files <list>, or --changed-files-file <path>");
      process.exit(2);
    }
    if (!Array.isArray(changedFiles)) { console.error("❌ --changed-files JSON must be an array"); process.exit(2); }
    let plan;
    try {
      plan = await buildPrContractPlan({
        projectDir,
        changedFiles,
        changedSymbolEvidence,
        platform: typeof flags.platform === "string" ? flags.platform.toLowerCase() : "",
        mapPath: typeof flags.map === "string" ? flags.map : "",
      });
    } catch (error) { console.error(`❌ Could not build PR plan: ${error.message || String(error)}`); process.exit(2); }
    if (typeof flags["json-out"] === "string") fs.writeFileSync(path.resolve(flags["json-out"]), JSON.stringify(plan, null, 2) + "\n");
    console.log(`📋 PR contract plan — ${plan.selected.length} selected · ${plan.skipped.length} skipped · ${plan.explorationTargets.length} bounded exploration target(s) · ${plan.uncoveredChangedFiles.length} uncovered changed file(s)`);
    for (const contract of plan.selected) console.log(`   ✅ ${contract.name} (${contract.criticality}) — ${contract.reasons.map((reason) => reason.type).join(", ")}`);
    for (const target of plan.explorationTargets) {
      const navigation = target.navigation || {};
      const detail = navigation.route
        ? `${navigation.status} ${navigation.route}`
        : navigation.mode === "ui-map-path" && navigation.status === "replayable"
          ? `replayable via ${(navigation.steps || []).length} observed UI Map edge(s)`
          : `${navigation.status || "blocked"}: ${navigation.reason || "no replayable navigation reference"}`;
      console.log(`   🔎 ${target.node.name} — ${detail}`);
    }
    for (const file of plan.uncoveredChangedFiles) console.log(`   ⚠️  uncovered: ${file}`);
    break;
  }

  case "scenario": {
    const { flags, positionals } = parseVerbArgs(rest);
    const verb = positionals[0] || "run";
    const scenarioPath = positionals[1] || "";
    if (!["run", "validate"].includes(verb) || !scenarioPath) {
      console.error("usage: tapp scenario run <scenario.yml> [--url URL]\n       tapp scenario validate <scenario.yml>");
      process.exit(2);
    }
    const absolute = path.resolve(scenarioPath);
    if (!fs.existsSync(absolute)) {
      console.error(`❌ Scenario not found: ${absolute}`);
      process.exit(2);
    }
    const { loadScenarioFile, validateScenario } = await import(path.join(packageRoot, "mcp-server", "src", "scenario-runtime.js"));
    let scenario;
    try { scenario = loadScenarioFile(absolute); } catch (error) {
      console.error(`❌ Invalid Scenario: ${error.message}`);
      process.exit(2);
    }
    const errors = validateScenario(scenario);
    if (errors.length) {
      console.error(`❌ Invalid Scenario: ${errors.join("; ")}`);
      process.exit(2);
    }
    if (verb === "validate") {
      console.log(`✅ Valid web Scenario — ${scenario.name} (${Object.keys(scenario.actors).length} actors, ${scenario.steps.length} journey steps)`);
      break;
    }
    const token = `${process.pid}-${Date.now()}`;
    const flowLog = path.join(tappHome, "scenarios", `${token}.log`);
    const evidenceDir = path.join(tappHome, "captures", `scenario-web-${token}`);
    const env = { ...process.env, FLOW_LOG: flowLog, TAPP_FLOW_EVIDENCE_DIR: evidenceDir };
    const url = typeof flags.url === "string" ? flags.url : scenario.url || scenario.app || "";
    const result = spawnSync(process.execPath, [path.join(packageRoot, "scripts", "run-web-scenario.js"), absolute, url], { stdio: "inherit", env });
    if (fs.existsSync(flowLog)) spawnSync("python3", [path.join(packageRoot, "scripts", "flow_lib.py"), "report", flowLog], { stdio: "inherit" });
    console.log(`\nEvidence: ${evidenceDir}`);
    process.exit(result.status ?? 1);
  }

  case "map": {
    const { flags, positionals } = parseVerbArgs(rest);
    const verb = positionals[0] || "inspect";
    const { buildUiMapFromMarkers, diffUiMaps, mergeUiMaps, validateUiMap, writeUiMap } = await import(path.join(packageRoot, "mcp-server", "src", "ui-map.js"));
    if (verb === "build") {
      const markersPath = positionals[1] ? path.resolve(positionals[1]) : "";
      if (!markersPath || !fs.existsSync(markersPath)) {
        console.error(`❌ Markers not found: ${markersPath || "provide <ocqa-markers.txt>"}`);
        process.exit(2);
      }
      const platform = String(flags.platform || "ios").toLowerCase();
      if (!["ios", "android", "web"].includes(platform)) {
        console.error("❌ --platform must be ios|android|web");
        process.exit(2);
      }
      const out = path.resolve(typeof flags.out === "string" ? flags.out : path.join(".tapp", "ui-map.json"));
      const observed = buildUiMapFromMarkers({
        markersPath,
        platform,
        target: typeof flags.target === "string" ? flags.target : "",
        runId: typeof flags["run-id"] === "string" ? flags["run-id"] : path.basename(path.dirname(markersPath)),
      });
      let map = observed;
      if (fs.existsSync(out) && flags.replace !== true) {
        try { map = mergeUiMaps(JSON.parse(fs.readFileSync(out, "utf8")), observed); }
        catch (error) { console.error(`❌ Could not merge existing UI Map: ${error.message}`); process.exit(2); }
      }
      writeUiMap(out, map);
      const controls = map.nodes.reduce((total, node) => total + node.controls.length, 0);
      console.log(`✅ UI Map updated — ${map.nodes.length} states · ${map.edges.length} transitions · ${controls} controls\n${out}`);
      break;
    }
    if (verb === "inspect") {
      const mapPath = positionals[1] ? path.resolve(positionals[1]) : existingProjectArtifactPath(process.cwd(), "ui-map.json");
      if (!fs.existsSync(mapPath)) { console.error(`❌ UI Map not found: ${mapPath}`); process.exit(2); }
      const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
      const errors = validateUiMap(map);
      if (errors.length) { console.error(`❌ Invalid UI Map: ${errors.join("; ")}`); process.exit(2); }
      const controls = map.nodes.reduce((total, node) => total + node.controls.length, 0);
      console.log(`🗺️  UI Map v${map.schemaVersion} — ${map.nodes.length} states · ${map.edges.length} transitions · ${controls} controls`);
      for (const node of map.nodes) console.log(`- ${node.name} · ${node.controls.length} controls · ${node.platforms.join("/")} · ${node.status}`);
      break;
    }
    if (verb === "diff") {
      const beforePath = positionals[1] ? path.resolve(positionals[1]) : "";
      const afterPath = positionals[2] ? path.resolve(positionals[2]) : "";
      if (!beforePath || !afterPath || !fs.existsSync(beforePath) || !fs.existsSync(afterPath)) {
        console.error("usage: tapp map diff <before.json> <after.json> [--comparable] [--json out.json]");
        process.exit(2);
      }
      const diff = diffUiMaps(JSON.parse(fs.readFileSync(beforePath, "utf8")), JSON.parse(fs.readFileSync(afterPath, "utf8")), { comparableFullSweep: flags.comparable === true });
      if (typeof flags.json === "string") fs.writeFileSync(path.resolve(flags.json), JSON.stringify(diff, null, 2) + "\n");
      console.log(`🗺️  UI Map diff — +${diff.addedNodes.length} states · ${diff.notObservedNodes.length} not observed · +${diff.addedEdges.length} transitions · ${diff.notObservedEdges.length} transitions not observed`);
      if (!diff.comparableFullSweep && (diff.notObservedNodes.length || diff.notObservedEdges.length)) console.log("ℹ️  Absence is not labeled a regression because the runs were not declared comparable full sweeps.");
      process.exit(diff.lostReachability.length || diff.lostTransitions.length ? 1 : 0);
    }
    console.error("usage: tapp map build <ocqa-markers.txt> [--platform ios|android|web] [--out .tapp/ui-map.json]\n       tapp map inspect [ui-map.json]\n       tapp map diff <before.json> <after.json> [--comparable]");
    process.exit(2);
  }

  case "doctor": {
    console.log(`tapp v${pkg.version} — doctor\n`);
    let healthy = true;

    const major = Number(process.versions.node.split(".")[0]);
    major >= 18 ? ok("Node", `v${process.versions.node}`) : (bad("Node", `v${process.versions.node} (need >= 18)`), (healthy = false));

    const python = run("python3", ["--version"]);
    python.code === 0 ? ok("python3", `${python.stdout} (used by Flows)`) : bad("python3", "not found — Flow replay needs python3 + pyyaml (everything else works)");

    console.log("\n  Platforms:");
    if (process.platform === "darwin") {
      const xcode = run("xcode-select", ["-p"]);
      const simctl = run("xcrun", ["simctl", "help"]);
      if (xcode.code === 0 && simctl.code === 0) {
        const ver = run("xcodebuild", ["-version"]).stdout.split("\n")[0];
        const booted = bootedSims();
        ok("iOS", `${ver || "Xcode"}; ${booted.length ? `${booted[0].name} booted` : "no simulator booted yet"}`);
        const xctestrun = harnessXctestrun();
        xctestrun ? ok("iOS harness cache", xctestrun) : console.log("  ⬜ iOS harness cache — builds on first use (or: tapp install)");
      } else {
        console.log("  ⬜ iOS — unavailable (install Xcode + simulator runtime)");
      }
    } else {
      console.log(`  ⬜ iOS — requires macOS (this host: ${process.platform})`);
    }

    const { resolveAdbPath } = await import(path.join(packageRoot, "mcp-server", "src", "android-driver.js"));
    const adbPath = resolveAdbPath();
    const adb = adbPath ? run(adbPath, ["devices"]) : { code: 1, stdout: "" };
    if (adb.code === 0) {
      const devices = adb.stdout.split(/\r?\n/).slice(1).filter((line) => /\sdevice(?:\s|$)/.test(line));
      ok("Android", devices.length ? `${devices.length} connected emulator/device` : "adb available; no device connected");
    } else {
      console.log("  ⬜ Android — adb not found (install Android SDK platform-tools)");
    }

    try {
      await import("playwright");
      ok("Web", "Playwright installed");
    } catch {
      console.log("  ⬜ Web — install Playwright in the app workspace: npm install -D playwright && npx playwright install chromium");
    }

    console.log(`\n  Home: ${tappHome}`);
    console.log(healthy
      ? "\nReady. Start with:\n  npx -y @aarwitz/tapp open [target]\n  npx -y @aarwitz/tapp explore [target]"
      : "\nFix the ❌ items above, then re-run: tapp doctor");
    process.exit(healthy ? 0 : 1);
  }

  case "install": {
    console.log("Preparing the iOS exploration harness…");
    let booted = bootedSims();
    if (!booted.length) {
      const sim = bootBestSimulator();
      if (!sim) {
        console.error("❌ No iOS simulator available. Install one via Xcode → Settings → Platforms.");
        process.exit(1);
      }
      booted = [sim];
    }
    const r = spawnSync("bash", [path.join(packageRoot, "scripts", "quick-capture.sh"), "build-harness"], {
      stdio: "inherit",
    });
    process.exit(r.status ?? 1);
  }

  case "actor": {
    const { flags, positionals } = parseVerbArgs(rest);
    const verb = positionals[0] || "list";
    if (!["list", "set"].includes(verb)) {
      console.error("usage: tapp actor list [repo] [--json]\n       tapp actor set NAME [repo] [--role ROLE] [--session default|isolated] [--provisioning existing|seeded|api|unknown] [--credential name=ENV_NAME] [--email-env ENV_NAME] [--password-env ENV_NAME] [--replace]");
      process.exit(2);
    }
    const projectValue = verb === "set" ? positionals[2] : positionals[1];
    let projectDir;
    try { projectDir = fs.realpathSync(path.resolve(projectValue || process.cwd())); }
    catch { console.error(`❌ Repository directory not found: ${projectValue || process.cwd()}`); process.exit(2); }
    const { configureActor, readProjectConfig } = await import(path.join(packageRoot, "mcp-server", "src", "project-config.js"));
    if (verb === "list") {
      const loaded = readProjectConfig(projectDir);
      if (loaded.errors.length) { console.error(`❌ Invalid ${loaded.relativePath}: ${loaded.errors.join("; ")}`); process.exit(2); }
      if (flags.json === true) console.log(JSON.stringify({ path: loaded.path, exists: loaded.exists, actors: loaded.config.actors || {} }, null, 2));
      else {
        const actors = Object.entries(loaded.config.actors || {});
        console.log(`👥 Tapp actors — ${actors.length} configured · ${loaded.relativePath}`);
        for (const [name, actor] of actors) console.log(`   ${name} · role ${actor.role || "unspecified"} · ${actor.session || "default"} session · ${actor.provisioning || "existing"} · credentials ${Object.entries(actor.credentials || {}).map(([key, binding]) => `${key}=$${binding.env}`).join(", ") || "none"}`);
      }
      break;
    }
    const name = positionals[1] || "";
    const allowed = new Set(["role", "session", "provisioning", "credential", "email-env", "password-env", "replace"]);
    const suppliedFlags = rest.filter((value) => value.startsWith("--")).map((value) => value.slice(2));
    const unsupported = suppliedFlags.filter((value) => !allowed.has(value));
    if (unsupported.length) {
      console.error(`❌ Unsupported actor flag(s): ${[...new Set(unsupported)].join(", ")}. Credential values are never accepted; bind names with --credential name=ENV_NAME.`);
      process.exit(2);
    }
    const credentials = {};
    const bindings = [
      ...repeatedFlagValues(rest, "credential"),
      ...(typeof flags["email-env"] === "string" ? [`email=${flags["email-env"]}`] : []),
      ...(typeof flags["password-env"] === "string" ? [`password=${flags["password-env"]}`] : []),
    ];
    for (const value of bindings) {
      const match = /^([a-z][A-Za-z0-9_-]{0,63})=([A-Z_][A-Z0-9_]{0,127})$/.exec(value);
      if (!match) { console.error(`❌ Invalid credential binding '${value}'; expected name=UPPERCASE_ENV_NAME`); process.exit(2); }
      credentials[match[1]] = { env: match[2] };
    }
    try {
      const result = configureActor(projectDir, {
        name,
        role: typeof flags.role === "string" ? flags.role : "",
        session: typeof flags.session === "string" ? flags.session : "default",
        provisioning: typeof flags.provisioning === "string" ? flags.provisioning : "existing",
        credentials,
        replace: flags.replace === true,
      });
      console.log(`✅ Actor '${name}' configured — ${result.actor.session} session · ${result.actor.provisioning} provisioning`);
      console.log(`   ${result.path}`);
      console.log(`   bindings: ${Object.entries(result.actor.credentials).map(([key, binding]) => `${key}=$${binding.env}`).join(", ") || "none"}`);
      console.log("   No credential values were accepted or written. Rerun tapp init --refresh to update the application model.");
    } catch (error) { console.error(`❌ Actor not configured: ${error.message || String(error)}`); process.exit(2); }
    break;
  }

  case "baseline": {
    const { flags, positionals } = parseVerbArgs(rest);
    const verb = positionals[0] || "create";
    if (verb !== "create") {
      console.error("usage: tapp baseline create [repo] [--platform ios|android|web] [--target ID|NAME|PATH] [--from gate-report.json] [--replace]\n       Without --from, Tapp builds/starts the selected target, runs the full portable gate, and saves only a successful conclusive report.");
      process.exit(2);
    }
    const projectDir = fs.realpathSync(path.resolve(positionals[1] || (typeof flags["project-dir"] === "string" ? flags["project-dir"] : process.cwd())));
    const modelPath = typeof flags.model === "string" ? path.resolve(projectDir, flags.model) : existingProjectArtifactPath(projectDir, "application-model.json");
    if (!modelPath.startsWith(projectDir + path.sep) || !fs.existsSync(modelPath)) {
      console.error(`❌ Application model not found inside the repository: ${modelPath}\n   Run tapp init --explore, review/generate/validate/promote the plan, then create the baseline.`);
      process.exit(2);
    }
    let model;
    try { model = JSON.parse(fs.readFileSync(modelPath, "utf8")); }
    catch (error) { console.error(`❌ Invalid application model: ${error.message}`); process.exit(2); }
    const { selectApplicationTarget } = await import(path.join(packageRoot, "mcp-server", "src", "ci-setup.js"));
    const { createProductBaseline, prepareProductTarget, runProductGate } = await import(path.join(packageRoot, "mcp-server", "src", "product-operations.js"));
    let selectedTarget;
    try {
      selectedTarget = selectApplicationTarget(model, {
        platform: typeof flags.platform === "string" ? flags.platform.toLowerCase() : "",
        target: typeof flags.target === "string" ? flags.target : "",
      });
    } catch (error) { console.error(`❌ ${error.message}`); process.exit(2); }

    let reportPath = typeof flags.from === "string" ? path.resolve(flags.from) : "";
    if (!reportPath) {
      const actions = flags.actions === undefined ? 40 : Number(flags.actions);
      const timeout = flags.timeout === undefined ? 600 : Number(flags.timeout);
      if (!Number.isInteger(actions) || actions < 1 || !Number.isInteger(timeout) || timeout < 1) {
        console.error("❌ --actions and --timeout must be positive integers");
        process.exit(2);
      }
      if (selectedTarget.platform === "ios") requireMacFor("iOS baseline creation");
      const engine = await engineImport();
      let prepared;
      try {
        prepared = await prepareProductTarget({
          projectDir, platform:selectedTarget.platform, target:selectedTarget.id,
          appPath:typeof flags.app === "string" ? path.resolve(flags.app) : "",
          apkPath:typeof flags.apk === "string" ? path.resolve(flags.apk) : "",
          bundleId:typeof flags["bundle-id"] === "string" ? flags["bundle-id"] : "",
          appId:typeof flags["app-id"] === "string" ? flags["app-id"] : "",
          scheme:typeof flags.scheme === "string" ? flags.scheme : "",
          configuration:typeof flags.configuration === "string" ? flags.configuration : "",
          buildIos:engine.buildAppForSim,
          buildAndroid:engine.buildAndroidApp,
          onProgress:(entry) => { if (entry.text) console.error(`⏳ ${entry.text}`); },
        });
      } catch (error) { console.error(`❌ ${error.message || String(error)}`); process.exit(2); }
      const { appPath = "", bundleId = "", appId = "", apkPath = "" } = prepared.runtime;
      console.error(`🧪 Establishing a conclusive ${selectedTarget.platform}:${selectedTarget.name} baseline through the ordinary release gate…`);
      let gate;
      try {
        gate = await runProductGate({
          projectDir,
          platform: selectedTarget.platform,
          target: selectedTarget.id,
          url: typeof flags.url === "string" ? flags.url : prepared.runtime.url || "",
          appPath,
          bundleId,
          appId,
          apkPath,
          serial: typeof flags.serial === "string" ? flags.serial : "",
          device: typeof flags.device === "string" ? flags.device : "",
          flows: typeof flags.flows === "string" ? flags.flows : "",
          scenarios: typeof flags.scenarios === "string" ? flags.scenarios : "",
          contracts: typeof flags.contracts === "string" ? flags.contracts : "",
          actions,
          timeout,
          testEmail: typeof flags.email === "string" ? flags.email : undefined,
          testPassword: typeof flags.password === "string" ? flags.password : undefined,
          onProgress: (entry) => { if (entry.text) console.error(`⏳ ${entry.text}`); },
        });
      } catch (error) {
        console.error(`❌ The release gate could not run; no baseline was written: ${error.message || String(error)}`);
        process.exit(2);
      }
      reportPath = gate.reportPath;
      if (!gate.passed) {
        console.error(`❌ The gate did not pass; no baseline was written.${fs.existsSync(reportPath) ? ` Review the retained report: ${reportPath}` : ""}`);
        process.exit(gate.code || 1);
      }
      if (typeof flags["report-out"] === "string") {
        const exported = path.resolve(flags["report-out"]);
        fs.mkdirSync(path.dirname(exported), { recursive: true });
        fs.copyFileSync(gate.reportPath, exported);
        if (gate.markdownPath && fs.existsSync(gate.markdownPath)) fs.copyFileSync(gate.markdownPath, exported.replace(/\.json$/i, "") + ".md");
        reportPath = exported;
      }
    }
    if (!fs.existsSync(reportPath)) { console.error(`❌ Gate report not found: ${reportPath}`); process.exit(2); }
    try {
      const written = createProductBaseline({
        projectDir,
        reportPath,
        platform: selectedTarget.platform,
        target: selectedTarget.id,
        baselinePath: typeof flags.out === "string" ? flags.out : "",
        replace: flags.replace === true,
      });
      console.log(`✅ Conclusive baseline established — ${selectedTarget.platform}:${selectedTarget.name}`);
      console.log(`   ${written.validation.screensExplored} states · ${written.validation.actionsPerformed} actions · ${written.validation.suite.contracts} contracts · outcome ${written.validation.outcome}`);
      console.log(`   baseline: ${written.path}\n   source gate report: ${reportPath}`);
    } catch (error) { console.error(`❌ Baseline not written: ${error.message}`); process.exit(2); }
    break;
  }

  case "ci": {
    if (rest[0] === "install") {
      const { flags, positionals } = parseVerbArgs(rest.slice(1));
      let projectDir;
      try { projectDir = fs.realpathSync(path.resolve(positionals[0] || (typeof flags["project-dir"] === "string" ? flags["project-dir"] : process.cwd()))); }
      catch { console.error(`❌ Repository directory not found: ${positionals[0] || flags["project-dir"] || process.cwd()}`); process.exit(2); }
      const modelPath = typeof flags.model === "string" ? path.resolve(projectDir, flags.model) : existingProjectArtifactPath(projectDir, "application-model.json");
      if (!modelPath.startsWith(projectDir + path.sep) || !fs.existsSync(modelPath)) {
        console.error(`❌ Application model not found inside the repository: ${modelPath}\n   Run tapp init --explore first.`);
        process.exit(2);
      }
      const actionRef = typeof flags["action-ref"] === "string" ? flags["action-ref"] : `aarwitz/tapp@v${pkg.version}`;
      const { installProductCi, prepareProductCi } = await import(path.join(packageRoot, "mcp-server", "src", "product-operations.js"));
      let rendered;
      try {
        rendered = prepareProductCi({
          projectDir,
          modelPath,
          actionRef,
          defaultBranch: typeof flags["default-branch"] === "string" ? flags["default-branch"] : "main",
        });
      } catch (error) { console.error(`❌ Could not generate CI installation: ${error.message}`); process.exit(2); }
      if (typeof flags["json-out"] === "string") {
        const output = path.resolve(flags["json-out"]);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, JSON.stringify(rendered.manifest, null, 2) + "\n");
      }
      if (rendered.manifest.unresolved.length && flags["allow-unresolved"] !== true) {
        console.error("❌ CI workflow was not installed because target configuration remains unresolved:");
        for (const item of rendered.manifest.unresolved) console.error(`   - ${item.platform}:${item.targetId} — ${item.message}`);
        console.error("   Resolve these in the application model and rerun init, or use --allow-unresolved only to inspect a non-working draft.");
        process.exit(2);
      }
      if (flags["dry-run"] === true) {
        console.log(rendered.workflow);
        console.error(`🧩 CI dry run — ${rendered.manifest.targets.length} target job(s) · ${rendered.manifest.unresolved.length} unresolved · no files written`);
        break;
      }
      try {
        const written = installProductCi({
          projectDir,
          modelPath,
          actionRef,
          defaultBranch: typeof flags["default-branch"] === "string" ? flags["default-branch"] : "main",
          workflowPath: typeof flags.out === "string" ? flags.out : ".github/workflows/tapp.yml",
          manifestPath: typeof flags.manifest === "string" ? flags.manifest : ".tapp/ci.json",
          replace: flags.replace === true,
          allowUnresolved: flags["allow-unresolved"] === true,
        });
        console.log(`✅ Reviewable CI gate installed — ${written.manifest.targets.length} target job(s)`);
        for (const target of written.manifest.targets) console.log(`   ${target.platform}:${target.name} · ${target.contracts.length} contract(s) · baseline ${target.baseline || "automatic after first conclusive default-branch run"}`);
        console.log(`   workflow: ${written.workflowPath}\n   manifest: ${written.manifestPath}`);
        if (!written.manifest.actionRefImmutable) console.log(`   ⚠️ Action ref ${written.manifest.actionRef} is a release tag, not a commit SHA; resolve and pin that tag's 40-character SHA before production.`);
        console.log("   Tapp did not commit, push, enable branch protection, or create GitHub resources.");
      } catch (error) { console.error(`❌ CI installation not written: ${error.message}`); process.exit(2); }
      break;
    }
    const r = spawnSync("bash", [path.join(packageRoot, "scripts", "ci-gate.sh"), ...rest], {
      stdio: "inherit",
    });
    process.exit(r.status ?? 1);
  }

  case "app":
  case "studio": {
    const { flags, positionals } = parseVerbArgs(rest);
    let projectDir;
    if (positionals[0]) {
      try { projectDir = fs.realpathSync(path.resolve(positionals[0])); }
      catch { console.error(`❌ Repository directory not found: ${positionals[0]}`); process.exit(2); }
    }
    const port = flags.port === undefined ? 0 : Number(flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error("❌ --port must be 0..65535"); process.exit(2); }
    const { startBrowserProduct } = await import(path.join(packageRoot, "mcp-server", "src", "browser-product.js"));
    const product = await startBrowserProduct({ projectDir, port, launch: flags.open !== false && flags["no-open"] !== true });
    console.log(`Tapp · ${product.root || "choose a local folder or GitHub repository in the browser"}`);
    console.log(`Open: ${product.launchUrl}`);
    console.log("Local-only session; press Ctrl-C to stop.");
    const shutdown = async () => { try { await product.close(); } finally { process.exit(0); } };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await new Promise(() => {});
    break;
  }

  case "report": {
    // Regenerate + open the HTML evidence page for a capture (default: the latest).
    const capturesDir = path.join(tappHome, "captures");
    const repoCaptures = path.join(packageRoot, "captures");
    const roots = [capturesDir, repoCaptures].filter((d) => fs.existsSync(d));
    const runs = roots
      .flatMap((root) => fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name)))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const wanted = rest[0] && rest[0] !== "latest" ? runs.find((r) => path.basename(r) === rest[0]) : runs[0];
    if (!wanted) {
      bad("No captures found", rest[0] ? `no capture named "${rest[0]}"` : "run a QA exploration first");
      process.exit(1);
    }
    const { writeHtmlReport } = await import(path.join(packageRoot, "mcp-server", "src", "html-report.js"));
    const out = writeHtmlReport(wanted, { label: path.basename(wanted) });
    if (!out) {
      bad("Capture has no markers", wanted);
      process.exit(1);
    }
    ok("Evidence report", out);
    spawnSync("open", [out], { stdio: "ignore" });
    break;
  }

  case "version":
  case "--version":
  case "-v": {
    console.log(pkg.version);
    break;
  }

  default: {
    console.log(`tapp v${pkg.version} — ship with proof. Autonomous exploration and deterministic release gates for iOS, Android, and web.

Core — explore, prove, gate (agents and humans can just run these — no server, no setup):
  tapp explore [target]    Autonomous exploration → findings + evidence (an observation, NOT a
                           release decision — run 'tapp ci' to gate a merge)
                           (--platform ios|android|web · --app-id ID · --apk FILE · --actions N)
  tapp contract run FILE   Replay a business-level release contract — the guarantees that must hold
  tapp ci ...              Merge-blocking release gate — explore + suites + baseline → pass/fail/inconclusive
                           (see: tapp ci --help)

Primitives — an agent's eyes and hands (no setup):
  tapp open [target]       Launch the app → screen summary + screenshot saved to a file
                           (web: --tap TEXT · --wait-for TEXT · --out FILE)
  tapp tree [target]       Accessibility tree of the current screen (--json for every element)
                           (web: --tap TEXT · --wait-for TEXT)

Repository & release:
  tapp init [repo]         Detect targets and write the application model + reviewable release plan
                           (--explore grounds the UI Map · --url URL · --platform · --dry-run · --refresh)
  tapp baseline create [repo] Run/import a conclusive full gate and save a target-scoped baseline
  tapp report [captureId]  Open the HTML evidence page for a capture (default: latest)
  tapp ci install [repo]   Generate a reviewable target-aware GitHub workflow + CI manifest
  tapp actor set NAME      Configure an actor using environment-variable names only (never values)
  tapp actor list [repo]   Inspect named actors, sessions, provisioning, and secret env bindings

Advanced — deterministic suites, lifecycle & compilers:
  tapp flow run FILE       Replay a committed deterministic Flow (no AI/API key)
  tapp flow validate FILE  Validate a Flow without launching a target
  tapp task validate FILE  Validate a reusable deterministic Task (+ optional UI Map grounding)
  tapp task compile FILE   Compile one Task to the shared keyless Flow execution contract
  tapp task run FILE       Replay a Task directly on iOS, Android, or web
  tapp contract validate FILE  Validate a business-level TypeScript release contract
  tapp contract compile FILE   Compile a contract to the shared deterministic executor
  tapp scenario run FILE   Replay an isolated multi-actor system Scenario (web)
  tapp scenario validate FILE  Validate actors, lifecycle, and deterministic steps
  tapp pr plan --base REF      Select critical + diff-relevant contracts and report uncovered changes
  tapp pr adopt PLAN --item ID Explicitly add an observed PR coverage proposal to the release plan
  tapp plan show [FILE]    Inspect the proposed/accepted release-contract plan
  tapp plan review [FILE]  Explicitly approve, reject, or defer proposed plan items
  tapp plan generate [FILE] Generate compile-checked, untrusted contract drafts from approved Tasks
  tapp plan validate [FILE] Replay drafts on a real target; trust only after all platforms pass
  tapp plan promote [FILE] Move fully validated drafts into reviewed Tasks/contracts + map coverage
  tapp map build MARKERS    Build/merge the persistent platform-neutral UI Map
  tapp map inspect [FILE]   Inspect states, controls, platforms, and map validity
  tapp map diff A B         Diff observed UI structure without false reachability claims

Simulator & workspace:
  tapp shot                Screenshot the booted simulator → file path (--out file.jpg)
  tapp build [dir]         Build the iOS app in a repo for the simulator + install it (--scheme S)
  tapp apps                List apps installed on the booted simulator (with bundle ids)
  tapp app [repo]          Optional local browser workspace for repository onboarding and review
                           (loopback-only; --no-open · --port PORT)

  [target] is whatever you have — nothing (in an initialized repo, bare 'tapp explore' drives the
  application model's default target from source: managed web is built/started/stopped, iOS is
  built + installed, Android is built to an APK + installed; otherwise it finds + builds the Xcode
  project in the current dir, or falls back to the app on the simulator), a repo dir, a
  path/to/App.app, a bundle id, an Android app id/APK (--platform android --app-id ...), or an
  http(s) URL. For iOS you never need to know a bundle id up front.

Setup:
  tapp install    Prebuild the exploration harness (~2 min; otherwise builds on first use)
  tapp doctor     Check Xcode / simulators / toolchain
  tapp mcp        Start the MCP server on stdio (adds inline screenshots + interactive sessions)

MCP hookup (optional — for inline screenshots and the tap/type/inspect session loop):
  Claude Code:   claude mcp add tapp -- npx -y @aarwitz/tapp mcp
  Cursor/VS Code (mcp.json):
    { "servers": { "tapp": { "type": "stdio", "command": "npx", "args": ["-y", "@aarwitz/tapp", "mcp"] } } }

Then ask your agent things like:
  "Explore com.mycompany.app and show me what breaks"
  "Open the settings screen and show me the screenshot"
  "Drive the login flow and record it as a replayable test"

Docs: ${pkg.homepage}`);
    break;
  }
}

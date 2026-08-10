import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { parseOcqaMarkers, buildQaReport, computeRegression, qaScoreLabel, verdictBadge } from "./report.js";
import { existingProjectArtifactPath, projectArtifactDirectory } from "./project-paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const scriptsDir = path.join(repoRoot, "scripts");
// TAPP_HOME (set by the `tapp` CLI when installed) redirects writable output to a user directory.
// The old alias remains a read-only fallback; unset repository development stays local.
const tappHome = (process.env.TAPP_HOME || process.env.AUTOTAP_HOME || "").trim();
const capturesDir = tappHome ? path.join(tappHome, "captures") : path.join(repoRoot, "captures");
const MAX_OUTPUT_CHARS = 60_000;
const requiredAuthToken = (process.env.TAPP_MCP_TOKEN || process.env.AUTOTAP_MCP_TOKEN || "").trim();

function clampOutput(value, maxChars = MAX_OUTPUT_CHARS) {
  if (typeof value !== "string") {
    return "";
  }

  if (value.length <= maxChars) {
    return value;
  }

  const dropped = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n...[truncated ${dropped} chars]`;
}

function asBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function asInteger(value, fallback) {
  if (Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }

  return fallback;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeCapturePath(inputPath) {
  const resolved = path.resolve(inputPath);
  const normalizedCapturesRoot = path.resolve(capturesDir);
  const insideCaptures =
    resolved === normalizedCapturesRoot || resolved.startsWith(`${normalizedCapturesRoot}${path.sep}`);

  if (!insideCaptures) {
    return null;
  }

  return resolved;
}

function isAuthRequired() {
  return requiredAuthToken.length > 0;
}

function ensureAuthorized(args = {}) {
  if (!isAuthRequired()) {
    return null;
  }

  const provided = typeof args.authToken === "string" ? args.authToken.trim() : "";
  if (provided !== requiredAuthToken) {
    return errorResult("Unauthorized", {
      reason: "Provide valid authToken when TAPP_MCP_TOKEN is set",
    });
  }

  return null;
}

function runCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 10 * 60 * 1000;
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: { ...process.env, ...(options.env || {}) },
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const timeoutMessage = timedOut ? `\nProcess timed out after ${timeoutMs}ms` : "";
      resolve({
        code: timedOut ? 124 : (code ?? 1),
        stdout: clampOutput(stdout),
        stderr: clampOutput(`${stderr}${timeoutMessage}`.trim()),
        timedOut,
      });
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        code: 1,
        stdout: clampOutput(stdout),
        stderr: clampOutput(`${stderr}\n${error.message}`.trim()),
        timedOut: false,
      });
    });
  });
}

function listCaptureRuns(limit = 10) {
  if (!fs.existsSync(capturesDir)) {
    return [];
  }

  const entries = fs
    .readdirSync(capturesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const full = path.join(capturesDir, d.name);
      const stat = fs.statSync(full);
      return {
        id: d.name,
        path: full,
        relativePath: path.relative(repoRoot, full),
        modifiedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));

  return entries.slice(0, Math.max(1, limit));
}

function summarizeCapture(runPath) {
  if (!fs.existsSync(runPath)) {
    return null;
  }

  const files = fs.readdirSync(runPath);
  const screenshotsDir = files.includes("screenshots") ? path.join(runPath, "screenshots") : null;
  const screenshotCount = screenshotsDir && fs.existsSync(screenshotsDir)
    ? fs.readdirSync(screenshotsDir).filter((f) => f.endsWith(".png") || f.endsWith(".jpg") || f.endsWith(".jpeg")).length
    : 0;

  return {
    path: runPath,
    relativePath: path.relative(repoRoot, runPath),
    hasMarkers: files.includes("ocqa-markers.txt"),
    hasFullOutput: files.includes("full-output.txt"),
    hasUITree: files.includes("uitree.json"),
    videos: files.filter((f) => f.endsWith(".mov") || f.endsWith(".webm") || f.endsWith(".mp4")),
    screenshotsDir,
    screenshotCount,
    files,
  };
}



async function listSimulators() {
  const res = await runCommand("xcrun", ["simctl", "list", "devices", "-j"]);
  if (res.code !== 0) return { error: res.stderr || "simctl failed", simulators: [] };
  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    return { error: "could not parse simctl JSON", simulators: [] };
  }
  const sims = [];
  for (const [runtime, devices] of Object.entries(data.devices || {})) {
    for (const d of devices || []) {
      if (d.isAvailable === false) continue;
      sims.push({
        name: d.name,
        udid: d.udid,
        state: d.state,
        booted: d.state === "Booted",
        runtime: runtime.replace("com.apple.CoreSimulator.SimRuntime.", ""),
      });
    }
  }
  return { simulators: sims, booted: sims.filter((s) => s.booted) };
}

// Pre-flight for every iOS entry point: the #1 first-session failure is "no simulator
// booted", and the harness's raw failure text is unactionable. Long-running tools
// (run_qa) auto-boot the first available iPhone; fast tools return an instructive error
// the agent can act on instead of a shrug.
export async function ensureBootedSim({ autoBoot = false } = {}) {
  const sims = await listSimulators();
  if (sims.booted && sims.booted.length) return { booted: sims.booted[0] };
  // A failed listing is NOT "no simulators" — surface the real reason (was silently
  // misdiagnosed as "No iOS simulators exist" when simctl errored in odd environments).
  if (sims.error) {
    return {
      error:
        `Could not query iOS simulators — xcrun simctl failed: ${String(sims.error).slice(0, 300)}. ` +
        `Is Xcode installed and healthy? Try in a terminal: xcrun simctl list devices`,
    };
  }
  const candidate = (sims.simulators || []).find((s) => s.name.startsWith("iPhone")) || (sims.simulators || [])[0];
  if (!candidate) {
    return { error: "No iOS simulators exist on this Mac. Install a simulator runtime in Xcode (Settings → Platforms), then retry." };
  }
  if (!autoBoot) {
    return { error: `No simulator is booted. Call tapp_boot_simulator (e.g. udid "${candidate.udid}" — ${candidate.name}) and retry.` };
  }
  await runCommand("xcrun", ["simctl", "boot", candidate.udid], { timeoutMs: 2 * 60 * 1000 });
  const st = await runCommand("xcrun", ["simctl", "bootstatus", candidate.udid, "-b"], { timeoutMs: 3 * 60 * 1000 });
  if (st.code !== 0) return { error: `Auto-boot of ${candidate.name} failed — boot one manually with tapp_boot_simulator.` };
  return { booted: candidate, autoBooted: true };
}

// The #1 real first-run failure: the bundle id isn't installed on the sim (typo, or the app was
// never installed). Without this pre-flight the harness reports a misleading "crashed at launch"
// and sessions die with an unactionable error — check cheaply up front instead.
async function appInstalledOnBootedSim(bundleId) {
  const r = await runCommand("xcrun", ["simctl", "get_app_container", "booted", bundleId, "app"], { timeoutMs: 15_000 });
  return r.code === 0;
}

function notInstalledError(bundleId, booted) {
  const name = booted && booted.name ? booted.name : "the booted simulator";
  return (
    `\`${bundleId}\` is not installed on ${name}. Install a simulator build first — ` +
    `tapp_install_app with the .app path (CLI: xcrun simctl install booted path/to/App.app) — ` +
    `or double-check the bundle id (xcrun simctl listapps booted).`
  );
}

// ---- App target resolution: users have a repo, a built .app, or nothing — not a bundle id.
// The ladder turns whatever they have into an installed bundle id. Shared by the CLI verbs
// and the tapp_build MCP tool.

export async function listInstalledUserApps() {
  const r = await runCommand("xcrun", ["simctl", "listapps", "booted"], { timeoutMs: 30_000 });
  if (r.code !== 0) return { error: "Could not list installed apps", details: { stderr: r.stderr } };
  // simctl emits an old-style plist; plutil converts it.
  const tmp = path.join(os.tmpdir(), `tapp-apps-${Date.now().toString(36)}.plist`);
  fs.writeFileSync(tmp, r.stdout);
  const conv = await runCommand("plutil", ["-convert", "json", "-o", "-", tmp], { timeoutMs: 30_000 });
  try { fs.rmSync(tmp, { force: true }); } catch {}
  let data;
  try {
    data = JSON.parse(conv.stdout);
  } catch {
    return { error: "Could not parse the installed-app list", details: { stderr: conv.stderr } };
  }
  const apps = Object.entries(data)
    .filter(([bundleId, a]) => a && a.ApplicationType === "User" && !bundleId.endsWith(".xctrunner"))
    .map(([bundleId, a]) => ({ bundleId, name: a.CFBundleDisplayName || a.CFBundleName || bundleId }));
  return { apps };
}

// Prefer a real .xcworkspace (CocoaPods layout) over a bare .xcodeproj; ignore the
// project.xcworkspace every .xcodeproj contains. Shallow search, dependency dirs skipped.
export function findXcodeContainer(startDir) {
  // The target may BE the container ("build MyApp.xcodeproj" — agents do this).
  if (/\.(xcworkspace|xcodeproj)$/.test(startDir) && fs.existsSync(startDir)) return startDir;
  const skip = new Set(["node_modules", "Pods", "DerivedData", "build", "Carthage", ".build", ".git"]);
  const workspaces = [];
  const projects = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name.endsWith(".xcworkspace")) {
        if (!dir.endsWith(".xcodeproj")) workspaces.push(p);
        continue;
      }
      if (e.name.endsWith(".xcodeproj")) {
        projects.push(p);
        continue;
      }
      if (skip.has(e.name) || e.name.startsWith(".")) continue;
      if (depth < 3) walk(p, depth + 1);
    }
  };
  walk(startDir, 0);
  const shallowest = (arr) => arr.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length)[0];
  return workspaces.length ? shallowest(workspaces) : projects.length ? shallowest(projects) : null;
}

export async function buildAppForSim({ dir, container, scheme, configuration = "Debug" } = {}) {
  const target = container || findXcodeContainer(dir || process.cwd());
  if (!target) return { error: `No Xcode project or workspace found under ${dir || process.cwd()}` };
  const isWorkspace = target.endsWith(".xcworkspace");
  let schemeName = isNonEmptyString(scheme) ? scheme.trim() : "";
  if (!schemeName) {
    const list = await runCommand("xcodebuild", ["-list", "-json", isWorkspace ? "-workspace" : "-project", target], { timeoutMs: 120_000 });
    try {
      const j = JSON.parse(list.stdout);
      const schemes = (isWorkspace ? j.workspace && j.workspace.schemes : j.project && j.project.schemes) || [];
      const base = path.basename(target).replace(/\.(xcworkspace|xcodeproj)$/, "");
      schemeName = schemes.find((s) => s === base) || schemes.find((s) => !/tests?$/i.test(s)) || schemes[0];
    } catch { /* fall through to the error below */ }
    if (!schemeName) {
      return {
        error:
          `Could not detect a scheme in ${path.basename(target)}. Pass one explicitly, and make sure it is ` +
          `shared (Xcode: Product → Scheme → Manage Schemes → check Shared).`,
      };
    }
  }
  const derived = path.join(tappHome || os.tmpdir(), "app-builds", schemeName.replace(/[^a-zA-Z0-9]/g, "_"));
  const build = await runCommand(
    "xcodebuild",
    [
      "build",
      isWorkspace ? "-workspace" : "-project", target,
      "-scheme", schemeName,
      "-configuration", configuration,
      "-destination", "generic/platform=iOS Simulator",
      "-derivedDataPath", derived,
    ],
    { cwd: path.dirname(target), timeoutMs: 25 * 60 * 1000 }
  );
  if (build.code !== 0) {
    const errors = (build.stdout + "\n" + build.stderr).split("\n").filter((l) => /error:/i.test(l)).slice(0, 8);
    return {
      error: `Build failed (scheme ${schemeName})${build.timedOut ? " — timed out" : ""}`,
      details: { errors, tail: (build.stderr || build.stdout || "").slice(-1500) },
    };
  }
  const productsDir = path.join(derived, "Build/Products", `${configuration}-iphonesimulator`);
  let apps = [];
  try {
    // Exclude UI-test Runner bundles — the classic wrong pick when a repo has test targets.
    apps = fs.readdirSync(productsDir).filter((f) => f.endsWith(".app") && !f.endsWith("-Runner.app"));
  } catch { /* handled below */ }
  const appName = apps.find((f) => f.replace(/\.app$/, "") === schemeName) || apps[0];
  if (!appName) return { error: "Built .app not found after the build", details: { productsDir } };
  return { appPath: path.join(productsDir, appName), scheme: schemeName, container: target, configuration };
}

function androidApkCandidates(moduleDir) {
  const output = path.join(moduleDir, "build", "outputs", "apk");
  const candidates = [];
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".apk") && !/androidTest|test/i.test(absolute)) candidates.push(absolute);
    }
  };
  visit(output);
  return candidates.sort((left, right) => {
    const leftDebug = /debug/i.test(left) ? 1 : 0;
    const rightDebug = /debug/i.test(right) ? 1 : 0;
    if (leftDebug !== rightDebug) return rightDebug - leftDebug;
    return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
  });
}

export async function buildAndroidApp({ projectDir, gradleProjectDir, moduleDir, task = "assembleDebug" } = {}) {
  const root = fs.realpathSync(path.resolve(projectDir || process.cwd()));
  const gradleRoot = path.resolve(gradleProjectDir || root);
  const moduleRoot = path.resolve(moduleDir || root);
  if (!isInsideDir(root, gradleRoot) || !isInsideDir(root, moduleRoot)) return { error: "Android build paths must remain inside the repository" };
  const wrapper = path.join(gradleRoot, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  const command = fs.existsSync(wrapper) ? (process.platform === "win32" ? wrapper : "bash") : "gradle";
  const args = fs.existsSync(wrapper) && process.platform !== "win32" ? [wrapper, task, "--no-daemon"] : [task, "--no-daemon"];
  const build = await runCommand(command, args, { cwd: gradleRoot, timeoutMs: 25 * 60 * 1000 });
  if (build.code !== 0) {
    const errors = `${build.stdout}\n${build.stderr}`.split("\n").filter((line) => /(?:error|failure|exception)/i.test(line)).slice(-10);
    return { error: `Android build failed (${task})${build.timedOut ? " — timed out" : ""}`, details: { errors, tail: (build.stderr || build.stdout || "").slice(-1800) } };
  }
  const apkPath = androidApkCandidates(moduleRoot)[0];
  if (!apkPath) return { error: `Android build completed but no application APK was found under ${path.relative(root, moduleRoot) || "."}/build/outputs/apk` };
  return { apkPath, task, gradleProjectDir: gradleRoot, moduleDir: moduleRoot };
}

export async function installAppOnBootedSim(appPath, { cleanInstall = true } = {}) {
  const bid = await runCommand("/usr/libexec/PlistBuddy", ["-c", "Print CFBundleIdentifier", path.join(appPath, "Info.plist")], { timeoutMs: 30_000 });
  const bundleId = (bid.stdout || "").trim();
  if (!bundleId) return { error: `Could not read CFBundleIdentifier from ${appPath}/Info.plist — is this a simulator .app build?` };
  if (cleanInstall) {
    // Clean install: stale keychain items from a previous install leave apps half-signed-in
    // (Firebase Auth's "error accessing the keychain") — uninstall first for a fresh state.
    await runCommand("xcrun", ["simctl", "terminate", "booted", bundleId], { timeoutMs: 30_000 });
    await runCommand("xcrun", ["simctl", "uninstall", "booted", bundleId], { timeoutMs: 60_000 });
  }
  const inst = await runCommand("xcrun", ["simctl", "install", "booted", appPath], { timeoutMs: 3 * 60 * 1000 });
  if (inst.code !== 0) return { error: `Install failed: ${(inst.stderr || "").trim().slice(0, 300)}` };
  return { bundleId };
}

export async function resolveAppTarget(input, { cwd = process.cwd(), onStatus = () => {}, scheme = "", configuration = "Debug" } = {}) {
  const t = (input || "").trim();

  // A built .app bundle → install it, read the bundle id from Info.plist.
  if (t.endsWith(".app")) {
    const appPath = path.resolve(cwd, t);
    if (!fs.existsSync(appPath)) return { error: `.app not found: ${appPath}` };
    const sim = await ensureBootedSim({ autoBoot: true });
    if (sim.error) return { error: sim.error };
    onStatus(`Installing ${path.basename(appPath)}…`);
    const inst = await installAppOnBootedSim(appPath);
    if (inst.error) return inst;
    return {
      bundleId: inst.bundleId,
      via: `installed ${path.basename(appPath)}`,
      targetResolution: { kind: "prebuilt-artifact-installed", bundleId: inst.bundleId },
    };
  }

  // Looks like a bundle id (dots, not a path, not a local file) → use as-is; the
  // is-it-installed pre-flight downstream catches typos with an actionable message.
  if (t && !t.includes("/") && t.includes(".") && !fs.existsSync(path.resolve(cwd, t))) {
    return { bundleId: t, targetResolution: { kind: "application-id", bundleId: t } };
  }

  // A directory (or no argument at all) → find the Xcode project, build, install.
  const dir = t ? path.resolve(cwd, t) : cwd;
  if (t && !fs.existsSync(dir)) return { error: `Not a bundle id, .app path, or directory: ${t}` };
  const container = findXcodeContainer(dir);
  if (container) {
    const sim = await ensureBootedSim({ autoBoot: true });
    if (sim.error) return { error: sim.error };
    onStatus(`Found ${path.basename(container)} — building for the simulator (a first build can take a few minutes)…`);
    const built = await buildAppForSim({ container, scheme, configuration });
    if (built.error) return built;
    onStatus(`Built ${path.basename(built.appPath)} (scheme ${built.scheme}) — installing…`);
    const inst = await installAppOnBootedSim(built.appPath);
    if (inst.error) return inst;
    return {
      bundleId: inst.bundleId,
      via: `built ${path.basename(container)} → installed ${path.basename(built.appPath)}`,
      targetResolution: {
        kind: "xcode-build-installed",
        bundleId: inst.bundleId,
        build: {
          container: built.container,
          scheme: built.scheme,
          configuration: built.configuration,
        },
      },
    };
  }

  // Nothing to build → fall back to what's already on the simulator.
  const sim = await ensureBootedSim({ autoBoot: true });
  if (sim.error) return { error: sim.error };
  const la = await listInstalledUserApps();
  if (la.error) return la;
  if (la.apps.length === 1) {
    return {
      bundleId: la.apps[0].bundleId,
      via: `the only app installed on the simulator (${la.apps[0].name})`,
      targetResolution: { kind: "installed-application", bundleId: la.apps[0].bundleId },
    };
  }
  if (la.apps.length > 1) {
    return {
      error:
        `No Xcode project found under ${dir}, and ${la.apps.length} apps are installed on the simulator — say which one:\n` +
        la.apps.map((a) => `  ${a.bundleId}  (${a.name})`).join("\n"),
    };
  }
  return {
    error:
      `Nothing to test: no Xcode project/workspace under ${dir} and no app installed on the simulator. ` +
      `Run from your app repo, or pass a bundle id or a path to a simulator .app build.`,
  };
}

// ---- Persistent interactive session (Playwright-style tap/type/inspect loop) ----
// The harness `testInteractiveSession` launches the app ONCE and services commands from a file,
// emitting the fresh UI tree after each. The MCP server is a long-lived process, so it can hold the
// running session across tool calls.
let activeSession = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function consumeSessionStdout(chunk) {
  if (!activeSession) return;
  activeSession.buffer += chunk;
  const START = "OCQA_UITREE_START";
  const END = "OCQA_UITREE_END";
  let s;
  while ((s = activeSession.buffer.indexOf(START)) >= 0) {
    const e = activeSession.buffer.indexOf(END, s);
    if (e < 0) break;
    const json = activeSession.buffer.slice(s + START.length, e).trim();
    activeSession.buffer = activeSession.buffer.slice(e + END.length);
    try {
      activeSession.latestTree = JSON.parse(json);
      activeSession.treeVersion += 1;
    } catch {
      /* partial/garbled tree — ignore */
    }
  }
  if (activeSession.buffer.includes("OCQA_SESSION:ready")) activeSession.ready = true;
  if (activeSession.buffer.length > 200_000) activeSession.buffer = activeSession.buffer.slice(-50_000);
}

function treeSnapshot() {
  const t = activeSession && activeSession.latestTree;
  return {
    screenTitle: t ? t.screenTitle ?? null : null,
    elementCount: t ? (t.elements || []).length : 0,
    elements: t ? t.elements || [] : [],
  };
}

async function startSession(bundleId, extraEnv = {}) {
  if (activeSession && !activeSession.ended) {
    return { error: "A session is already active; call tapp_session_end first.", screen: treeSnapshot() };
  }
  const sim = await ensureBootedSim();
  if (sim.error) return { error: sim.error };
  if (!(await appInstalledOnBootedSim(bundleId))) return { error: notInstalledError(bundleId, sim.booted) };
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const cmdPath = `/tmp/ocqa-session-${token}-cmd.json`;
  const resultPath = `/tmp/ocqa-session-${token}-res.json`;
  for (const p of [cmdPath, resultPath]) { try { fs.rmSync(p, { force: true }); } catch {} }

  const captureScript = path.join(scriptsDir, "quick-capture.sh");
  const proc = spawn("bash", [captureScript, "session", bundleId], {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv, OCQA_SESSION_CMD_PATH: cmdPath, OCQA_SESSION_RESULT_PATH: resultPath, OCQA_SESSION_TIMEOUT: "7200" },
  });
  activeSession = {
    proc, bundleId, seq: 0, cmdPath, resultPath, latestTree: null, treeVersion: 0, buffer: "", ready: false, ended: false,
    // Always-on recorder: each act appends a Flow step; tapp_flow_save snapshots it to a file.
    recording: [],
    creds: { email: extraEnv.OCQA_TEST_EMAIL || "", password: extraEnv.OCQA_TEST_PASSWORD || "" },
    lastScreen: null,
  };
  proc.stdout.on("data", (d) => consumeSessionStdout(String(d)));
  // quick-capture writes harness build diagnostics to stderr. Preserve the bounded tail in the
  // same session buffer so a remote/managed caller receives the actual Xcode failure instead of
  // the generic "process exited" fallback.
  proc.stderr.on("data", (d) => consumeSessionStdout(String(d)));
  proc.on("close", () => { if (activeSession && activeSession.proc === proc) activeSession.ended = true; });

  const deadline = Date.now() + 240_000; // build + launch can take a few minutes on first run
  while (!activeSession.ready && Date.now() < deadline && !activeSession.ended) await sleep(300);
  if (activeSession.ended) {
    // Surface the real failure from the harness output instead of a shrug.
    const errLine = ((activeSession.buffer || "").match(/error:\s*([^\n]+)/) || [])[1];
    activeSession = null;
    return { error: `Session process exited before it became ready${errLine ? ` — ${errLine.trim()}` : " (build/launch failed?)."}` };
  }
  if (!activeSession.ready) { return { error: "Session did not become ready within the time limit." }; }

  const td = Date.now() + 10_000;
  while (!activeSession.latestTree && Date.now() < td) await sleep(200);
  activeSession.lastScreen = treeSnapshot().screenTitle;
  return { ok: true, ...treeSnapshot() };
}

async function startAndroidSession(appId, { serial, apkPath, clearData = true, testEmail = "", testPassword = "" } = {}) {
  if (activeSession && !activeSession.ended) {
    return { error: "A session is already active; call tapp_session_end first.", screen: treeSnapshot() };
  }
  try {
    const { AndroidDriver } = await import("./android-driver.js");
    const driver = new AndroidDriver({ appId, serial });
    await driver.ensureDevice();
    if (apkPath) await driver.install(path.resolve(apkPath));
    const snap = await driver.launch({ clearData });
    activeSession = {
      platform: "android", driver, appId, bundleId: appId, latestTree: snap, treeVersion: 1,
      recording: [], creds: { email: testEmail, password: testPassword }, lastScreen: snap.screenTitle,
      ended: false,
    };
    return { ok: true, ...treeSnapshot() };
  } catch (error) {
    activeSession = null;
    return { error: error.message || String(error) };
  }
}

async function webSessionSnapshot(page) {
  const snapshot = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const controls = [...document.querySelectorAll("button,a[href],input,textarea,select,[role=button],[role=tab],[role=checkbox],[role=switch]")]
      .filter((element) => element instanceof HTMLElement && visible(element))
      .slice(0, 250)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const label = String(element.getAttribute("aria-label") || element.labels?.[0]?.textContent || element.textContent || element.getAttribute("placeholder") || element.getAttribute("name") || element.id || "").replace(/\s+/g, " ").trim().slice(0, 160);
        return {
          id: element.getAttribute("data-testid") || element.id || element.getAttribute("name") || "",
          label,
          type: element.getAttribute("role") || element.tagName.toLowerCase(),
          role: element.getAttribute("role") || (element.matches("button,[role=button]") ? "button" : element.matches("a") ? "link" : element.matches("input,textarea,select") ? "input" : "other"),
          enabled: !(element.disabled || element.getAttribute("aria-disabled") === "true"),
          hittable: true,
          clickable: element.matches("button,a,[role=button],[role=tab],[role=checkbox],[role=switch]") && !(element.disabled || element.getAttribute("aria-disabled") === "true"),
          secure: element instanceof HTMLInputElement && element.type === "password",
          frame: { x:Math.round(rect.x), y:Math.round(rect.y), width:Math.round(rect.width), height:Math.round(rect.height) },
        };
      });
    const heading = document.querySelector("h1,[role=heading]")?.textContent?.replace(/\s+/g, " ").trim();
    return { screenTitle:heading || document.title || location.pathname || "Web application", elements:controls, url:location.href };
  });
  return snapshot;
}

function webAttributeSelector(attribute, value) {
  return `[${attribute}="${String(value || "").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`;
}

async function firstVisibleWebLocator(page, target, { input = false } = {}) {
  const value = String(target || "").trim();
  if (!value) return null;
  const candidates = [
    page.locator(webAttributeSelector("data-testid", value)).first(),
    page.locator(webAttributeSelector("id", value)).first(),
    page.locator(webAttributeSelector("name", value)).first(),
    page.getByLabel(value, { exact: true }).first(),
    ...(input ? [page.getByPlaceholder(value, { exact: true }).first()] : [
      page.getByRole("button", { name:value, exact:true }).first(),
      page.getByRole("link", { name:value, exact:true }).first(),
      page.getByText(value, { exact:true }).first(),
    ]),
  ];
  for (const locator of candidates) if (await locator.isVisible().catch(() => false)) return locator;
  const fallback = page.getByText(value, { exact:false }).first();
  return await fallback.isVisible().catch(() => false) ? fallback : null;
}

async function startWebSession(url, { testEmail = "", testPassword = "" } = {}) {
  if (activeSession && !activeSession.ended) return { error: "A session is already active; call tapp_session_end first.", screen:treeSnapshot() };
  let browser;
  try {
    const parsed = new URL(String(url || ""));
    if (!/^https?:$/.test(parsed.protocol)) return { error:"Web session URL must be http(s)" };
    const { loadPlaywright } = await import("./web-explorer.js");
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ headless:true });
    const context = await browser.newContext({ viewport:{ width:1280, height:900 } });
    const page = await context.newPage();
    await page.goto(parsed.href, { waitUntil:"domcontentloaded", timeout:30_000 });
    await page.waitForLoadState("networkidle", { timeout:5_000 }).catch(() => {});
    const snapshot = await webSessionSnapshot(page);
    activeSession = {
      platform:"web", browser, context, page, latestTree:snapshot, treeVersion:1, recording:[],
      creds:{ email:testEmail, password:testPassword },
      lastScreen:snapshot.screenTitle, ended:false,
    };
    return { ok:true, ...treeSnapshot(), url:snapshot.url };
  } catch (error) {
    await browser?.close().catch(() => {});
    activeSession = null;
    return { error:error.message || String(error) };
  }
}

/** Turn a typed value into a shareable token: known creds become $TEST_EMAIL / $TEST_PASSWORD. */
function templateValue(text) {
  const c = (activeSession && activeSession.creds) || {};
  if (c.email && text === c.email) return "$TEST_EMAIL";
  if (c.password && text === c.password) return "$TEST_PASSWORD";
  return text;
}

/** Append a Flow step for an act (record-by-doing). Inserts wait_for on screen change for
 *  deterministic replay. Inspection acts (tree/screenshot/wait) are not recorded. */
function recordStep(cmd, result) {
  if (!activeSession || !activeSession.recording) return;
  const newScreen = result && result.screenTitle;
  const changed = newScreen && newScreen !== activeSession.lastScreen;
  switch (cmd.action) {
    case "tap": {
      const target = cmd.id || cmd.label || (typeof cmd.x === "number" ? `${cmd.x},${cmd.y}` : "");
      if (target) activeSession.recording.push({ tap: target });
      if (changed) activeSession.recording.push({ wait_for: newScreen });
      break;
    }
    case "type": {
      const step = { value: templateValue(cmd.text ?? "") };
      if (cmd.id) step.field = cmd.id;
      activeSession.recording.push({ type: step });
      break;
    }
    case "swipe":
      activeSession.recording.push({ swipe: cmd.direction || "up" });
      break;
    case "back":
      activeSession.recording.push({ back: true });
      if (changed) activeSession.recording.push({ wait_for: newScreen });
      break;
    default:
      break; // tree / screenshot / wait are inspection, not test steps
  }
  if (newScreen) activeSession.lastScreen = newScreen;
}

async function sessionAct(cmd) {
  if (!activeSession || activeSession.ended) return { error: "No active session. Call tapp_session_start first." };
  if (activeSession.platform === "web") {
    const session = activeSession;
    let status = "ok";
    let detail = null;
    let typedInto = null;
    try {
      if (cmd.action === "tap") {
        const locator = await firstVisibleWebLocator(session.page, cmd.id || cmd.label || "");
        if (!locator) { status = "not_found"; detail = "No visible web control matched the semantic target"; }
        else await locator.click({ timeout:10_000 });
      } else if (cmd.action === "type") {
        const locator = await firstVisibleWebLocator(session.page, cmd.id || cmd.label || "", { input:true });
        if (!locator) { status = "not_found"; detail = "No visible web field matched the semantic target"; }
        else { await locator.fill(String(cmd.text || "")); typedInto = cmd.id || cmd.label || null; }
      } else if (cmd.action === "wait") {
        const deadline = Date.now() + Math.max(100, Math.min(60_000, Number(cmd.timeoutMs) || 5000));
        let locator = null;
        while (!locator && Date.now() < deadline) {
          locator = await firstVisibleWebLocator(session.page, cmd.id || cmd.text || "");
          if (!locator) await session.page.waitForTimeout(120);
        }
        if (!locator) { status = "timeout"; detail = `Timed out waiting for ${cmd.id || cmd.text || "target"}`; }
      } else if (cmd.action === "back") {
        await session.page.goBack({ waitUntil:"domcontentloaded", timeout:10_000 }).catch(() => {});
      } else if (cmd.action === "swipe") {
        const amount = ["down", "right"].includes(cmd.direction) ? -650 : 650;
        await session.page.mouse.wheel(cmd.direction === "left" || cmd.direction === "right" ? amount : 0, cmd.direction === "up" || cmd.direction === "down" ? amount : 650);
      } else if (!['tree', 'screenshot'].includes(cmd.action)) {
        status = "error"; detail = `Unsupported web session action '${cmd.action}'`;
      }
      await session.page.waitForTimeout(300);
      session.latestTree = await webSessionSnapshot(session.page);
      session.treeVersion += 1;
    } catch (error) {
      status = error.name === "TimeoutError" ? "timeout" : "error";
      detail = error.message || String(error);
      session.latestTree = await webSessionSnapshot(session.page).catch(() => session.latestTree);
    }
    const snapshot = treeSnapshot();
    if (status === "ok") recordStep(cmd, snapshot);
    return { status, typedInto, detail, ...snapshot, recordedSteps:session.recording.length, url:session.latestTree?.url || "" };
  }
  if (activeSession.platform === "android") {
    const s = activeSession;
    let status = "ok";
    let detail = null;
    let typedInto = null;
    try {
      if (cmd.action === "tap") {
        if (typeof cmd.x === "number" && typeof cmd.y === "number") {
          const r = await s.driver.adb(["shell", "input", "tap", String(Math.round(cmd.x)), String(Math.round(cmd.y))]);
          status = r.code === 0 ? "ok" : "not_hittable";
        } else {
          const r = await s.driver.tap(cmd.id || cmd.label || "", s.latestTree);
          status = r.status; detail = r.detail || null;
        }
      } else if (cmd.action === "type") {
        const r = await s.driver.type(cmd.id || "", cmd.text || "", s.latestTree);
        status = r.status; detail = r.detail || null; typedInto = cmd.id || r.element?.label || null;
      } else if (cmd.action === "swipe") {
        await s.driver.swipe(cmd.direction || "up");
      } else if (cmd.action === "back") {
        await s.driver.back();
      } else if (cmd.action === "wait") {
        const waited = await s.driver.waitFor(cmd.id || cmd.text || "", cmd.timeoutMs || 5000);
        status = waited ? "ok" : "timeout";
        if (waited) s.latestTree = waited;
      } else if (cmd.action === "login") {
        const fields = s.latestTree.elements.filter((e) => /EditText/i.test(e.type));
        const emailField = fields.find((e) => /email|user/i.test(`${e.id} ${e.label}`)) || fields.find((e) => !e.secure);
        const passwordField = fields.find((e) => e.secure || /password|passcode/i.test(`${e.id} ${e.label}`));
        if (!emailField || !passwordField) {
          status = "not_found"; detail = "Could not identify email and password fields";
        } else {
          const er = await s.driver.type(emailField.id || emailField.label, cmd.email || s.creds.email || "", s.latestTree);
          s.latestTree = await s.driver.settle();
          const pr = await s.driver.type(passwordField.id || passwordField.label, cmd.password || s.creds.password || "", s.latestTree);
          s.latestTree = await s.driver.settle();
          const submit = s.latestTree.elements.find((e) => e.clickable && /sign in|log in|login|continue/i.test(`${e.text} ${e.label} ${e.id}`));
          if (er.status !== "ok" || pr.status !== "ok" || !submit) {
            status = "not_found"; detail = "Could not fill or submit the login form";
          } else {
            const before = s.latestTree.screenTitle;
            await s.driver.tap(submit.id || submit.description || submit.text, s.latestTree);
            s.latestTree = await s.driver.settle();
            if (s.latestTree.screenTitle === before) { status = "still_on_login"; detail = "Submit left the app on the login screen"; }
          }
        }
      }
      if (!["wait", "tree", "screenshot", "login"].includes(cmd.action)) s.latestTree = await s.driver.settle();
    } catch (error) {
      status = "error"; detail = error.message || String(error);
    }
    s.treeVersion += 1;
    const snap = treeSnapshot();
    if (status === "ok") recordStep(cmd, snap);
    return { status, typedInto, detail, ...snap, recordedSteps: s.recording.length };
  }
  activeSession.seq += 1;
  const seq = activeSession.seq;
  const beforeVer = activeSession.treeVersion;
  const tmp = activeSession.cmdPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ seq, ...cmd }));
  fs.renameSync(tmp, activeSession.cmdPath); // atomic so the harness never reads a partial command

  // A `wait` can block in the harness up to its own timeout — give the ack poll enough headroom.
  let status = "timeout";
  let typedInto = null;
  let detail = null;
  // login runs a full fill+submit+verify sequence in the harness; wait can block up to its
  // own timeout — both need more ack headroom than a single tap.
  const ackBudget = cmd.action === "wait" ? (cmd.timeoutMs || 5000) + 10_000 : cmd.action === "login" ? 180_000 : 60_000;
  const deadline = Date.now() + ackBudget;
  while (Date.now() < deadline && !activeSession.ended) {
    await sleep(150);
    try {
      const res = JSON.parse(fs.readFileSync(activeSession.resultPath, "utf8"));
      if (res.seq === seq) { status = res.status; typedInto = res.typedInto || null; detail = res.detail || null; break; }
    } catch {}
  }
  // Give the post-action tree a moment to arrive.
  const td = Date.now() + 5_000;
  while (activeSession.treeVersion === beforeVer && Date.now() < td && !activeSession.ended) await sleep(150);
  const snap = treeSnapshot();
  if (status === "ok") recordStep(cmd, snap); // record only successful acts
  return { status, typedInto, detail, ...snap, recordedSteps: activeSession ? activeSession.recording.length : 0 };
}

async function endSession() {
  if (!activeSession) return { ok: true, note: "no session" };
  const s = activeSession;
  if (s.platform === "web") {
    activeSession = null;
    await s.browser.close().catch(() => {});
    return { ok:true };
  }
  if (s.platform === "android") {
    await s.driver.forceStop().catch(() => {});
    activeSession = null;
    return { ok: true };
  }
  if (!s.ended) {
    try {
      s.seq += 1;
      fs.writeFileSync(s.cmdPath, JSON.stringify({ seq: s.seq, action: "quit" }));
    } catch {}
    await sleep(800);
    try { s.proc.kill("SIGTERM"); } catch {}
  }
  activeSession = null;
  return { ok: true };
}

/**
 * Persist the recording owned by the shared interactive-session engine.
 *
 * The caller supplies the repository root deliberately: MCP uses the checkout
 * that hosts this package, while browser/managed adapters use the customer's
 * isolated workspace. Interface layers must not reproduce recorder or YAML
 * semantics, and an existing human-authored Flow is never overwritten unless
 * replacement was explicitly requested.
 */
export async function saveInteractiveSessionFlow({ projectDir, name, addFinalAssertion = true, replace = false, url = "" } = {}) {
  if (!activeSession || activeSession.ended) throw new Error("No active session to save. Start one and drive it first.");
  const flowName = String(name || "").trim();
  if (!flowName) throw new Error("Flow name is required");
  const root = path.resolve(String(projectDir || ""));
  if (!projectDir || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error("A valid repository root is required to save a Flow");
  const steps = [...(activeSession.recording || [])];
  if (steps.length === 0) throw new Error("Nothing recorded yet — perform some live-session actions first.");
  if (addFinalAssertion && activeSession.lastScreen) {
    const last = steps[steps.length - 1] || {};
    if (!("assert_screen" in last)) steps.push({ assert_screen: activeSession.lastScreen });
  }
  const platform = activeSession.platform || "ios";
  const flow = {
    name: flowName,
    ...(platform !== "ios" ? { platform } : {}),
    ...(platform === "web"
      ? (String(url || "").trim() ? { url:String(url).trim() } : {})
      : { app:activeSession.bundleId }),
    ...(platform === "android" ? { reset:"clear" } : {}),
    steps,
  };
  const slug = flowName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "flow";
  const dir = path.join(root, ".tapp", "flows");
  const outPath = path.join(dir, `${slug}.yml`);
  if (fs.existsSync(outPath) && !replace) {
    const error = new Error(`Flow '${path.relative(root, outPath)}' already exists. Choose another name or explicitly replace it.`);
    error.code = "TAPP_FLOW_EXISTS";
    throw error;
  }
  const yamlResult = await runCommand("python3", [path.join(scriptsDir, "flow_lib.py"), "to-yaml", JSON.stringify(flow)], { cwd:root });
  const yaml = String(yamlResult.stdout || "").trim();
  if (!yaml || yamlResult.code !== 0) throw new Error(String(yamlResult.stderr || "Failed to render Flow YAML").trim());
  fs.mkdirSync(dir, { recursive:true });
  fs.writeFileSync(outPath, `${yaml}\n`, { flag:replace ? "w" : "wx" });
  return { path:path.relative(root, outPath), flow, yaml, replaced:replace };
}

// Structured interactive-session primitives for trusted local adapters such as the
// managed cloud runner. They preserve the same persistent harness, semantic selectors,
// action recording, and post-action UI tree used by MCP instead of reimplementing
// simulator control in an interface layer.
export {
  startSession as startIosInteractiveSession,
  startAndroidSession as startAndroidInteractiveSession,
  startWebSession as startWebInteractiveSession,
  sessionAct as actInteractiveSession,
  endSession as endInteractiveSession,
};

export async function captureInteractiveSessionFrame(maxWidth = 900) {
  if (!activeSession || activeSession.ended) return { error:"No active interactive session" };
  if (activeSession.platform === "android") {
    try {
      const data = await activeSession.driver.screenshot();
      return { data:data.toString("base64"), mimeType:"image/png", bytes:data.length };
    } catch (error) { return { error:error.message || String(error) }; }
  }
  if (activeSession.platform === "web") {
    try {
      const data = await activeSession.page.screenshot({ type:"jpeg", quality:72, fullPage:false });
      return { data:data.toString("base64"), mimeType:"image/jpeg", bytes:data.length };
    } catch (error) { return { error:error.message || String(error) }; }
  }
  return captureScreenshotImage(maxWidth);
}

// Fast "just show me a screen": launch the app fresh (optionally bypassing login), grab a screenshot
// while it's on screen, return the tree too, then close it. No exploration. Uses the session
// machinery only to keep the app alive long enough to photograph it.
export async function openApp(bundleId, extraEnv, maxWidth) {
  const start = await startSession(bundleId, extraEnv);
  if (start.error) return { error: start.error };
  const img = await captureScreenshotImage(maxWidth);
  const result = { screenTitle: start.screenTitle ?? null, elements: start.elements ?? [], img };
  await endSession();
  return result;
}

// Run an autonomous exploration and stream OCQA_PROGRESS live by tailing the capture's
// harness-output.txt (which the explore mode writes to as the harness runs). onProgress is called
// with each {action,max,states} as it arrives. Resolves with the created capture once done.
async function runExploreStreaming(bundleId, actions, timeout, env, onProgress) {
  const captureScript = path.join(scriptsDir, "quick-capture.sh");
  const cmdArgs = [captureScript, "explore", bundleId, "--actions", String(actions), "--timeout", String(timeout)];
  const before = new Set(listCaptureRuns(80).map((r) => r.id));
  const proc = spawn("bash", cmdArgs, { cwd: repoRoot, env: { ...process.env, ...env } });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});
  const closed = new Promise((res) => proc.on("close", (code) => res(code ?? 1)));

  let captureDir = null;
  let pos = 0;
  let timedOut = false;
  // Interactive runs pause for a human — time spent waiting is excluded from the harness's own
  // budget, so give the watchdog matching headroom.
  const interactiveGrace = env.OCQA_INTERACTIVE_INPUT === "1" ? 900 : 0;
  const hardDeadline = Date.now() + (timeout + 240 + interactiveGrace) * 1000;
  const requestSidecar = env.OCQA_INPUT_RESPONSE_PATH ? env.OCQA_INPUT_RESPONSE_PATH + ".request" : null;

  while (true) {
    const which = await Promise.race([closed.then(() => "closed"), sleep(1200).then(() => "tick")]);
    if (!captureDir) {
      const c = listCaptureRuns(80).find((r) => !before.has(r.id));
      if (c) captureDir = c.path;
    }
    if (captureDir) {
      const hp = path.join(captureDir, "harness-output.txt");
      try {
        const size = fs.statSync(hp).size;
        if (size > pos) {
          const fd = fs.openSync(hp, "r");
          const buf = Buffer.alloc(size - pos);
          fs.readSync(fd, buf, 0, buf.length, pos);
          fs.closeSync(fd);
          pos = size;
          for (const line of buf.toString("utf8").split("\n")) {
            if (line.startsWith("OCQA_PROGRESS:")) {
              try { onProgress(JSON.parse(line.slice("OCQA_PROGRESS:".length))); } catch {}
            }
            // Surface harness pause requests to the host as a sidecar file next to the response
            // path — prompting hosts (VS Code extension) poll it, answer the human, and write
            // the response file the harness itself is polling.
            if (requestSidecar && line.startsWith("OCQA_AWAIT_INPUT:")) {
              try { fs.writeFileSync(requestSidecar, line.slice("OCQA_AWAIT_INPUT:".length), { mode: 0o600 }); } catch {}
            }
            if (requestSidecar && line.startsWith("OCQA_INPUT_RESOLVED:")) {
              try { fs.rmSync(requestSidecar, { force: true }); } catch {}
            }
          }
        }
      } catch {
        /* file not there yet */
      }
    }
    if (which === "closed") break;
    if (Date.now() > hardDeadline) { try { proc.kill("SIGTERM"); } catch {} timedOut = true; break; }
  }
  await closed;
  const created = listCaptureRuns(80).find((r) => !before.has(r.id))
    || (captureDir ? { id: path.basename(captureDir), path: captureDir, relativePath: path.relative(repoRoot, captureDir) } : null);
  return { created, timedOut };
}

// Grab the booted simulator's current screen and return it downscaled + JPEG-compressed so the
// payload stays small enough for an MCP client to render inline. Works standalone or mid-session
// (it just photographs whatever is on the booted sim).
export async function captureScreenshotImage(maxWidth) {
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const png = `/tmp/tapp-shot-${stamp}.png`;
  const jpg = `/tmp/tapp-shot-${stamp}.jpg`;
  const r = await runCommand("xcrun", ["simctl", "io", "booted", "screenshot", png], { timeoutMs: 30_000 });
  if (!fs.existsSync(png)) return { error: "Screenshot failed (is a simulator booted?)", stderr: r.stderr };
  await runCommand("sips", ["-Z", String(maxWidth), "-s", "format", "jpeg", "-s", "formatOptions", "60", png, "--out", jpg], { timeoutMs: 30_000 });
  const file = fs.existsSync(jpg) ? jpg : png;
  const data = fs.readFileSync(file).toString("base64");
  const mimeType = file === jpg ? "image/jpeg" : "image/png";
  const bytes = fs.statSync(file).size;
  for (const p of [png, jpg]) { try { fs.rmSync(p, { force: true }); } catch {} }
  return { data, mimeType, bytes };
}

// ---- Model backend (subscription proxy / BYO key) — mirrors Tapp/Services/ModelBackend.swift.
// Used by AI-generate (tapp_flow_generate). Resolution: Tapp subscription token → proxy;
// else ANTHROPIC_API_KEY → api.anthropic.com; else null (feature disabled).
// Remote-AI opt-in for IMPLICIT model calls (post-run finding enrichment). A bare
// ANTHROPIC_API_KEY is often ambient in dev shells — its mere presence must never silently
// change data-handling behavior. A subscription token is an explicit tapp choice, and
// explicitly-invoked AI tools (tapp_flow_generate, assert_ai) carry their own consent.
export function remoteAiOptedIn(env = process.env) {
  if ((env.TAPP_SUBSCRIPTION_TOKEN || env.AUTOTAP_SUBSCRIPTION_TOKEN || "").trim()) return true;
  return ["1", "true", "yes"].includes(String(env.TAPP_ENABLE_REMOTE_AI || "").trim().toLowerCase());
}

// Robust "is p inside root" — a plain startsWith(root) accepts sibling dirs that share a
// prefix (/repos/tapp vs /repos/tapp-malicious).
export function isInsideDir(root, p) {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

function resolveModelBackend() {
  const token = (process.env.TAPP_SUBSCRIPTION_TOKEN || process.env.AUTOTAP_SUBSCRIPTION_TOKEN || "").trim();
  if (token) {
    const base = (process.env.TAPP_PROXY_URL || process.env.AUTOTAP_PROXY_URL || "http://localhost:8787").replace(/\/$/, "");
    const url = base.endsWith("/v1/messages") ? base : base + "/v1/messages";
    return { url, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
  }
  const key = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (key) {
    return { url: "https://api.anthropic.com/v1/messages", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" } };
  }
  return null;
}

async function callModel(backend, { system, userText, model, maxTokens = 1500 }) {
  const body = JSON.stringify({ model: model || process.env.TAPP_FLOW_MODEL || process.env.AUTOTAP_FLOW_MODEL || "claude-sonnet-4-6", max_tokens: maxTokens, system, messages: [{ role: "user", content: userText }] });
  const res = await fetch(backend.url, { method: "POST", headers: backend.headers, body });
  if (!res.ok) return { error: `model HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return { text };
}

// Build a compact grounding map of the app from a harness markers file: the distinct screens with
// their controls (from the OCQA_STATE `summary`) and the observed transitions. The model authors a
// Flow using ONLY what appears here, so it can't invent screens/buttons.
function buildAppGrounding(markersText) {
  const screens = new Map(); // title -> { role, summary }
  const transitions = [];
  let startScreen = null; // the first observed screen = the app's launch/entry point
  for (const line of markersText.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("OCQA_STATE:{")) {
      try {
        const s = JSON.parse(t.slice("OCQA_STATE:".length));
        const title = (s.screen || "").trim();
        if (title && title !== "Unknown") {
          if (!startScreen) startScreen = title;
          if (!screens.has(title)) screens.set(title, { role: s.role || "", summary: s.summary || "" });
        }
      } catch {}
    } else if (t.startsWith("OCQA_TRANSITION_RESOLVED:{")) {
      try {
        const o = JSON.parse(t.slice("OCQA_TRANSITION_RESOLVED:".length));
        if (o.from && o.to) transitions.push({ from: o.from, to: o.to, via: o.action || "" });
      } catch {}
    }
  }
  return { startScreen, screens: Array.from(screens.entries()).map(([title, v]) => ({ title, ...v })), transitions };
}

// Pull the clean, short control labels out of a describeScreen summary
// ("… Fields: Email, Password. Actions: Sign In, Sign Up.") — these are the exact strings the
// selector resolves, unlike the screen's long descriptive text.
function controlsFromSummary(summary) {
  const grab = (label) => {
    const m = new RegExp(`${label}:\\s*([^.]+)\\.`).exec(summary || "");
    return m ? m[1].split(",").map((s) => s.trim()).filter((s) => s && s.length <= 40) : [];
  };
  return { actions: grab("Actions"), fields: grab("Fields") };
}

function renderGroundingForPrompt(g) {
  // Per screen: the exact short control labels the flow may tap/type into.
  const L = [];
  if (g.startScreen) L.push(`ENTRY POINT: the app launches on screen "${g.startScreen}". Your FIRST step acts on that screen.`, "");
  L.push("OBSERVED SCREENS — tap targets MUST be an exact control listed for the screen you are on; screen names (wait_for/assert_screen) MUST be an exact title below:");
  for (const s of g.screens.slice(0, 40)) {
    const { actions, fields } = controlsFromSummary(s.summary);
    const parts = [];
    if (actions.length) parts.push(`tap: ${actions.map((a) => `"${a}"`).join(", ")}`);
    if (fields.length) parts.push(`fields: ${fields.map((f) => `"${f}"`).join(", ")}`);
    L.push(`- screen "${s.title}"${s.role ? ` [${s.role}]` : ""}${parts.length ? " — " + parts.join("; ") : ""}`);
  }
  if (g.transitions.length) {
    L.push("", "KNOWN NAVIGATIONS (tapping the control moved between screens — prefer these for navigation):");
    const seen = new Set();
    for (const tr of g.transitions) {
      const via = tr.via.replace(/^label:|^id:/, "");
      const k = `${tr.from}|${tr.to}|${via}`;
      if (seen.has(k) || via.length > 40) continue; seen.add(k);
      L.push(`- on "${tr.from}", tap "${via}" → "${tr.to}"`);
      if (seen.size >= 40) break;
    }
  }
  return L.join("\n");
}

const FLOW_AUTHOR_SYSTEM =
  "You author DETERMINISTIC end-to-end test Flows for an iOS app that Tapp will replay exactly. " +
  "You are given the app's REAL observed screens with the exact short control labels tappable on each, " +
  "the exact input field names, and the known navigations, plus a goal. Emit the SHORTEST Flow that " +
  "achieves the goal. HARD RULES: (1) a `tap` target must be VERBATIM one of the short control labels " +
  "listed for the screen you are currently on — NEVER a screen's descriptive sentence or a made-up " +
  "label; (2) `wait_for` and `assert_screen` must be a VERBATIM screen title from the list; (3) after " +
  "any tap that navigates, add `wait_for: <destination>`; (4) `type` only into a listed field; use " +
  "`$TEST_EMAIL`/`$TEST_PASSWORD` for credentials. If the goal cannot be reached with the observed " +
  "controls, produce the closest partial flow and stop — do not invent. Respond with ONLY JSON: " +
  '{"name":"<short name>","steps":[ {"tap":"X"}, {"wait_for":"Y"}, {"type":{"field":"F","value":"V"}}, {"assert_screen":"Z"}, {"assert_exists":"W"} ]}. ' +
  "No prose, no code fences.";

/** Parse the model's Flow JSON (tolerant of fences/prose). Returns { name, steps } or null. */
function parseGeneratedFlow(text) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  let obj;
  try { obj = JSON.parse(text.slice(s, e + 1)); } catch { return null; }
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) return null;
  return { name: typeof obj.name === "string" ? obj.name : "Generated flow", steps: obj.steps };
}

/** Flag steps that reference screens or tap targets not present in the grounding (hallucination
 *  guard — screen names must be observed titles; tap targets must be observed short controls). */
function ungroundedScreens(steps, grounding) {
  const knownScreens = new Set(grounding.screens.map((s) => s.title.toLowerCase()));
  const knownControls = new Set();
  for (const s of grounding.screens) {
    const { actions, fields } = controlsFromSummary(s.summary);
    for (const a of [...actions, ...fields]) knownControls.add(a.toLowerCase());
  }
  for (const tr of grounding.transitions) knownControls.add(tr.via.replace(/^label:|^id:/, "").toLowerCase());
  const bad = [];
  for (const step of steps) {
    const screen = step.wait_for || step.assert_screen;
    if (typeof screen === "string" && screen && !knownScreens.has(screen.toLowerCase())) bad.push(screen);
    const tapT = step.tap;
    if (typeof tapT === "string" && tapT && knownControls.size && !knownControls.has(tapT.toLowerCase())) bad.push(`tap:${tapT}`);
  }
  return Array.from(new Set(bad));
}

// Build the harness environment shared by run_qa and session_start: test credentials, app launch
// arguments / environment (e.g. UI_TEST_BACKEND, --uitesting / login bypass), and deterministic
// field overrides. quick-capture.sh folds the *_JSON vars into the run config.
export function explorationEnvFromArgs(args) {
  const env = {};
  if (isNonEmptyString(args.testEmail)) env.OCQA_TEST_EMAIL = args.testEmail;
  if (isNonEmptyString(args.testPassword)) env.OCQA_TEST_PASSWORD = args.testPassword;
  if (Array.isArray(args.appLaunchArgs)) {
    const a = args.appLaunchArgs.filter((s) => typeof s === "string" && s.length > 0);
    if (a.length) env.OCQA_APP_LAUNCH_ARGS_JSON = JSON.stringify(a);
  }
  if (args.appLaunchEnv && typeof args.appLaunchEnv === "object" && !Array.isArray(args.appLaunchEnv)) {
    const e = Object.fromEntries(Object.entries(args.appLaunchEnv).filter(([k, v]) => typeof k === "string" && typeof v === "string"));
    if (Object.keys(e).length) env.OCQA_APP_LAUNCH_ENV_JSON = JSON.stringify(e);
  }
  // Interactive mid-run input: the harness pauses at input screens (OCQA_AWAIT_INPUT) and
  // polls the response path — only when the host can actually prompt a human.
  if (args.interactive === true && isNonEmptyString(args.interactiveResponsePath)) {
    env.OCQA_INTERACTIVE_INPUT = "1";
    env.OCQA_INPUT_RESPONSE_PATH = args.interactiveResponsePath.trim();
  }
  if (args.inputOverrides && typeof args.inputOverrides === "object" && !Array.isArray(args.inputOverrides)) {
    const entries = Object.entries(args.inputOverrides).filter(
      ([k, v]) => typeof k === "string" && typeof v === "string" && k.trim() && v.length > 0
    );
    if (entries.length) env.OCQA_INPUT_OVERRIDES_JSON = JSON.stringify(Object.fromEntries(entries.map(([k, v]) => [k.trim(), v])));
  }
  if (args.prExplorationTarget && typeof args.prExplorationTarget === "object" && !Array.isArray(args.prExplorationTarget)) {
    env.OCQA_PR_TARGET_JSON = JSON.stringify(args.prExplorationTarget);
  }
  // Explicit login replay: a recorded sequence run before exploration, for custom login UIs the
  // heuristic preamble can't parse — the #1 reason a real app stays invisible. Steps are
  // {action: type|tap|wait, target, value?, timeoutMs?}; $TEST_EMAIL/$TEST_PASSWORD substituted
  // harness-side. Accepts step objects, or "action:target[:value]" strings for convenience.
  if (Array.isArray(args.loginSteps)) {
    const steps = args.loginSteps
      .map((s) => {
        if (s && typeof s === "object" && isNonEmptyString(s.action) && isNonEmptyString(s.target)) {
          const step = { action: String(s.action).toLowerCase(), target: String(s.target) };
          if (s.action === "wait" && Number.isInteger(s.timeoutMs)) step.timeoutMs = s.timeoutMs;
          else if (isNonEmptyString(s.value)) step.value = s.value;
          return step;
        }
        if (typeof s === "string") {
          const [action, target, ...rest] = s.split(":");
          if (!action || !target) return null;
          const third = rest.join(":");
          const step = { action: action.trim().toLowerCase(), target: target.trim() };
          if (step.action === "wait" && /^\d+$/.test(third)) step.timeoutMs = parseInt(third, 10);
          else if (third) step.value = third;
          return step;
        }
        return null;
      })
      .filter(Boolean);
    if (steps.length) env.OCQA_LOGIN_STEPS_JSON = JSON.stringify(steps);
  }
  return env;
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

function errorResult(message, details = {}) {
  return {
    isError: true,
    content: [{ type: "text", text: `❌ ${message}` }],
    structuredContent: { error: message, ...details },
  };
}

// ---- Modern, scannable tool output -------------------------------------------------------------
// Copilot / Cursor / Claude render the text of a tool result in-chat. Lead every result with a
// one-line ACTION headline + a compact, human-scannable body (severity icons, action words, next
// steps) instead of a raw JSON dump, and attach the full data via `structuredContent` for
// programmatic use. This is what makes Tapp feel like a modern dev harness
// ("Explored 14 screens · 3 issues · ship: caution") rather than a wall of JSON.
const SEV = { critical: "🔴", high: "🟠", medium: "🟡", low: "⚪️" };

/** Result with a human-readable text block first and structured data attached for the agent. */
function richResult(text, structured) {
  const out = { content: [{ type: "text", text: String(text).trimEnd() }] };
  if (structured !== undefined) out.structuredContent = structured;
  return out;
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Format a QA report as a scannable release readout with next-step suggestions. */
export function qaNextSteps(report, surface = "mcp") {
  if (surface === "cli") {
    const next = [];
    if (report?.findings?.length) next.push("inspect the evidence with `tapp report latest`");
    next.push("re-run with `--baseline <report.json>` to gate a fix");
    next.push("replay a committed journey with `tapp flow run <file>`");
    return next;
  }
  const next = [];
  if (report?.findings?.length) next.push("open a flagged screen with `tapp_open_app`");
  next.push("re-run with `baselineFindings` to gate a fix");
  next.push("drive it step-by-step via `tapp_session_start`");
  return next;
}

function formatQaReport(report, { regression, inputHint, timedOut, bundleId, aiConfigured, reportHtml, recording, uiMap, surface = "mcp" } = {}) {
  const c = report.findingCounts || {};
  const badge = verdictBadge(report);
  const sevBits = ["critical", "high", "medium", "low"]
    .map((k) => (c[k] ? `${SEV[k]} ${c[k]} ${k}` : null))
    .filter(Boolean)
    .join(", ");
  const L = [];
  L.push(`### 🧪 QA complete — ${badge} · ${qaScoreLabel(report)}${bundleId ? `\n\`${bundleId}\`` : ""}`);
  L.push("");
  L.push(report.headline);
  L.push("");
  L.push(`**Coverage** — ${report.screensExplored} screens · ${report.actionsPerformed} actions${timedOut ? " · ⏱️ hit time limit" : ""}`);
  if (report.platform === "web") {
    L.push(`**Verdict basis** — ${report.verdictFindingCounts?.total || 0} deterministic finding(s); ${report.sampledFindingCounts?.total || 0} sampled probe finding(s) are advisory`);
  }
  if (uiMap) L.push(`**UI Map** — ${uiMap.nodeCount} states · ${uiMap.edgeCount} transitions · ${uiMap.controlCount} semantic controls · ${uiMap.path}`);
  if (reportHtml) L.push(`**Evidence** — 📄 ${reportHtml} (screenshots of every screen + findings, shareable)`);
  if (recording) L.push(`**Recording** — 🎬 ${recording} (full exploration, embedded in the evidence page)`);
  L.push(`**Issues** — ${c.total ? `${c.total}${sevBits ? ` (${sevBits})` : ""}` : "none found ✨"}`);
  if (Array.isArray(report.findings) && report.findings.length) {
    L.push("");
    L.push("**Findings**");
    for (const f of report.findings.slice(0, 12)) {
      L.push(`- ${SEV[f.severity] || "•"} \`${f.severity}\` ${f.title}${f.screen ? ` — on *${f.screen}*` : ""}`);
      if (f.aiAnalysis) L.push(`  - why: ${String(f.aiAnalysis).slice(0, 200)}`);
      if (f.suggestedFix) L.push(`  - fix: ${String(f.suggestedFix).slice(0, 200)}`);
    }
    if (report.findings.length > 12) L.push(`- …and ${report.findings.length - 12} more`);
    // The "why?" itch is the AI-value moment — say it exactly here, only when it's real
    // (a key genuinely unlocks root causes + fixes), and never on a clean run.
    if (!aiConfigured) {
      L.push("");
      L.push("> 💡 Want a root cause + suggested fix for each finding? Set `ANTHROPIC_API_KEY` + `TAPP_ENABLE_REMOTE_AI=1` and re-run — analysis appears inline (sends finding metadata to the model provider; see SECURITY.md).");
    }
  }
  if (regression && regression.counts) {
    const g = regression.gate || {};
    L.push("");
    L.push(
      `**Since last run** — +${regression.counts.new} new · ${regression.counts.persisting} persisting · ${regression.counts.resolved} resolved · gate ${g.failed ? "🔴 FAIL" : "🟢 PASS"}`
    );
  }
  if (inputHint) {
    L.push("");
    L.push(`> ℹ️ ${inputHint}`);
  }
  // The honesty label: a "ready" is a claim about exactly these classes, nothing more.
  if (Array.isArray(report.checkedFor) && report.checkedFor.length) {
    L.push("");
    L.push(`> ✅ Checked: ${report.checkedFor.join(" · ")}`);
    if (Array.isArray(report.notChecked) && report.notChecked.length) {
      L.push(`> ⬜ Not checked this run: ${report.notChecked.join(" · ")}`);
      if (Array.isArray(report.conditionsNotReached) && report.conditionsNotReached.length) {
        L.push(`> ◻️ Conditions never reached: ${report.conditionsNotReached.join(" · ")}`);
      }
    }
  }
  const next = qaNextSteps(report, surface);
  L.push("");
  L.push(`**Next** — ${next.join(" · ")}`);
  // The gate hook belongs at the moment the user thinks "I want this on every PR" —
  // i.e. right after a verdict that found something, or after they hand-diffed a baseline.
  if ((report.findings && report.findings.length) || regression) {
    L.push("");
    L.push("> 🚦 Teams: get this verdict on every PR automatically (evidence + regression gate) — https://github.com/aarwitz/tapp#ci-gate");
  }
  return L.join("\n");
}

async function writeRunUiMap({ markersPath, platform, target, runId, outDir }) {
  try {
    const { buildUiMapFromMarkers, writeUiMap } = await import("./ui-map.js");
    const map = buildUiMapFromMarkers({ markersPath, platform, target, runId });
    const mapPath = writeUiMap(path.join(outDir, "ui-map.json"), map);
    return {
      schemaVersion: map.schemaVersion,
      path: mapPath,
      relativePath: path.relative(repoRoot, mapPath),
      nodeCount: map.nodes.length,
      edgeCount: map.edges.length,
      controlCount: map.nodes.reduce((total, node) => total + node.controls.length, 0),
    };
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

/** One-line "3 buttons · 2 fields · 8 text" breakdown of an accessibility element list. */
function elementBreakdown(elements) {
  const has = (e, ...pats) => pats.some((p) => String(e.type || "").includes(p));
  let buttons = 0, fields = 0, texts = 0, cells = 0, other = 0;
  for (const e of elements || []) {
    if (has(e, "Button", "rawValue: 9", "Link", "rawValue: 39")) buttons++;
    else if (has(e, "TextField", "rawValue: 49", "rawValue: 50", "SecureTextField")) fields++;
    else if (has(e, "StaticText", "rawValue: 48")) texts++;
    else if (has(e, "Cell", "rawValue: 75")) cells++;
    else other++;
  }
  return [
    buttons && `${buttons} button${buttons > 1 ? "s" : ""}`,
    fields && `${fields} field${fields > 1 ? "s" : ""}`,
    cells && `${cells} cell${cells > 1 ? "s" : ""}`,
    texts && `${texts} text`,
  ].filter(Boolean).join(" · ") || `${(elements || []).length} elements`;
}

/** Scannable "Read screen X — N elements (...)" readout, plus the tappable/typeable controls. */
export function formatScreen(screenTitle, elements) {
  const els = elements || [];
  const interactable = els.filter((e) => e.isEnabled !== false && (String(e.type).includes("Button") || String(e.type).includes("rawValue: 9") || String(e.type).includes("TextField") || String(e.type).includes("rawValue: 49") || String(e.type).includes("rawValue: 50") || String(e.type).includes("Cell") || String(e.type).includes("rawValue: 75")));
  const labels = interactable
    .map((e) => (e.label || e.identifier || "").trim())
    .filter((s) => s && s.length <= 40 && !s.includes("."))
    .slice(0, 8);
  const L = [`🌳 Read screen **${screenTitle || "Unknown"}** — ${els.length} elements (${elementBreakdown(els)})`];
  if (labels.length) L.push("", "**Controls:** " + labels.map((l) => `\`${l}\``).join(" · "));
  return L.join("\n");
}

// ---- Shared QA engine (one implementation, two consumers: the MCP tools below and the
// `tapp` CLI verbs in bin/tapp.js — same pattern as report.js. Keep orchestration HERE so
// the surfaces can't drift.)

export async function runQaWeb({ url, maxActions, timeout, testEmail, testPassword, baselineFindings, seedRoutes = [], seedTargets = [], surface = "mcp", onProgress = () => {} }) {
  const actions = Math.max(1, Math.min(1000, asInteger(maxActions, 60)));
  const timeoutSec = Math.max(30, Math.min(3600, asInteger(timeout, 600)));
  const id = "web-" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14).replace(/^(\d{8})/, "$1-");
  const outDir = path.join(capturesDir, id);
  let webResult;
  try {
    const { exploreWeb } = await import("./web-explorer.js");
    webResult = await exploreWeb({
      url: url.trim(),
      maxActions: actions,
      timeoutSec,
      outDir,
      testEmail: isNonEmptyString(testEmail) ? testEmail.trim() : "",
      testPassword: isNonEmptyString(testPassword) ? testPassword.trim() : "",
      seedRoutes,
      seedTargets,
      onProgress,
    });
  } catch (err) {
    return { error: String(err.message || err) };
  }
  const report = buildQaReport(webResult.markersPath, { platform: "web" });
  if (!report) return { error: "Web exploration produced no markers", details: { capture: { id, path: outDir } } };
  const backend = remoteAiOptedIn() ? resolveModelBackend() : null;
  if (backend && report.findings.length) {
    const { enrichFindings } = await import("./enrich.js");
    await enrichFindings(report.findings, { backend, callModel, screens: report.screens, appLabel: url.trim() });
  }
  const regression = computeRegression(report.findings, baselineFindings);
  const uiMap = await writeRunUiMap({ markersPath: webResult.markersPath, platform: "web", target: url.trim(), runId: id, outDir });
  let reportHtml = null;
  try {
    const { writeHtmlReport } = await import("./html-report.js");
    reportHtml = writeHtmlReport(outDir, { report, label: url.trim() });
  } catch { /* evidence page is best-effort */ }
  const structured = { ...report, regression, platform: "web", uiMap, reportHtml, exploration: { seedRoutes: webResult.seedRoutes || [], targets: webResult.seedTargets || [] }, capture: { id, path: outDir, relativePath: path.relative(repoRoot, outDir) } };
  const text = formatQaReport(report, { regression, bundleId: url.trim(), aiConfigured: !!backend, reportHtml, uiMap: uiMap.error ? null : uiMap, surface });
  return { structured, text };
}

export async function runQaAndroid({ appId, apkPath, serial, maxActions, timeout, testEmail, testPassword, baselineFindings, clearData = true, seedTargets = [], surface = "mcp", onProgress = () => {} }) {
  const actions = Math.max(1, Math.min(1000, asInteger(maxActions, 60)));
  const timeoutSec = Math.max(30, Math.min(3600, asInteger(timeout, 600)));
  const id = "android-" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14).replace(/^(\d{8})/, "$1-");
  const outDir = path.join(capturesDir, id);
  let androidResult;
  try {
    const { exploreAndroid } = await import("./android-explorer.js");
    androidResult = await exploreAndroid({
      appId: appId.trim(),
      apkPath: isNonEmptyString(apkPath) ? path.resolve(apkPath) : undefined,
      serial: isNonEmptyString(serial) ? serial.trim() : undefined,
      maxActions: actions,
      timeoutSec,
      outDir,
      testEmail: isNonEmptyString(testEmail) ? testEmail.trim() : "",
      testPassword: isNonEmptyString(testPassword) ? testPassword : "",
      clearData,
      seedTargets,
      onProgress,
    });
  } catch (error) {
    return { error: error.message || String(error), details: { capture: { id, path: outDir } } };
  }
  const report = buildQaReport(androidResult.markersPath, { platform: "android" });
  if (!report) return { error: "Android exploration produced no markers", details: { capture: { id, path: outDir } } };
  const backend = remoteAiOptedIn() ? resolveModelBackend() : null;
  if (backend && report.findings.length) {
    const { enrichFindings } = await import("./enrich.js");
    await enrichFindings(report.findings, { backend, callModel, screens: report.screens, appLabel: appId.trim() });
  }
  const regression = computeRegression(report.findings, baselineFindings);
  const uiMap = await writeRunUiMap({ markersPath: androidResult.markersPath, platform: "android", target: appId.trim(), runId: id, outDir });
  let reportHtml = null;
  try {
    const { writeHtmlReport } = await import("./html-report.js");
    reportHtml = writeHtmlReport(outDir, { report, label: appId.trim() });
  } catch {}
  const structured = { ...report, regression, platform: "android", uiMap, reportHtml, exploration: { targets: androidResult.seedTargets || [] }, capture: { id, path: outDir, relativePath: path.relative(repoRoot, outDir) } };
  const text = formatQaReport(report, { regression, bundleId: appId.trim(), aiConfigured: !!backend, reportHtml, uiMap: uiMap.error ? null : uiMap, surface });
  return { structured, text };
}

export async function runQaIos({ bundleId, maxActions, timeout, args = {}, surface = "mcp", onProgress = () => {} }) {
  const captureScript = path.join(scriptsDir, "quick-capture.sh");
  if (!fs.existsSync(captureScript)) return { error: "Capture script not found", details: { captureScript } };

  // run_qa runs for minutes anyway — auto-boot rather than bounce the user.
  const sim = await ensureBootedSim({ autoBoot: true });
  if (sim.error) return { error: sim.error };
  if (!(await appInstalledOnBootedSim(bundleId))) return { error: notInstalledError(bundleId, sim.booted) };

  const actions = Math.max(1, Math.min(1000, asInteger(maxActions, 60)));
  const timeoutSec = Math.max(30, Math.min(3600, asInteger(timeout, 600)));
  const env = explorationEnvFromArgs(args);

  const { created, timedOut } = await runExploreStreaming(bundleId, actions, timeoutSec, env, onProgress);
  if (!created) return { error: "Exploration produced no capture run", details: { timedOut } };

  const report = buildQaReport(path.join(created.path, "ocqa-markers.txt"));
  if (!report) {
    return {
      error: "No markers parsed from exploration (the app may not have launched)",
      details: { capture: { id: created.id, relativePath: created.relativePath } },
    };
  }
  // If the app showed input fields and the caller didn't supply values, tell the agent to ask the
  // user — Tapp fills with safe defaults autonomously and does NOT pause to prompt (that's the
  // standalone app's behavior; here the agent does the asking).
  const gaveValues = isNonEmptyString(args.testEmail) || isNonEmptyString(args.testPassword) || (args.inputOverrides && Object.keys(args.inputOverrides).length > 0);
  let inputHint;
  if (report.inputFieldsEncountered.length > 0 && !gaveValues) {
    const screensList = report.inputFieldsEncountered.map((s) => s.screen).slice(0, 5).join(", ");
    inputHint =
      `This app showed input fields${report.loginEncountered ? " including a login" : ""} on: ${screensList}. ` +
      `I explored autonomously and filled them with safe placeholder values — I did NOT pause to ask. ` +
      `If you want me to test with real values, tell me what to enter for these fields (or say "use defaults" / "skip"), ` +
      `and I'll re-run with testEmail/testPassword or inputOverrides — or I can drive it step-by-step in an interactive session so you can supply values as we go.`;
  }
  // Post-run AI enrichment (additive, never changes the verdict) — requires explicit
  // remote-AI opt-in; an ambient API key alone is not consent.
  const backend = remoteAiOptedIn() ? resolveModelBackend() : null;
  if (backend && report.findings.length) {
    const { enrichFindings } = await import("./enrich.js");
    await enrichFindings(report.findings, { backend, callModel, screens: report.screens, appLabel: bundleId });
  }
  // Cross-run regression vs. a caller-supplied baseline (the CI gate).
  const regression = computeRegression(report.findings, args.baselineFindings);
  const uiMap = await writeRunUiMap({ markersPath: path.join(created.path, "ocqa-markers.txt"), platform: "ios", target: bundleId, runId: created.id, outDir: created.path });
  let reportHtml = null;
  try {
    const { writeHtmlReport } = await import("./html-report.js");
    reportHtml = writeHtmlReport(created.path, { report, label: bundleId });
  } catch { /* evidence page is best-effort */ }
  const recording =
    ["exploration.webm", "exploration.mov"].map((f) => path.join(created.path, f)).find((p) => fs.existsSync(p)) || null;
  const structured = {
    ...report,
    regression,
    uiMap,
    inputHint,
    reportHtml,
    recording,
    capture: { id: created.id, path: created.path, relativePath: created.relativePath },
    timedOut,
    autoBooted: sim.autoBooted || false,
  };
  const text = formatQaReport(report, { regression, inputHint, timedOut, bundleId, aiConfigured: !!backend, reportHtml, recording, uiMap: uiMap.error ? null : uiMap, surface });
  return { structured, text };
}

/**
 * First-run import bridge: exercise one real target through the ordinary QA
 * engine, then merge that run's capture-local UI Map into the repository map.
 * This is shared by CLI and MCP so `tapp init --explore` is not a second
 * crawler. It never invokes AI implicitly and never interprets a shallow-map
 * absence as a regression.
 */
export async function runInitExploration({
  projectDir,
  platform,
  outDir = ".tapp",
  url = "",
  target = "",
  bundleId = "",
  appId = "",
  apkPath,
  serial,
  scheme,
  configuration,
  maxActions,
  timeout,
  testEmail,
  testPassword,
  onProgress = () => {},
  onStatus = () => {},
} = {}) {
  let root;
  try { root = fs.realpathSync(path.resolve(projectDir || process.cwd())); }
  catch { return { error: `Repository directory not found: ${projectDir || process.cwd()}` }; }
  const selected = String(platform || (url ? "web" : appId || apkPath ? "android" : "ios")).toLowerCase();
  if (!["ios", "android", "web"].includes(selected)) return { error: "platform must be ios|android|web" };
  const mapPath = path.resolve(root, projectArtifactDirectory(root, outDir), "ui-map.json");
  if (!isInsideDir(root, mapPath)) return { error: "UI Map output must remain inside the repository" };

  let resolvedTarget = "";
  let targetResolution = null;
  let qa;
  let managedRuntime = null;
  if (selected === "web") {
    if (/^https?:\/\//i.test(String(url))) {
      resolvedTarget = String(url).trim();
      qa = await runQaWeb({ url: resolvedTarget, maxActions, timeout, testEmail, testPassword, onProgress });
    } else {
      const started = await startManagedWebTarget({ root, requestedTarget: target, timeout, onStatus });
      if (started.error) return started;
      managedRuntime = started;
      resolvedTarget = started.url;
      try {
        qa = await runQaWeb({ url: resolvedTarget, maxActions, timeout, testEmail, testPassword, onProgress });
      } finally {
        await stopManagedWebTarget(started);
      }
    }
  } else if (selected === "android") {
    if (!String(appId || "").trim()) return { error: "Android init exploration requires --app-id" };
    resolvedTarget = String(appId).trim();
    qa = await runQaAndroid({ appId: resolvedTarget, apkPath, serial, maxActions, timeout, testEmail, testPassword, onProgress });
  } else {
    resolvedTarget = String(bundleId || "").trim();
    if (!resolvedTarget) {
      const resolved = await resolveAppTarget(String(target || root), { cwd: root, onStatus, scheme, configuration });
      if (resolved.error) return resolved;
      resolvedTarget = resolved.bundleId;
      targetResolution = resolved.targetResolution || null;
      if (resolved.via) onStatus(`Target ${resolvedTarget} — ${resolved.via}`);
    }
    qa = await runQaIos({
      bundleId: resolvedTarget,
      maxActions,
      timeout,
      args: { testEmail, testPassword },
      onProgress,
    });
  }
  if (qa?.error) return qa;
  const observedPath = qa?.structured?.uiMap?.path;
  if (!observedPath || !fs.existsSync(observedPath)) {
    return { error: "Exploration completed without a readable UI Map", details: { capture: qa?.structured?.capture } };
  }

  try {
    const { diffUiMaps, mergeUiMaps, validateUiMap, writeUiMap } = await import("./ui-map.js");
    const observed = JSON.parse(fs.readFileSync(observedPath, "utf8"));
    const observedErrors = validateUiMap(observed);
    if (observedErrors.length) return { error: `Exploration UI Map is invalid: ${observedErrors.join("; ")}` };
    let previous = null;
    if (fs.existsSync(mapPath)) {
      previous = JSON.parse(fs.readFileSync(mapPath, "utf8"));
      const previousErrors = validateUiMap(previous);
      if (previousErrors.length) return { error: `Existing repository UI Map is invalid: ${previousErrors.join("; ")}` };
    }
    const merged = previous ? mergeUiMaps(previous, observed) : observed;
    merged.provenance ||= {};
    merged.provenance.lastRun = {
      id: qa.structured.capture?.id || observed.provenance?.runIds?.at(-1) || "",
      platform: selected,
      verdict: qa.structured.verdict,
      inconclusive: qa.structured.inconclusive === true,
      statesExplored: Number(qa.structured.screensExplored || merged.nodes.length),
      actionsPerformed: Number(qa.structured.actionsPerformed || 0),
      observedAt: observed.provenance?.lastObservedAt || new Date().toISOString(),
    };
    writeUiMap(mapPath, merged);
    return {
      platform: selected,
      target: resolvedTarget,
      ...(targetResolution ? {
        targetValidation: {
          platform: selected,
          target: resolvedTarget,
          resolution: targetResolution,
          evidence: {
            captureId: qa.structured.capture?.id || "",
            verdict: qa.structured.verdict,
            inconclusive: qa.structured.inconclusive === true,
            observedAt: observed.provenance?.lastObservedAt || new Date().toISOString(),
          },
        },
      } : {}),
      uiMapPath: mapPath,
      uiMap: {
        schemaVersion: merged.schemaVersion,
        nodeCount: merged.nodes.length,
        edgeCount: merged.edges.length,
        controlCount: merged.nodes.reduce((total, node) => total + node.controls.length, 0),
      },
      mapDiff: previous ? diffUiMaps(previous, observed, { comparableFullSweep: false }) : null,
      verdict: qa.structured.verdict,
      inconclusive: qa.structured.inconclusive === true,
      findings: qa.structured.findings || [],
      capture: qa.structured.capture,
      reportHtml: qa.structured.reportHtml || null,
      managedRuntime: !!managedRuntime,
      ...(managedRuntime ? { runtime: { logPath: managedRuntime.logPath, install: managedRuntime.install, build: managedRuntime.build, start: managedRuntime.start } } : {}),
      qa: qa.structured,
    };
  } catch (error) {
    return { error: `Could not ground repository UI Map: ${error.message || String(error)}` };
  }
}

function openLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function managedInstallSpec(command) {
  const known = {
    "npm ci": ["npm", ["ci"]],
    "corepack pnpm install --frozen-lockfile": ["corepack", ["pnpm", "install", "--frozen-lockfile"]],
    "corepack yarn install --immutable": ["corepack", ["yarn", "install", "--immutable"]],
    "bun install --frozen-lockfile": ["bun", ["install", "--frozen-lockfile"]],
  };
  return known[command] || null;
}

function declaredPortFromStartScript(script) {
  const source = String(script || "");
  const matches = [
    /(?:^|[\s;&|])PORT\s*=\s*([0-9]{1,5})(?=\s|$)/i,
    /(?:--port|-p)(?:\s+|=)([0-9]{1,5})(?=\s|$)/i,
    /(?:^|\s)(?:python3?|python)\s+-m\s+http\.server\s+([0-9]{1,5})(?=\s|$)/i,
  ];
  for (const pattern of matches) {
    const value = Number(pattern.exec(source)?.[1] || 0);
    if (Number.isInteger(value) && value > 0 && value <= 65535) return value;
  }
  return 0;
}

async function runManagedBuildStep(label, command, args, cwd, timeoutMs, onStatus) {
  onStatus(`${label}: ${command} ${args.join(" ")}`);
  const result = await runCommand(command, args, { cwd, timeoutMs });
  if (result.code !== 0) return { error: `${label} failed`, details: { command, args, cwd, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut } };
  return { label, command, args, cwd };
}

async function waitForOwnedUrl(url, child, timeoutMs, logPath) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { error: `Managed web runtime exited before becoming ready`, details: { exitCode: child.exitCode, logPath } };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(url, { redirect: "manual", signal: controller.signal });
      if (response.status < 500) return { ready: true };
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error.message || String(error); }
    finally { clearTimeout(timer); }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { error: `Managed web runtime did not become ready within ${Math.round(timeoutMs / 1000)}s`, details: { url, logPath, lastError } };
}

export async function startManagedWebTarget({ root, requestedTarget = "", timeout, onStatus = () => {} } = {}) {
  const { inspectApplicationRepository } = await import("./application-model.js");
  const inspected = await inspectApplicationRepository({ projectDir: root, platform: "web" });
  let targets = inspected.model.targets.filter((item) => item.platform === "web");
  const requested = String(requestedTarget || "").trim();
  let requestedPath = "";
  if (requested) {
    try { requestedPath = fs.realpathSync(path.resolve(root, requested)); }
    catch { requestedPath = path.resolve(root, requested); }
  }
  if (requested && requestedPath !== root) {
    targets = targets.filter((item) => item.name === requested || item.id === requested || path.resolve(root, item.sourcePath) === requestedPath);
  }
  if (targets.length !== 1) return { error: targets.length ? "Multiple browser targets were detected; select one with --target <name-or-path>" : "No runnable browser target was detected", details: { targets: inspected.model.targets.map((item) => ({ id: item.id, name: item.name, sourcePath: item.sourcePath })) } };
  const target = targets[0];
  if (target.build.dependencyStatus === "missing-lockfile") return { error: `${target.name} cannot be built reproducibly because its dependency lockfile is missing`, details: { remediation: "Commit the lockfile or provide an already-running owned --url." } };
  const projectDir = path.resolve(root, target.build.projectDir || target.sourcePath || ".");
  const budgetMs = Math.max(30, Math.min(3600, Number(timeout) || 600)) * 1000;
  let install = null;
  if (target.build.install) {
    const spec = managedInstallSpec(target.build.install);
    if (!spec) return { error: `Unsupported deterministic install command: ${target.build.install}` };
    const installDir = path.resolve(root, target.build.installProjectDir || target.build.projectDir || ".");
    install = await runManagedBuildStep("Install browser dependencies", spec[0], spec[1], installDir, budgetMs, onStatus);
    if (install.error) return install;
  }
  let build = null;
  if (target.build.build) {
    build = await runManagedBuildStep("Build browser target", "npm", ["run", "build"], projectDir, budgetMs, onStatus);
    if (build.error) return build;
  }
  const startMatch = String(target.build.start || "").match(/^npm run ([A-Za-z0-9:_-]+)$/);
  const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8")); } catch { return {}; } })();
  const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const declaredPort = startMatch ? declaredPortFromStartScript(pkg.scripts?.[startMatch[1]]) : 0;
  const port = declaredPort || await openLocalPort();
  let command = "npm";
  let startArgs;
  let startDir = projectDir;
  if (startMatch) {
    startArgs = ["run", startMatch[1]];
    if (dependencies.vite) startArgs.push("--", "--host", "127.0.0.1", "--port", String(port));
    else if (dependencies.next) startArgs.push("--", "--hostname", "127.0.0.1", "--port", String(port));
  } else {
    const candidates = build ? ["dist", "build", "out"].map((name) => path.join(projectDir, name)) : [];
    startDir = candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) || projectDir;
    if (!fs.existsSync(path.join(startDir, "index.html"))) return { error: `${target.name} has no safely detected start script or static index`, details: { remediation: "Add a package start/dev/serve/preview script or provide an already-running owned --url." } };
    command = process.execPath;
    startArgs = [path.join(__dirname, "static-server.js"), startDir, String(port)];
  }
  const logDir = path.join(tappHome || os.tmpdir(), "init-runtime");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `web-${process.pid}-${Date.now()}.log`);
  const child = spawn(command, startArgs, {
    cwd: startDir,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", BROWSER: "none", CI: "1" },
    shell: false,
    detached: process.platform !== "win32",
  });
  const append = (chunk) => fs.appendFileSync(logPath, String(chunk));
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  onStatus(`Managed web runtime: ${command === process.execPath ? "Tapp static server" : `npm ${startArgs.join(" ")}`} → http://127.0.0.1:${port}`);
  const ready = await waitForOwnedUrl(`http://127.0.0.1:${port}`, child, Math.min(budgetMs, 60_000), logPath);
  if (ready.error) {
    await stopManagedWebTarget({ child, detached: process.platform !== "win32" });
    return ready;
  }
  return { child, detached: process.platform !== "win32", url: `http://127.0.0.1:${port}`, logPath, install, build, start: { command, args: startArgs, cwd: startDir } };
}

export async function stopManagedWebTarget(runtime) {
  const child = runtime?.child;
  if (!child) return;
  const signal = (value) => {
    try {
      if (runtime.detached && child.pid) process.kill(-child.pid, value);
      else if (child.exitCode === null) child.kill(value);
    } catch { /* already stopped */ }
  };
  const closed = new Promise((resolve) => child.once("close", resolve));
  signal("SIGTERM");
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3000))]);
  signal("SIGKILL");
}

export async function captureUiTree(bundleId) {
  const captureScript = path.join(scriptsDir, "quick-capture.sh");
  const before = new Set(listCaptureRuns(50).map((r) => r.id));
  const result = await runCommand("bash", [captureScript, "tree", bundleId], {
    cwd: repoRoot,
    timeoutMs: 5 * 60 * 1000,
  });
  const created = listCaptureRuns(50).find((r) => !before.has(r.id));
  if (!created) return { error: "UI tree produced no capture", details: { stderr: result.stderr } };

  const treePath = path.join(created.path, "uitree.json");
  if (!fs.existsSync(treePath) || fs.statSync(treePath).size === 0) {
    return {
      error: "No accessibility tree was produced (is the app installed + foregrounded?)",
      details: { capture: { id: created.id, relativePath: created.relativePath }, stderr: result.stderr },
    };
  }
  let tree;
  try {
    tree = JSON.parse(fs.readFileSync(treePath, "utf8"));
  } catch {
    return { error: "uitree.json was not valid JSON", details: { treePath } };
  }
  return { screenTitle: tree.screenTitle ?? null, elements: tree.elements || [], capture: { id: created.id, relativePath: created.relativePath } };
}

const pkgVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const server = new Server(
  {
    name: "tapp",
    version: pkgVersion,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "tapp_health",
      title: "Check Tapp readiness",
      description: "Check Tapp workspace and toolchain availability",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "tapp_build",
      title: "Build the iOS app",
      description:
        "Build the user's iOS app for the simulator from an Xcode project/workspace (auto-detects the " +
        "container and scheme under projectDir, default cwd), install it on the booted simulator, and " +
        "return the bundle id. Use before tapp_run_qa / tapp_open_app when the app isn't installed yet — " +
        "no bundle id needed up front.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: {
            type: "string",
            description: "Required when TAPP_MCP_TOKEN is set",
          },
          projectDir: { type: "string", description: "Repo/dir to search for the .xcworkspace/.xcodeproj (default: cwd)" },
          scheme: { type: "string", description: "Scheme to build (default: auto-detected)" },
          configuration: { type: "string", default: "Debug" },
          install: { type: "boolean", default: true, description: "Install on the booted simulator after building" },
        },
      },
    },
    {
      name: "tapp_capture",
      title: "Headless capture",
      description: "Run headless capture workflows using scripts/quick-capture.sh",
      inputSchema: {
        type: "object",
        properties: {
          authToken: {
            type: "string",
            description: "Required when TAPP_MCP_TOKEN is set",
          },
          mode: {
            type: "string",
            enum: ["screenshot", "record", "explore", "tree"],
            description: "Capture mode",
          },
          appBundleId: {
            type: "string",
            description: "Bundle ID (required for explore/tree)",
          },
          actions: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
            description: "Action limit for explore",
          },
          duration: {
            type: "integer",
            minimum: 1,
            maximum: 3600,
            description: "Record duration in seconds",
          },
          testEmail: {
            type: "string",
            description: "Optional OCQA_TEST_EMAIL override",
          },
          testPassword: {
            type: "string",
            description: "Optional OCQA_TEST_PASSWORD override",
          },
          inputOverrides: {
            type: "object",
            description:
              "Deterministic field values typed during explore. Map of field key -> value. " +
              "Keys: 'id:<identifier>', 'label:<label>', or scoped 'screen:<title>|id:<identifier>'. " +
              "Example: {\"id:email_field\": \"user@example.com\", \"id:zip\": \"90210\"}. " +
              "Values replace the default 'test' input and are typed exactly as given on every run.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["mode"],
      },
    },
    {
      name: "tapp_parse_markers",
      title: "Parse capture markers",
      description: "Parse OCQA markers from a capture run into structured summary",
      inputSchema: {
        type: "object",
        properties: {
          runId: {
            type: "string",
            description: "Capture run directory name under captures/",
          },
          runPath: {
            type: "string",
            description: "Absolute capture path override (must remain under captures/)",
          },
        },
      },
    },
    {
      name: "tapp_list_captures",
      title: "List captures",
      description: "List recent capture runs from captures/",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 10,
          },
        },
      },
    },
    {
      name: "tapp_capture_summary",
      title: "Capture summary",
      description: "Show summary metadata for a capture run",
      inputSchema: {
        type: "object",
        properties: {
          runId: {
            type: "string",
            description: "Capture run directory name under captures/",
          },
          runPath: {
            type: "string",
            description: "Absolute capture path override",
          },
        },
      },
    },
    {
      name: "tapp_run_qa",
      title: "Run autonomous QA",
      description:
        "Run autonomous QA against iOS (appBundleId), Android (androidAppId), OR a web app " +
        "(url — beta, requires Playwright installed) and return a structured " +
        "QA verdict. Use ONLY when the user wants a QA assessment / to find bugs / a verdict — this " +
        "runs for MINUTES exploring the whole app. Do NOT use it just to view, screenshot, or reach a specific " +
        "screen — use tapp_open_app (launch + screenshot) or a session for that. Tapp explores the app " +
        "like a tester (taps, types, navigates, scrolls) and detects real issues — crashes, dead buttons, failed sign-ins, error screens, " +
        "stuck/hung screens; on web also uncaught JS exceptions, failed/5xx requests, broken links and assets. " +
        "Returns {verdict: ready|caution|blocked, confidence, releaseScore, headline, screensExplored, " +
        "actionsPerformed, findings:[{type,severity,category,title,screen,evaluationTier}]}. Exploratory web " +
        "sets confidence/releaseScore to null and separates deterministic verdict findings from advisory " +
        "sampled control probes. The verdict has a coverage floor: " +
        "if the app barely explored (crash on launch / sign-in wall) it returns 'caution' + inconclusive, never a " +
        "false pass. For iOS the app must already be installed on a booted simulator (use tapp_list_simulators / " +
        "tapp_boot_simulator first). For web, only point it at an app/environment you own — it CLICKS things. " +
        "Tapp explores autonomously and does NOT pause to prompt for input — " +
        "it fills forms with safe defaults. The result includes `inputFieldsEncountered` (and `inputHint`): if " +
        "the app showed login/form fields and the user hasn't given you values, ASK THE USER what to enter (offer " +
        "to use defaults or skip), then re-run with testEmail/testPassword or inputOverrides for a real result.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          appBundleId: { type: "string", description: "iOS: bundle id of the installed app to test, e.g. com.acme.app. Provide exactly one of appBundleId | url." },
          androidAppId: { type: "string", description: "Android: application id installed on a connected emulator/device, e.g. com.acme.app." },
          apkPath: { type: "string", description: "Android: optional APK to install before testing." },
          androidSerial: { type: "string", description: "Android: optional adb device serial; defaults to the first authorized device." },
          clearData: { type: "boolean", default: true, description: "Android: clear app data before launch for a repeatable starting state." },
          url: { type: "string", description: "Web (beta): URL of the app to explore in a real browser (same-origin only; your own app/staging). Provide exactly one of appBundleId | url." },
          maxActions: { type: "integer", minimum: 1, maximum: 1000, default: 60, description: "Exploration action budget" },
          timeout: { type: "integer", minimum: 30, maximum: 3600, default: 600, description: "Max wall-clock seconds" },
          testEmail: { type: "string", description: "Email for the login preamble, if the app has a sign-in" },
          testPassword: { type: "string", description: "Password for the login preamble" },
          interactive: { type: "boolean", description: "Host-with-a-human only (e.g. the VS Code extension): pause at input screens and wait for values via interactiveResponsePath. Plain agents: omit." },
          interactiveResponsePath: { type: "string", description: "File path the prompting host answers on (requests appear at <path>.request)" },
          inputOverrides: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "Deterministic field values typed during exploration. Map of field key -> value; keys are " +
              "'id:<identifier>', 'label:<label>', or scoped 'screen:<title>|id:<identifier>'. " +
              "Example: {\"id:email_field\": \"user@example.com\"}.",
          },
          appLaunchArgs: {
            type: "array",
            items: { type: "string" },
            description: "Launch arguments passed to the app, e.g. [\"--uitesting\"] to enable a login bypass.",
          },
          appLaunchEnv: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Launch environment for the app, e.g. {\"UI_TEST_BACKEND\": \"staging\"} to point it at a test backend.",
          },
          loginSteps: {
            type: "array",
            items: {},
            description:
              "Explicit login replay run BEFORE exploration, for custom login UIs the heuristic can't " +
              "parse (the #1 reason a real app stays invisible). Each step is {action:'type'|'tap'|'wait', " +
              "target:'<accessibility-id-or-label>', value?:'<text>', timeoutMs?:<for wait>} — or a shorthand " +
              "string 'action:target[:value]'. $TEST_EMAIL/$TEST_PASSWORD are substituted from testEmail/" +
              "testPassword. Example: [{\"action\":\"type\",\"target\":\"email_field\",\"value\":\"$TEST_EMAIL\"}," +
              "{\"action\":\"type\",\"target\":\"password_field\",\"value\":\"$TEST_PASSWORD\"},{\"action\":\"tap\",\"target\":\"sign_in_button\"}].",
          },
          baselineFindings: {
            type: "array",
            items: { type: "object" },
            description:
              "Findings from a previous run (pass back the `findings` array a prior tapp_run_qa returned). " +
              "When provided, the result adds `regression` {counts:{new,persisting,resolved}, newFindings, resolved, " +
              "gate:{newHigh,newCritical,failed}} comparing this run to that baseline. For a CI gate: store the " +
              "baseline once, then fail the build when regression.gate.failed is true (new high/critical introduced).",
          },
        },
      },
    },
    {
      name: "tapp_init",
      title: "Inspect or explore a repository and create the Tapp application model and release plan",
      description:
        "Deterministically inspect repository targets, reviewed Tasks/contracts, actors, capabilities, entities, requirements, and the persistent UI Map. Returns an evidence-classified application model plus a compact grounded release-contract plan. `inspect` is read-only; `write` creates artifacts without overwriting; `refresh` updates source evidence; `explore` safely builds/starts a detected web target when url is omitted (or resolves native targets), runs the ordinary real-surface QA engine, tears managed runtimes down, merges its observed UI Map, then refreshes the model/plan while preserving explicit decisions and invalidating stale replay trust. Execution is deterministic/keyless and does not invoke AI unless remote AI was separately and explicitly enabled.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          operation: { type: "string", enum: ["inspect", "write", "refresh", "explore"], default: "inspect" },
          projectDir: { type: "string", description: "Repo-relative project root; defaults to the MCP workspace root" },
          platform: { type: "string", enum: ["ios", "android", "web"], description: "Optional target filter" },
          url: { type: "string", description: "Owned web runtime URL when already running; omit during web explore to build/start one safely detected target" },
          target: { type: "string", description: "Explore target selector: web target name/path, or iOS repo directory, Xcode container, .app, or bundle id; defaults to projectDir" },
          appBundleId: { type: "string", description: "iOS explore: already-installed bundle id, avoiding a build" },
          androidAppId: { type: "string", description: "Android explore: required application id" },
          apkPath: { type: "string", description: "Android explore: optional repo-relative APK to install" },
          androidSerial: { type: "string", description: "Android explore: optional adb device serial" },
          maxActions: { type: "integer", minimum: 1, maximum: 1000, default: 40 },
          timeout: { type: "integer", minimum: 30, maximum: 3600, default: 600 },
          testEmail: { type: "string", description: "Explore: actor/login email; never persisted in the model" },
          testPassword: { type: "string", description: "Explore: actor/login password; never persisted in the model" },
          maxContracts: { type: "integer", minimum: 1, maximum: 50, default: 15 },
          outDir: { type: "string", description: "Repo-relative artifact directory; default .tapp" },
        },
      },
    },
    {
      name: "tapp_actor_config",
      title: "Inspect or configure named test actors without storing credential values",
      description:
        "Manage the repository-native .tapp/project.json actor/session contract used by init, release-contract generation, and CI. `read` is inspect-only. `set` writes an explicit actor role, isolation/provisioning policy, and credential-name to environment-variable-name bindings. The tool never accepts, returns, or persists credential values and never overwrites an actor unless replace is explicit.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          operation: { type: "string", enum: ["read", "set"], default: "read" },
          projectDir: { type: "string", description: "Repo-relative project root; defaults to the MCP workspace root" },
          name: { type: "string", description: "Set: stable actor name" },
          role: { type: "string", description: "Set: product role, such as member or admin" },
          session: { type: "string", enum: ["default", "isolated"], default: "default" },
          provisioning: { type: "string", enum: ["existing", "seeded", "api", "unknown"], default: "existing" },
          credentialBindings: { type: "object", additionalProperties: { type: "string", pattern: "^[A-Z_][A-Z0-9_]{0,127}$" }, description: "Set: credential names mapped to environment-variable names, for example {email:'ALICE_EMAIL'}; values/secrets are forbidden" },
          replace: { type: "boolean", default: false, description: "Explicitly replace an existing actor's non-secret configuration" },
        },
      },
    },
    {
      name: "tapp_release_plan",
      title: "Inspect or explicitly review a Tapp release plan",
      description:
        "Read the repository-native release plan, apply explicit approve/reject/defer decisions, generate grounded Task/contract drafts, deterministically validate drafts on a real target, or explicitly promote fully replay-validated drafts into reviewed repository-native artifacts. Review changes only decision metadata. Generation writes under .tapp/proposals, never overwrites, never invokes AI, and remains untrusted until real deterministic replay passes. Web validation can build/start/stop the detected managed target when url is omitted.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          operation: { type: "string", enum: ["read", "review", "generate", "validate", "promote"], default: "read" },
          planPath: { type: "string", description: "Repo-relative plan path; default .tapp/release-plan.json" },
          projectDir: { type: "string", description: "Generate: repo-relative project root containing the scoped .tapp Task directories" },
          approve: { type: "array", items: { type: "string" }, description: "Plan item ids or names to approve" },
          reject: { type: "array", items: { type: "string" }, description: "Plan item ids or names to reject" },
          defer: { type: "array", items: { type: "string" }, description: "Plan item ids or names to defer" },
          items: { type: "array", items: { type: "string" }, description: "Validate/promote only these plan item ids or names; defaults to every matching draft" },
          platform: { type: "string", enum: ["ios", "android", "web"], description: "Validate: target platform; inferred when all selected drafts use one platform" },
          url: { type: "string", description: "Validate web: already-running owned URL; omit to use Tapp's managed target lifecycle" },
          target: { type: "string", description: "Validate managed web: target id, name, or source path when the repository has multiple browser targets" },
          appBundleId: { type: "string", description: "Validate iOS: installed application bundle id" },
          androidAppId: { type: "string", description: "Validate Android: installed application id" },
          apkPath: { type: "string", description: "Validate Android: optional repo-relative APK" },
          androidSerial: { type: "string", description: "Validate Android: optional adb serial" },
          timeout: { type: "integer", minimum: 30, maximum: 3600, default: 600 },
        },
      },
    },
    {
      name: "tapp_ci_setup",
      title: "Create a target-scoped baseline or reviewable CI installation",
      description:
        "Complete the local release-contract onboarding loop from the shared application model. `inspect` renders a target-aware GitHub workflow and machine-readable CI manifest without writing; `install` writes both with collision protection; `baseline` imports an existing successful conclusive portable-gate report into a platform/target-specific repository baseline. No network resources, commits, pushes, branch protection, or AI are used.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          operation: { type: "string", enum: ["inspect", "install", "baseline"], default: "inspect" },
          projectDir: { type: "string", description: "Repo-relative project root; defaults to the MCP workspace root" },
          modelPath: { type: "string", description: "Repo-relative application model path; defaults to <projectDir>/.tapp/application-model.json" },
          actionRef: { type: "string", description: "GitHub Action reference owner/repository@release-tag-or-sha; defaults to the current Tapp release tag" },
          defaultBranch: { type: "string", default: "main" },
          workflowPath: { type: "string", description: "Install: project-relative output; default .github/workflows/tapp.yml" },
          manifestPath: { type: "string", description: "Install: project-relative output; default .tapp/ci.json" },
          allowUnresolved: { type: "boolean", default: false, description: "Permit writing a draft whose manifest names unresolved target configuration" },
          replace: { type: "boolean", default: false, description: "Explicitly replace an existing generated workflow/manifest or target baseline" },
          reportPath: { type: "string", description: "Baseline: repo-relative successful conclusive portable-gate JSON report" },
          platform: { type: "string", enum: ["ios", "android", "web"], description: "Baseline: select a target platform" },
          target: { type: "string", description: "Baseline: application-model target id, name, or source path" },
          baselinePath: { type: "string", description: "Baseline: optional project-relative target baseline output" },
        },
      },
    },
    {
      name: "tapp_ui_map",
      title: "Build, inspect, or diff the Tapp UI Map",
      description:
        "Use Tapp's first-class platform-neutral UI Map: evidence-grounded screen states, semantic controls, transitions, platform variants, provenance, and task/contract coverage hooks. " +
        "QA runs create capture-local ui-map.json automatically. `read` returns one; `build` deterministically builds/merges a repository map from OCQA evidence; `diff` reports additions and absences without calling shallow-run absence a regression unless comparableFullSweep is explicitly true. No AI is used.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          operation: { type: "string", enum: ["read", "build", "diff"], default: "read" },
          captureId: { type: "string", description: "Read/build from this Tapp capture's ocqa-markers.txt/ui-map.json" },
          mapPath: { type: "string", description: "Repo-relative UI Map path for read, or build output (default .tapp/ui-map.json)" },
          markersPath: { type: "string", description: "Repo-relative OCQA markers path for build when captureId is not supplied" },
          beforePath: { type: "string", description: "Repo-relative baseline UI Map for diff" },
          afterPath: { type: "string", description: "Repo-relative current UI Map for diff" },
          platform: { type: "string", enum: ["ios", "android", "web"], default: "ios" },
          target: { type: "string", description: "Bundle id, Android app id, or owned URL recorded as map provenance" },
          replace: { type: "boolean", default: false, description: "Build: replace rather than merge existing repository map" },
          comparableFullSweep: { type: "boolean", default: false, description: "Diff: only enable when both runs had comparable target/config/action budget; permits lost-reachability classification" },
        },
      },
    },
    {
      name: "tapp_task",
      title: "Inspect, validate, or compile a reusable deterministic Task",
      description:
        "Work with repository-native compositional Tasks in .tapp/tasks. Tasks define inputs, outputs, pre/postconditions, platform implementations, and the UI Map states/transitions they cover. " +
        "Validation is deterministic and can ground selectors/coverage against ui-map.json. Compilation expands a Task into the shared keyless Flow contract with reviewable Task provenance; pass that returned flow to tapp_flow_run to replay it. No AI or API key is used.",
      inputSchema: {
        type: "object",
        required: ["taskPath"],
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          operation: { type: "string", enum: ["read", "validate", "compile"], default: "validate" },
          taskPath: { type: "string", description: "Repo-relative .tapp/tasks/*.yml|json file" },
          platform: { type: "string", enum: ["ios", "android", "web"], description: "Implementation to validate/compile" },
          inputs: { type: "object", additionalProperties: { type: "string" }, description: "Task inputs for compile. Secret inputs must be environment placeholders such as $TEST_PASSWORD, never plaintext." },
          mapPath: { type: "string", description: "Optional repo-relative UI Map v1 used to ground states, edges, and semantic controls" },
          updateMap: { type: "boolean", default: false, description: "Explicitly add the validated Task's coverage references to mapPath" },
          outPath: { type: "string", description: "Compile: optional repo-relative JSON output; omitted returns the compiled Flow without writing" },
        },
      },
    },
    {
      name: "tapp_release_contract",
      title: "Inspect, validate, compile, or run a release contract",
      description:
        "Work with repository-native TypeScript release contracts in .tapp/contracts. Contracts express business guarantees through reusable Tasks, named actors, exact/eventual expectations, criticality, policy, and UI Map coverage. " +
        "Compilation targets the same deterministic Flow/Scenario evidence contract; ordinary run is keyless and never invokes a model. Multi-actor isolated replay is currently web-only.",
      inputSchema: {
        type: "object",
        required: ["contractPath"],
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          operation: { type: "string", enum: ["read", "validate", "compile", "run"], default: "validate" },
          contractPath: { type: "string", description: "Repo-relative .tapp/contracts/*.contract.ts file" },
          platform: { type: "string", enum: ["ios", "android", "web"], description: "Target platform; optional when the contract declares exactly one" },
          mapPath: { type: "string", description: "Optional repo-relative UI Map v1 for coverage grounding" },
          updateMap: { type: "boolean", default: false, description: "Explicitly add the reviewed contract coverage to mapPath" },
          outPath: { type: "string", description: "Compile: optional repo-relative deterministic JSON output" },
          url: { type: "string", description: "Run: web target URL override" },
          appBundleId: { type: "string", description: "Run: iOS bundle id override" },
          androidAppId: { type: "string", description: "Run: Android application id override" },
          apkPath: { type: "string", description: "Run: optional Android APK" },
          androidSerial: { type: "string", description: "Run: optional adb serial" },
        },
      },
    },
    {
      name: "tapp_pr_plan",
      title: "Plan PR coverage or explicitly adopt an observed coverage proposal",
      description:
        "Plan builds a deterministic reviewable PR plan from changed files, reviewed ownership, exact observed static-route evidence, UI Map coverage, reusable Tasks, and contract policy. It also emits bounded exploration targets for changed weakly covered UI states. Adopt is an explicit write: it appends one conclusively observed, review-only coverage proposal to the repository release plan, but generates or trusts nothing. No AI runs; plan is read-only and adopt never rewrites existing items.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          operation: { type: "string", enum: ["plan", "adopt"], default: "plan" },
          changedFiles: {
            type: "array", minItems: 1,
            items: {
              anyOf: [
                { type: "string" },
                {
                  type: "object", required: ["filename"], additionalProperties: false,
                  properties: {
                    filename: { type: "string" },
                    previous_filename: { type: "string" },
                    patch: { type: "string", description: "Optional bounded unified patch from the PR provider; consumed locally and never copied into the plan" },
                  },
                },
              ],
            },
            description: "Repository-relative PR paths or provider change objects with optional bounded patch evidence for reviewed symbol ownership",
          },
          projectDir: { type: "string", description: "Repo-relative project root; defaults to the MCP workspace root" },
          platform: { type: "string", enum: ["ios", "android", "web"], description: "Optional platform filter" },
          mapPath: { type: "string", description: "Project-relative UI Map; defaults to .tapp/ui-map.json" },
          prPlanPath: { type: "string", description: "Adopt: project-relative executed PR plan containing conclusive exploration evidence" },
          item: { type: "string", description: "Adopt: stable exploration target id whose reviewable proposal should be appended" },
          releasePlanPath: { type: "string", description: "Adopt: project-relative target; defaults to .tapp/release-plan.json" },
        },
      },
    },
    {
      name: "tapp_flow_run",
      title: "Run a deterministic E2E flow",
      description:
        "Replay a deterministic, authored end-to-end test (a Flow) against iOS (XCUITest), Android " +
        "(ADB/UIAutomator), or web (Playwright), and return a scannable pass/fail report. A Flow is a list of steps + assertions " +
        "(see docs/flows-architecture.md). Unlike tapp_run_qa (autonomous exploration), a Flow does EXACTLY " +
        "what you specify, the same way every time — use it for regression tests and verifying a fix. Steps: " +
        "{tap: X} · {type: {field: F, value: V}} · {swipe: up} · {back} · {wait_for: SCREEN}. Assertions " +
        "(deterministic): {assert_screen: X} · {assert_exists: X} · {assert_absent: X} · {assert_text: {of, contains}}. " +
        "Opt-in AI assertion: {assert_ai: '<claim about the current screen>'} (judged host-side; needs a key; " +
        "skipped otherwise). Pass a flow inline via `flow`, or a repo-relative `flowPath` to a .yml/.json. " +
        "A failed assertion fails the flow and is reported like a QA finding. $TEST_EMAIL/$TEST_PASSWORD and any " +
        "flow `vars` are substituted; pass testEmail/testPassword for real credential values.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          flow: {
            type: "object",
            description:
              "Inline Flow: {name, app, steps:[...], vars?}. Example: {name:'login', app:'com.acme.app', steps:[{tap:'Sign In'}, {type:{field:'Email', value:'$TEST_EMAIL'}}, {tap:'Continue'}, {assert_screen:'Home'}]}",
          },
          flowPath: { type: "string", description: "Alternative to `flow`: repo-relative path to a .yml/.json Flow (e.g. .tapp/flows/login.yml)" },
          platform: { type: "string", enum: ["ios", "web", "android"], description: "Overrides Flow platform detection" },
          appBundleId: { type: "string", description: "iOS: overrides the Flow's `app:` field" },
          androidAppId: { type: "string", description: "Android: overrides the Flow's `app:` field" },
          url: { type: "string", description: "Web start URL. Overrides the Flow's `url:` field." },
          apkPath: { type: "string", description: "Android APK to install before replay." },
          androidSerial: { type: "string", description: "Android adb device serial." },
          testEmail: { type: "string", description: "Value for $TEST_EMAIL" },
          testPassword: { type: "string", description: "Value for $TEST_PASSWORD" },
        },
      },
    },
    {
      name: "tapp_scenario_run",
      title: "Run a deterministic multi-actor Scenario",
      description:
        "Replay a repository-native system test whose named actors run in isolated browser contexts against shared application state. " +
        "Scenarios use the same deterministic Flow actions/assertions plus explicit actors, shared variables, setup/teardown requests, " +
        "and polling timeouts for eventual consistency. No model or API key is used during replay. Every result is tagged with its actor. " +
        "Web actor isolation is implemented now; iOS and Android multi-actor replay is reported as unsupported rather than simulated.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          scenario: { type: "object", description: "Inline Scenario with {kind:'scenario', platform:'web', actors, steps, setup?, teardown?}" },
          scenarioPath: { type: "string", description: "Repo-relative path to a .yml/.json Scenario" },
          url: { type: "string", description: "Override the Scenario's web URL" },
          variables: { type: "object", additionalProperties: { type: "string" }, description: "Explicit non-secret/shared variable overrides. Actor secrets may also be referenced by environment variable name in committed Scenario vars." },
        },
      },
    },
    {
      name: "tapp_flow_generate",
      title: "Generate a Flow from a goal (AI)",
      description:
        "Write a deterministic E2E Flow from a natural-language goal (e.g. 'sign in and open Settings'), " +
        "GROUNDED in the app's real screens so it can't invent steps. Tapp explores the app to build a " +
        "screen/control map (or reuses a recent run via captureId), then a model authors a Flow using only " +
        "screens/controls that were actually observed. Saves it to .tapp/flows/<name>.yml and returns the " +
        "YAML for review (optionally runs it). Needs a model backend (Tapp subscription token or " +
        "ANTHROPIC_API_KEY). Use this to bootstrap a test you then refine; use tapp_flow_run to replay it.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          goal: { type: "string", description: "What the test should do, in plain English (e.g. 'sign in with test creds and reach the dashboard')" },
          appBundleId: { type: "string", description: "Bundle id of the installed app to author against" },
          captureId: { type: "string", description: "Reuse this capture's grounding instead of exploring (from a prior run_qa, faster)" },
          maxActions: { type: "integer", minimum: 5, maximum: 200, default: 35, description: "Exploration budget when building grounding" },
          run: { type: "boolean", default: false, description: "Also replay the generated flow and include the pass/fail result" },
          testEmail: { type: "string" },
          testPassword: { type: "string" },
        },
        required: ["goal", "appBundleId"],
      },
    },
    {
      name: "tapp_flow_save",
      title: "Save the session as a Flow",
      description:
        "Save what you've done in the CURRENT interactive session as a reusable, deterministic Flow " +
        "(record-by-doing). Every successful tapp_session_act (tap/type/swipe/back) is recorded; this " +
        "writes them to .tapp/flows/<name>.yml with wait_for steps auto-inserted on screen changes and a " +
        "final assert_screen checkpoint. Typed credentials are templated to $TEST_EMAIL/$TEST_PASSWORD so the " +
        "flow is shareable. The saved flow replays with tapp_flow_run. Do it once → it's a test.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          name: { type: "string", description: "Human name for the flow, e.g. 'Sign in and reach Home'" },
          addFinalAssertion: { type: "boolean", default: true, description: "Append assert_screen for the final screen as a checkpoint" },
          replace: { type: "boolean", default: false, description: "Explicitly replace a Flow with the same generated filename. Existing Flows are preserved by default." },
        },
        required: ["name"],
      },
    },
    {
      name: "tapp_ui_tree",
      title: "Inspect screen (a11y tree)",
      description:
        "Dump the accessibility (UI) tree of the current screen of an installed iOS or Android app — " +
        "the inspection primitive (like Playwright's snapshot). Returns {screenTitle, elements:[{type,id,label," +
        "enabled,hittable,x,y,w,h}]}. Use it to see what's on screen before/after acting.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          appBundleId: { type: "string", description: "iOS bundle id of the installed app" },
          androidAppId: { type: "string", description: "Android application id of the installed app" },
          androidSerial: { type: "string", description: "Android adb device serial" },
        },
      },
    },
    {
      name: "tapp_screenshot",
      title: "Screenshot current screen",
      description:
        "Return an inline image of whatever is CURRENTLY on the booted simulator. It does NOT launch or " +
        "navigate the app — it just photographs the current screen (use it during a session, or after " +
        "tapp_open_app). To launch an app and screenshot the screen it opens on, use tapp_open_app instead.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          maxWidth: { type: "integer", minimum: 200, maximum: 1400, default: 700, description: "Max image width in px (downscaled to keep payload small)" },
        },
      },
    },
    {
      name: "tapp_open_app",
      title: "Launch app + screenshot",
      description:
        "Launch an installed iOS or Android app and return a SCREENSHOT of the screen it lands on " +
        "(plus the accessibility tree) — with NO exploration. This is the fast way (seconds) to just SEE a " +
        "screen. Use this — NOT tapp_run_qa — whenever the user wants to view or screenshot a screen. Pass " +
        "appLaunchArgs like [\"--uitesting\"] to bypass login and land on the home screen, and appLaunchEnv for " +
        "a backend override. The app is launched fresh and closed afterward. (To screenshot a screen reached by " +
        "real login or several taps, use a session instead and call tapp_screenshot along the way.)",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          appBundleId: { type: "string", description: "iOS bundle id of the installed app" },
          androidAppId: { type: "string", description: "Android application id of the installed app" },
          apkPath: { type: "string", description: "Android APK to install before launch" },
          androidSerial: { type: "string", description: "Android adb device serial" },
          clearData: { type: "boolean", default: false, description: "Android: clear app data before launch" },
          appLaunchArgs: { type: "array", items: { type: "string" }, description: "Launch args, e.g. [\"--uitesting\"] to bypass login" },
          appLaunchEnv: { type: "object", additionalProperties: { type: "string" }, description: "Launch env, e.g. {\"UI_TEST_BACKEND\": \"staging\"}" },
          maxWidth: { type: "integer", minimum: 200, maximum: 1400, default: 700, description: "Max screenshot width in px" },
        },
      },
    },
    {
      name: "tapp_list_simulators",
      title: "List simulators",
      description: "List available iOS simulators (name, udid, state, runtime, booted) so you can pick or boot one before running QA.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "tapp_boot_simulator",
      title: "Boot simulator",
      description: "Boot an iOS simulator by udid (preferred) or name so Tapp can run against it. No-op if already booted.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          udid: { type: "string", description: "Simulator UDID (from tapp_list_simulators)" },
          name: { type: "string", description: "Simulator name, e.g. 'iPhone 16 Pro' (used if udid omitted)" },
        },
      },
    },
    {
      name: "tapp_install_app",
      title: "Install app on sim",
      description:
        "Build a target iOS app for the booted simulator and install it, so it's ready for tapp_run_qa or " +
        "a session. Provide the Xcode project OR workspace path + scheme. Best-effort — apps with CocoaPods/" +
        "signing quirks may still need their normal build. Returns {ok, installed, simulator}.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          project: { type: "string", description: "Absolute path to .xcodeproj (use this OR workspace)" },
          workspace: { type: "string", description: "Absolute path to .xcworkspace (use this OR project)" },
          scheme: { type: "string", description: "Scheme to build" },
          configuration: { type: "string", default: "Debug", description: "Build configuration (default Debug)" },
          cleanInstall: { type: "boolean", default: true, description: "Uninstall the app first (clears data + keychain session; avoids Firebase keychain errors). Set false to install over the existing app." },
        },
        required: ["scheme"],
      },
    },
    {
      name: "tapp_session_start",
      title: "Start interactive session",
      description:
        "Start a PERSISTENT interactive session against an installed iOS or Android app. The app " +
        "launches once and stays up, so you can drive a Playwright-style tap → inspect loop without a cold " +
        "launch per action. Returns the initial screen {screenTitle, elements[]}. Drive it with " +
        "tapp_session_act and finish with tapp_session_end. Only one session at a time. Starts from a " +
        "fresh launch. Use appLaunchArgs/appLaunchEnv for apps that need a backend override or login bypass. " +
        "When you reach a screen with input fields and don't have values for them, ASK THE USER what to type " +
        "(offer defaults/skip) before typing — the session does not prompt on its own.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          appBundleId: { type: "string", description: "Bundle id of the installed app to drive" },
          androidAppId: { type: "string", description: "Android application id to drive (alternative to appBundleId)" },
          apkPath: { type: "string", description: "Android APK to install before starting" },
          androidSerial: { type: "string", description: "Android adb device serial" },
          clearData: { type: "boolean", default: true, description: "Android: clear app data before launch" },
          testEmail: { type: "string", description: "Email available to the app/harness, if it has a sign-in" },
          testPassword: { type: "string", description: "Password available to the app/harness" },
          appLaunchArgs: { type: "array", items: { type: "string" }, description: "Launch arguments, e.g. [\"--uitesting\"]" },
          appLaunchEnv: { type: "object", additionalProperties: { type: "string" }, description: "Launch environment, e.g. {\"UI_TEST_BACKEND\": \"staging\"}" },
        },
      },
    },
    {
      name: "tapp_session_act",
      title: "Session: tap/type/inspect",
      description:
        "Perform ONE action in the active interactive session and get the resulting screen back (the fresh " +
        "accessibility tree). Actions: 'login' (`email` + `password` — fills the login form, submits, and " +
        "verifies IN ONE CALL; always prefer this over manual type/tap for sign-in: iOS wipes secure fields " +
        "on refocus, so step-by-step login flows lose the password), 'tap' (by `id` = accessibility identifier " +
        "or visible/partial label or placeholder, or by `x`/`y` coordinates), 'type' (`text`, optional `id` to " +
        "target a field — always REPLACES the field's content), 'swipe' (`direction`), 'back', 'wait' (block " +
        "until an element with `id`/`text` appears, up to `timeoutMs`), 'tree' (re-inspect without acting), " +
        "'screenshot'. Returns {status, screenTitle, elements[]}; status 'not_found'/'timeout'/'still_on_login' " +
        "etc. with a `detail` explaining login failures.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" },
          action: { type: "string", enum: ["login", "tap", "type", "swipe", "back", "wait", "tree", "screenshot"] },
          email: { type: "string", description: "login: email/username to sign in with" },
          password: { type: "string", description: "login: password to sign in with" },
          id: { type: "string", description: "Element accessibility id or visible/partial label (for tap/type/wait)" },
          x: { type: "number", description: "Tap X coordinate (points), if not using id" },
          y: { type: "number", description: "Tap Y coordinate (points), if not using id" },
          text: { type: "string", description: "Text to type, or the label/text to wait for" },
          direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Swipe direction" },
          timeoutMs: { type: "integer", minimum: 500, maximum: 60000, default: 5000, description: "For 'wait': how long to poll for the element" },
          label: { type: "string", description: "Optional screenshot label" },
        },
        required: ["action"],
      },
    },
    {
      name: "tapp_session_end",
      title: "End session",
      description: "End the active interactive session (quits the app + harness). Always call this when done.",
      inputSchema: {
        type: "object",
        properties: { authToken: { type: "string", description: "Required when TAPP_MCP_TOKEN is set" } },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === "tapp_health") {
    const checks = [];

    checks.push({
      check: "repoRoot",
      ok: fs.existsSync(path.join(repoRoot, "Tapp.xcodeproj")),
      value: repoRoot,
    });

    const nodeVersion = await runCommand("node", ["-v"]);
    checks.push({
      check: "node",
      ok: nodeVersion.code === 0,
      value: nodeVersion.stdout.trim() || nodeVersion.stderr.trim(),
    });

    const xcodebuildVersion = await runCommand("xcodebuild", ["-version"]);
    checks.push({
      check: "xcodebuild",
      ok: xcodebuildVersion.code === 0,
      value: (xcodebuildVersion.stdout || xcodebuildVersion.stderr).trim().split("\n")[0] || "not found",
    });

    const simctl = await runCommand("xcrun", ["simctl", "list", "devices", "booted"]);
    checks.push({
      check: "bootedSimulator",
      ok: simctl.code === 0,
      value: (simctl.stdout || simctl.stderr).trim(),
    });

    const allOk = checks.every((c) => c.ok);
    const bootedLine = (simctl.stdout || "").split("\n").find((l) => /\(Booted\)/.test(l));
    const bootedName = bootedLine ? bootedLine.trim().replace(/\s*\(.*$/, "") : null;
    const L = [`### ${allOk ? "🩺 Tapp ready" : "⚠️ Tapp not fully ready"}`, ""];
    for (const c of checks) {
      L.push(`- ${c.ok ? "✅" : "❌"} **${c.check}** — ${String(c.value).split("\n")[0] || "—"}`);
    }
    L.push("");
    L.push(bootedName ? `📱 Simulator booted: **${bootedName}**` : "📱 No simulator booted — run `tapp_boot_simulator` first.");
    return richResult(L.join("\n"), { ok: allOk, checks });
  }

  if (name === "tapp_build") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;

    const dir = isNonEmptyString(args.projectDir) ? path.resolve(args.projectDir.trim()) : process.cwd();
    const startedAt = Date.now();
    const built = await buildAppForSim({ dir, scheme: args.scheme, configuration: isNonEmptyString(args.configuration) ? args.configuration.trim() : "Debug" });
    if (built.error) return errorResult(built.error, built.details || {});
    let bundleId;
    if (args.install !== false) {
      const sim = await ensureBootedSim({ autoBoot: true });
      if (sim.error) return errorResult(sim.error);
      const inst = await installAppOnBootedSim(built.appPath);
      if (inst.error) return errorResult(inst.error);
      bundleId = inst.bundleId;
    }
    const text =
      `🔨 Built **${path.basename(built.appPath)}** (scheme \`${built.scheme}\`) in ${fmtDuration(Date.now() - startedAt)}` +
      (bundleId ? ` — installed on the simulator as \`${bundleId}\`` : "") +
      `\n\nNext: \`tapp_run_qa\` with \`appBundleId: "${bundleId || "<install it first>"}"\`.`;
    return richResult(text, { ok: true, appPath: built.appPath, scheme: built.scheme, container: built.container, bundleId });
  }

  if (name === "tapp_capture") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;

    const mode = typeof args.mode === "string" ? args.mode.trim() : "";
    const allowedModes = new Set(["screenshot", "record", "explore", "tree"]);
    if (!allowedModes.has(mode)) {
      return errorResult("Invalid mode", { allowedModes: Array.from(allowedModes), received: args.mode ?? null });
    }

    if ((mode === "explore" || mode === "tree") && !isNonEmptyString(args.appBundleId)) {
      return errorResult("appBundleId is required for explore/tree mode");
    }

    const captureScript = path.join(scriptsDir, "quick-capture.sh");
    if (!fs.existsSync(captureScript)) {
      return errorResult("Capture script not found", { captureScript });
    }

    const cmdArgs = [captureScript, mode];

    if (mode === "explore" || mode === "tree") {
      cmdArgs.push(String(args.appBundleId).trim());
    }

    const actions = asInteger(args.actions, null);
    if (mode === "explore" && actions !== null) {
      if (actions < 1 || actions > 1000) {
        return errorResult("actions must be between 1 and 1000", { received: actions });
      }
      cmdArgs.push("--actions", String(actions));
    }

    const duration = asInteger(args.duration, null);
    if (mode === "record" && duration !== null) {
      if (duration < 1 || duration > 3600) {
        return errorResult("duration must be between 1 and 3600 seconds", { received: duration });
      }
      cmdArgs.push("--duration", String(duration));
    }

    const env = {};
    if (typeof args.testEmail === "string" && args.testEmail) {
      env.OCQA_TEST_EMAIL = args.testEmail;
    }
    if (typeof args.testPassword === "string" && args.testPassword) {
      env.OCQA_TEST_PASSWORD = args.testPassword;
    }
    if (args.inputOverrides && typeof args.inputOverrides === "object" && !Array.isArray(args.inputOverrides)) {
      const entries = Object.entries(args.inputOverrides).filter(
        ([k, v]) => typeof k === "string" && typeof v === "string" && k.trim() && v.length > 0
      );
      if (entries.length > 0) {
        const sanitized = Object.fromEntries(entries.map(([k, v]) => [k.trim(), v]));
        env.OCQA_INPUT_OVERRIDES_JSON = JSON.stringify(sanitized);
      }
    }

    const before = new Set(listCaptureRuns(50).map((r) => r.id));
    const result = await runCommand("bash", cmdArgs, {
      cwd: repoRoot,
      env,
      timeoutMs: mode === "explore" ? 30 * 60 * 1000 : 10 * 60 * 1000,
    });
    const after = listCaptureRuns(50);
    const created = after.find((r) => !before.has(r.id));

    const ok = result.code === 0;
    const title = ok ? "📦 Capture complete" : `❌ Capture failed${result.timedOut ? " (timed out)" : ""}`;
    const out = [title];
    if (created) out.push(`\nRun: \`${created.relativePath}\``);
    if (!ok) {
      const tail = (result.stderr || result.stdout || "").trim();
      if (tail) out.push("\n```", tail.slice(-1200), "```");
    }
    return richResult(out.join("\n"), {
      code: result.code,
      ok,
      createdCapture: created || null,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    });
  }

  if (name === "tapp_parse_markers") {
    let runPath = null;
    if (isNonEmptyString(args.runPath)) {
      runPath = normalizeCapturePath(args.runPath.trim());
      if (!runPath) {
        return errorResult("runPath must be inside captures/", { capturesDir });
      }
    } else if (isNonEmptyString(args.runId)) {
      runPath = normalizeCapturePath(path.join(capturesDir, args.runId.trim()));
    }

    if (!runPath) {
      return errorResult("Provide runId or runPath");
    }

    const markersFilePath = path.join(runPath, "ocqa-markers.txt");
    const parsed = parseOcqaMarkers(markersFilePath);
    if (!parsed) {
      return errorResult("Markers file not found", { markersFilePath });
    }

    const c = parsed.counts || {};
    const screens = Array.isArray(parsed.uniqueScreens) ? parsed.uniqueScreens : [];
    const L = [
      `🧾 Parsed markers from \`${parsed.relativeMarkersFilePath || "ocqa-markers.txt"}\``,
      "",
      `States: **${c.STATE || 0}** · Actions: **${c.ACTION || 0}** · Issues: **${c.ISSUE || 0}** · Transitions: **${c.TRANSITION || 0}**`,
      `Screens: ${screens.length ? screens.slice(0, 8).join(", ") : "none"}${screens.length > 8 ? ` (+${screens.length - 8} more)` : ""}`,
    ];
    return richResult(L.join("\n"), parsed);
  }

  if (name === "tapp_list_captures") {
    const limit = asInteger(args.limit, 10);
    if (limit < 1 || limit > 100) {
      return errorResult("limit must be between 1 and 100", { received: limit });
    }
    const captures = listCaptureRuns(limit);
    const L = [`🗂️ Found **${captures.length}** capture run${captures.length === 1 ? "" : "s"}`];
    if (captures.length) {
      L.push("");
      for (const c of captures.slice(0, 12)) {
        L.push(`- \`${c.id}\` · ${c.relativePath}`);
      }
      if (captures.length > 12) L.push(`- …and ${captures.length - 12} more`);
    }
    return richResult(L.join("\n"), { captures });
  }

  if (name === "tapp_capture_summary") {
    let runPath = null;
    if (isNonEmptyString(args.runPath)) {
      runPath = normalizeCapturePath(args.runPath.trim());
      if (!runPath) {
        return errorResult("runPath must be inside captures/", { capturesDir });
      }
    } else if (isNonEmptyString(args.runId)) {
      runPath = normalizeCapturePath(path.join(capturesDir, args.runId.trim()));
    }

    if (!runPath) {
      return errorResult("Provide runId or runPath");
    }

    const summary = summarizeCapture(runPath);
    if (!summary) {
      return errorResult("Capture not found", { runPath });
    }
    const L = [
      `📁 Capture summary — \`${summary.relativePath}\``,
      "",
      `Screenshots: **${summary.screenshotCount}** · Videos: **${summary.videos.length}** · Markers: **${summary.hasMarkers ? "yes" : "no"}**`,
    ];
    if (summary.videos.length) L.push(`Videos: ${summary.videos.join(", ")}`);
    return richResult(L.join("\n"), summary);
  }

  if (name === "tapp_run_qa") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    const wantsWeb = isNonEmptyString(args.url);
    const wantsAndroid = isNonEmptyString(args.androidAppId);
    const targets = [wantsWeb, wantsAndroid, isNonEmptyString(args.appBundleId)].filter(Boolean).length;
    if (targets !== 1) {
      return errorResult("Provide exactly one of appBundleId (iOS), androidAppId (Android), or url (web beta)");
    }

    // Both branches call the shared engine (runQaWeb/runQaIos) — the handler only adds
    // MCP concerns: auth, arg validation, and progress notifications.
    const progressToken = request.params && request.params._meta ? request.params._meta.progressToken : undefined;
    const budget = Math.max(1, Math.min(1000, asInteger(args.maxActions, 60)));
    const notifyProgress = (unit) => (p) => {
      if (progressToken === undefined) return;
      const total = p.max || budget;
      server.notification({
        method: "notifications/progress",
        params: { progressToken, progress: p.action || 0, total, message: `🔍 Exploring… ${p.action}/${total} actions · ${p.states} ${unit} reached` },
      }).catch(() => {});
    };
    if (wantsWeb) {
      const r = await runQaWeb({
        url: args.url,
        maxActions: args.maxActions,
        timeout: args.timeout,
        testEmail: args.testEmail,
        testPassword: args.testPassword,
        baselineFindings: args.baselineFindings,
        onProgress: notifyProgress("pages"),
      });
      if (r.error) return errorResult(r.error, r.details || {});
      return richResult(r.text, r.structured);
    }

    if (wantsAndroid) {
      const r = await runQaAndroid({
        appId: args.androidAppId,
        apkPath: args.apkPath,
        serial: args.androidSerial,
        maxActions: args.maxActions,
        timeout: args.timeout,
        testEmail: args.testEmail,
        testPassword: args.testPassword,
        baselineFindings: args.baselineFindings,
        clearData: args.clearData !== false,
        onProgress: notifyProgress("screens"),
      });
      if (r.error) return errorResult(r.error, r.details || {});
      return richResult(r.text, r.structured);
    }

    let lastProgress = null;
    const iosProgress = notifyProgress("screens");
    const r = await runQaIos({
      bundleId: String(args.appBundleId).trim(),
      maxActions: args.maxActions,
      timeout: args.timeout,
      args,
      onProgress: (p) => {
        lastProgress = p;
        iosProgress(p);
      },
    });
    if (r.error) return errorResult(r.error, { ...(r.details || {}), lastProgress });
    return richResult(r.text, r.structured);
  }

  if (name === "tapp_init") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    const operation = String(args.operation || "inspect").toLowerCase();
    if (!["inspect", "write", "refresh", "explore"].includes(operation)) return errorResult("operation must be inspect|write|refresh|explore");
    const projectDir = isNonEmptyString(args.projectDir) ? path.resolve(repoRoot, args.projectDir.trim()) : repoRoot;
    if (!isInsideDir(repoRoot, projectDir) || !fs.existsSync(projectDir)) return errorResult("projectDir must be an existing directory inside the repo");
    const maxContracts = asInteger(args.maxContracts, 15);
    if (maxContracts < 1 || maxContracts > 50) return errorResult("maxContracts must be between 1 and 50");
    const { initializeProductProject } = await import("./product-operations.js");
    try {
      const outDir = isNonEmptyString(args.outDir) ? args.outDir.trim() : ".tapp";
      const resolvedOut = path.resolve(projectDir, outDir);
      if (!isInsideDir(projectDir, resolvedOut)) return errorResult("outDir must be inside projectDir");
      const selectedPlatform = isNonEmptyString(args.platform) ? args.platform.trim().toLowerCase()
        : isNonEmptyString(args.url) ? "web"
        : isNonEmptyString(args.androidAppId) || isNonEmptyString(args.apkPath) ? "android" : "ios";
      const progressToken = request.params && request.params._meta ? request.params._meta.progressToken : undefined;
      const budget = Math.max(1, Math.min(1000, asInteger(args.maxActions, 40)));
      const result = await initializeProductProject({
        projectDir, mode: operation, outDir,
        ownedUrl: isNonEmptyString(args.url) ? args.url.trim() : "",
        platform: isNonEmptyString(args.platform) ? args.platform.trim().toLowerCase() : operation === "explore" ? selectedPlatform : "",
        target: isNonEmptyString(args.target) ? args.target.trim() : projectDir,
        bundleId: isNonEmptyString(args.appBundleId) ? args.appBundleId.trim() : "",
        appId: isNonEmptyString(args.androidAppId) ? args.androidAppId.trim() : "",
        apkPath: isNonEmptyString(args.apkPath) ? path.resolve(projectDir, args.apkPath.trim()) : undefined,
        serial: isNonEmptyString(args.androidSerial) ? args.androidSerial.trim() : undefined,
        maxActions: args.maxActions, timeout: args.timeout, maxContracts,
        testEmail: args.testEmail, testPassword: args.testPassword,
        runExploration: runInitExploration,
        onProgress: (progress) => {
          if (progressToken === undefined) return;
          server.notification({ method: "notifications/progress", params: { progressToken, progress: progress.action || 0, total: progress.max || budget, message: `Import exploration · ${progress.states} state(s) reached` } }).catch(() => {});
        },
      });
      const { model, plan, written, exploration } = result;
      const blocking = model.requirements.filter((item) => item.severity === "blocking");
      const pending = plan.items.filter((item) => item.decision === "pending");
      const summary = `🧭 Tapp init — ${model.application.name} · ${model.targets.length} target(s) · UI Map ${model.uiMap.status} (${model.uiMap.nodeCount} states/${model.uiMap.edgeCount} transitions) · ${plan.items.length} plan item(s), ${pending.length} pending · ${blocking.length} blocking requirement(s)${exploration ? ` · real ${exploration.platform} exploration ${exploration.verdict}${exploration.inconclusive ? " (inconclusive)" : ""}` : ""}`;
      return richResult(summary, { model, plan, written: written ? { modelPath: written.modelPath, planPath: written.planPath } : null, exploration });
    } catch (error) { return errorResult("Could not initialize Tapp repository artifacts", { detail: error.message || String(error) }); }
  }

  if (name === "tapp_actor_config") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    const operation = String(args.operation || "read").toLowerCase();
    if (!["read", "set"].includes(operation)) return errorResult("operation must be read|set");
    const allowedArguments = new Set(["authToken", "operation", "projectDir", "name", "role", "session", "provisioning", "credentialBindings", "replace"]);
    const unexpectedArguments = Object.keys(args).filter((key) => !allowedArguments.has(key));
    if (unexpectedArguments.length) return errorResult("Unsupported actor configuration fields; credential values are never accepted", { fields: unexpectedArguments });
    const projectDir = isNonEmptyString(args.projectDir) ? path.resolve(repoRoot, args.projectDir.trim()) : repoRoot;
    if (!isInsideDir(repoRoot, projectDir) || !fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) return errorResult("projectDir must be an existing directory inside the repo");
    const { configureActor, readProjectConfig } = await import("./project-config.js");
    if (operation === "read") {
      const loaded = readProjectConfig(projectDir);
      if (loaded.errors.length) return errorResult("Project actor configuration is invalid", { path: loaded.path, errors: loaded.errors });
      return richResult(`👥 Tapp actors — ${Object.keys(loaded.config.actors || {}).length} configured · credential values are never returned`, { path: loaded.path, exists: loaded.exists, actors: loaded.config.actors || {}, lifecycle: loaded.config.lifecycle || {} });
    }
    if (!isNonEmptyString(args.name)) return errorResult("set requires name");
    const supplied = args.credentialBindings === undefined ? {} : args.credentialBindings;
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) return errorResult("credentialBindings must map credential names to environment-variable names");
    const credentials = Object.fromEntries(Object.entries(supplied).map(([key, env]) => [key, { env }]));
    try {
      const result = configureActor(projectDir, {
        name: args.name.trim(),
        role: isNonEmptyString(args.role) ? args.role.trim() : "",
        session: isNonEmptyString(args.session) ? args.session.trim() : "default",
        provisioning: isNonEmptyString(args.provisioning) ? args.provisioning.trim() : "existing",
        credentials,
        replace: asBoolean(args.replace),
      });
      return richResult(`✅ Actor '${args.name.trim()}' configured with ${Object.keys(result.actor.credentials).length} environment binding(s); no credential values were accepted or written`, { path: result.path, actor: result.actor, next: "Run tapp_init refresh to update the application model and release plan." });
    } catch (error) { return errorResult("Actor not configured", { detail: error.message || String(error) }); }
  }

  if (name === "tapp_release_plan") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    const operation = String(args.operation || "read").toLowerCase();
    if (!["read", "review", "generate", "validate", "promote"].includes(operation)) return errorResult("operation must be read|review|generate|validate|promote");
    const planPath = isNonEmptyString(args.planPath) ? path.resolve(repoRoot, args.planPath.trim()) : existingProjectArtifactPath(repoRoot, "release-plan.json");
    if (!isInsideDir(repoRoot, planPath)) return errorResult("planPath must be inside the repo");
    if (!fs.existsSync(planPath)) return errorResult("Release plan not found", { planPath });
    let plan;
    try { plan = JSON.parse(fs.readFileSync(planPath, "utf8")); }
    catch (error) { return errorResult("Release plan is invalid JSON", { detail: error.message || String(error) }); }
    if (operation === "review") {
      const decisions = { approve: args.approve || [], reject: args.reject || [], defer: args.defer || [] };
      if (![...decisions.approve, ...decisions.reject, ...decisions.defer].length) return errorResult("review requires at least one approve, reject, or defer item");
      const { reviewProductPlan } = await import("./product-operations.js");
      try {
        plan = reviewProductPlan({ projectDir: repoRoot, planPath, ...decisions }).plan;
      } catch (error) { return errorResult("Could not review release plan", { detail: error.message || String(error) }); }
    } else if (operation === "generate") {
      const projectDir = isNonEmptyString(args.projectDir) ? path.resolve(repoRoot, args.projectDir.trim()) : repoRoot;
      if (!isInsideDir(repoRoot, projectDir) || !fs.existsSync(projectDir)) return errorResult("projectDir must be an existing directory inside the repo");
      const { generateProductPlan } = await import("./product-operations.js");
      try {
        const result = await generateProductPlan({ projectDir, planPath });
        plan = result.plan;
        return richResult(`🧩 Proposal drafts — ${result.generatedTasks.length} UI-Map-grounded Task(s) · ${result.generated.length} compile-checked/untrusted contract(s) · ${result.blocked.length} blocked; deterministic real-surface replay remains required`, { plan, planPath, generatedTasks: result.generatedTasks, generated: result.generated, blocked: result.blocked });
      } catch (error) { return errorResult("Could not generate contract drafts", { detail: error.message || String(error) }); }
    } else if (operation === "validate") {
      const projectDir = isNonEmptyString(args.projectDir) ? path.resolve(repoRoot, args.projectDir.trim()) : repoRoot;
      if (!isInsideDir(repoRoot, projectDir) || !fs.existsSync(projectDir)) return errorResult("projectDir must be an existing directory inside the repo");
      let apkPath = "";
      if (isNonEmptyString(args.apkPath)) {
        apkPath = path.resolve(projectDir, args.apkPath.trim());
        if (!isInsideDir(projectDir, apkPath)) return errorResult("apkPath must remain inside projectDir");
      }
      const { validateProductPlan } = await import("./product-operations.js");
      const progressToken = request.params && request.params._meta ? request.params._meta.progressToken : undefined;
      try {
        const result = await validateProductPlan({
          projectDir, planPath,
          items: Array.isArray(args.items) ? args.items : [],
          platform: isNonEmptyString(args.platform) ? args.platform.trim() : "",
          url: isNonEmptyString(args.url) ? args.url.trim() : "",
          target: isNonEmptyString(args.target) ? args.target.trim() : "",
          bundleId: isNonEmptyString(args.appBundleId) ? args.appBundleId.trim() : "",
          appId: isNonEmptyString(args.androidAppId) ? args.androidAppId.trim() : "",
          apkPath,
          serial: isNonEmptyString(args.androidSerial) ? args.androidSerial.trim() : "",
          timeout: asInteger(args.timeout, 600),
          startWebTarget: startManagedWebTarget,
          stopWebTarget: stopManagedWebTarget,
          onProgress: (entry) => {
            if (progressToken === undefined) return;
            server.notification({ method: "notifications/progress", params: { progressToken, progress: entry.current || 0, total: entry.total || 1, message: entry.text || entry.phase || "Validating release contract" } }).catch(() => {});
          },
        });
        plan = result.plan;
        if (!result.passed) return errorResult("Generated contract validation failed", { result, plan, planPath });
        return richResult(`🔎 Generated contract validation passed — ${result.results.length}/${result.results.length} on ${result.platform}`, { ...result, planPath });
      } catch (error) { return errorResult("Generated contract validation failed", { detail: error.message || String(error), plan, planPath }); }
    } else if (operation === "promote") {
      const projectDir = isNonEmptyString(args.projectDir) ? path.resolve(repoRoot, args.projectDir.trim()) : repoRoot;
      if (!isInsideDir(repoRoot, projectDir) || !fs.existsSync(projectDir)) return errorResult("projectDir must be an existing directory inside the repo");
      const { promoteProductPlan } = await import("./product-operations.js");
      try {
        const result = await promoteProductPlan({ projectDir, planPath, items: Array.isArray(args.items) ? args.items : [] });
        plan = result.plan;
        return richResult(`📦 Promoted ${result.promotedTasks.length} validated Task(s) and ${result.promotedContracts.length} release contract(s); canonical UI Map coverage updated`, { ...result, planPath });
      } catch (error) { return errorResult("Could not promote validated proposals", { detail: error.message || String(error) }); }
    }
    return richResult(`📋 ${plan.application?.name || "Tapp"} release plan — ${plan.status} · ${(plan.items || []).length} item(s)`, { plan, planPath });
  }

  if (name === "tapp_ci_setup") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    const operation = String(args.operation || "inspect").toLowerCase();
    if (!["inspect", "install", "baseline"].includes(operation)) return errorResult("operation must be inspect|install|baseline");
    const projectDir = isNonEmptyString(args.projectDir) ? path.resolve(repoRoot, args.projectDir.trim()) : repoRoot;
    if (!isInsideDir(repoRoot, projectDir) || !fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) return errorResult("projectDir must be an existing directory inside the repo");
    const modelPath = isNonEmptyString(args.modelPath) ? path.resolve(repoRoot, args.modelPath.trim()) : existingProjectArtifactPath(projectDir, "application-model.json");
    if (!isInsideDir(projectDir, modelPath) || !fs.existsSync(modelPath)) return errorResult("Application model not found inside projectDir; run tapp_init first", { modelPath });
    let model;
    try { model = JSON.parse(fs.readFileSync(modelPath, "utf8")); }
    catch (error) { return errorResult("Application model is invalid JSON", { detail: error.message || String(error) }); }
    const { createProductBaseline, installProductCi, prepareProductCi } = await import("./product-operations.js");
    if (operation === "baseline") {
      if (!isNonEmptyString(args.reportPath)) return errorResult("baseline requires reportPath from a successful portable gate");
      const reportPath = path.resolve(repoRoot, args.reportPath.trim());
      if (!isInsideDir(repoRoot, reportPath) || !fs.existsSync(reportPath)) return errorResult("reportPath must be an existing JSON file inside the repo");
      let report;
      try { report = JSON.parse(fs.readFileSync(reportPath, "utf8")); }
      catch (error) { return errorResult("Gate report is invalid JSON", { detail: error.message || String(error) }); }
      try {
        const result = createProductBaseline({ projectDir, reportPath, platform: args.platform || "", target: args.target || "", baselinePath: isNonEmptyString(args.baselinePath) ? args.baselinePath.trim() : "", replace: asBoolean(args.replace) });
        return richResult(`✅ Conclusive baseline established — ${result.selectedTarget.platform}:${result.selectedTarget.name} · ${result.validation.screensExplored} states · ${result.validation.suite.contracts} contract(s)`, result);
      } catch (error) { return errorResult("Baseline not written", { detail: error.message || String(error) }); }
    }
    try {
      const actionRef = isNonEmptyString(args.actionRef) ? args.actionRef.trim() : `aarwitz/tapp@v${pkgVersion}`;
      const defaultBranch = isNonEmptyString(args.defaultBranch) ? args.defaultBranch.trim() : "main";
      const rendered = prepareProductCi({ projectDir, modelPath, actionRef, defaultBranch });
      if (operation === "inspect") return richResult(`🧩 CI plan — ${rendered.manifest.targets.length} target job(s) · ${rendered.manifest.unresolved.length} unresolved · read-only`, rendered);
      if (rendered.manifest.unresolved.length && !asBoolean(args.allowUnresolved)) return errorResult("CI workflow not installed because target configuration remains unresolved", { unresolved: rendered.manifest.unresolved, next: "Resolve the application model requirements or explicitly allow an inspect-only draft." });
      const result = installProductCi({ projectDir, modelPath, actionRef, defaultBranch, workflowPath: isNonEmptyString(args.workflowPath) ? args.workflowPath.trim() : ".github/workflows/tapp.yml", manifestPath: isNonEmptyString(args.manifestPath) ? args.manifestPath.trim() : ".tapp/ci.json", replace: asBoolean(args.replace), allowUnresolved: asBoolean(args.allowUnresolved) });
      return richResult(`✅ Reviewable CI gate installed — ${result.manifest.targets.length} target job(s); no commit, push, branch protection, or GitHub resource was created`, result);
    } catch (error) { return errorResult("Could not prepare CI installation", { detail: error.message || String(error) }); }
  }

  if (name === "tapp_ui_map") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    const operation = String(args.operation || "read").toLowerCase();
    const resolveRepoFile = (value, fallback = "") => {
      const resolved = path.resolve(repoRoot, isNonEmptyString(value) ? value.trim() : fallback);
      return isInsideDir(repoRoot, resolved) ? resolved : null;
    };
    const capture = isNonEmptyString(args.captureId) ? listCaptureRuns(200).find((run) => run.id === args.captureId.trim()) : null;
    if (isNonEmptyString(args.captureId) && !capture) return errorResult("Capture not found", { captureId: args.captureId });
    const { buildUiMapFromMarkers, diffUiMaps, mergeUiMaps, validateUiMap, writeUiMap } = await import("./ui-map.js");
    if (operation === "diff") {
      const beforePath = resolveRepoFile(args.beforePath);
      const afterPath = resolveRepoFile(args.afterPath);
      if (!beforePath || !afterPath) return errorResult("beforePath and afterPath must be inside the repo");
      if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) return errorResult("UI Map diff input not found", { beforePath, afterPath });
      try {
        const diff = diffUiMaps(JSON.parse(fs.readFileSync(beforePath, "utf8")), JSON.parse(fs.readFileSync(afterPath, "utf8")), { comparableFullSweep: args.comparableFullSweep === true });
        const text = `🗺️ UI Map diff — +${diff.addedNodes.length} states · ${diff.notObservedNodes.length} not observed · +${diff.addedEdges.length} transitions · ${diff.notObservedEdges.length} transitions not observed${diff.comparableFullSweep ? ` · ${diff.lostReachability.length} lost` : "\nAbsence is not classified as lost reachability because comparableFullSweep was not enabled."}`;
        return richResult(text, diff);
      } catch (error) { return errorResult("Could not diff UI Maps", { detail: error.message || String(error) }); }
    }
    if (operation === "build") {
      const markersPath = capture ? path.join(capture.path, "ocqa-markers.txt") : resolveRepoFile(args.markersPath);
      if (!markersPath) return errorResult("markersPath must be inside the repo, or provide captureId");
      if (!fs.existsSync(markersPath)) return errorResult("OCQA markers not found", { markersPath });
      const outPath = isNonEmptyString(args.mapPath) ? resolveRepoFile(args.mapPath) : existingProjectArtifactPath(repoRoot, "ui-map.json");
      if (!outPath) return errorResult("mapPath must be inside the repo");
      try {
        const observed = buildUiMapFromMarkers({ markersPath, platform: args.platform || "ios", target: args.target || "", runId: capture?.id || "" });
        const map = fs.existsSync(outPath) && args.replace !== true ? mergeUiMaps(JSON.parse(fs.readFileSync(outPath, "utf8")), observed) : observed;
        writeUiMap(outPath, map);
        const controls = map.nodes.reduce((total, node) => total + node.controls.length, 0);
        return richResult(`🗺️ UI Map updated — ${map.nodes.length} states · ${map.edges.length} transitions · ${controls} semantic controls\n${path.relative(repoRoot, outPath)}`, { map, path: outPath });
      } catch (error) { return errorResult("Could not build UI Map", { detail: error.message || String(error) }); }
    }
    if (operation !== "read") return errorResult("operation must be read|build|diff");
    const mapPath = capture ? path.join(capture.path, "ui-map.json") : isNonEmptyString(args.mapPath) ? resolveRepoFile(args.mapPath) : existingProjectArtifactPath(repoRoot, "ui-map.json");
    if (!mapPath) return errorResult("mapPath must be inside the repo");
    if (!fs.existsSync(mapPath)) return errorResult("UI Map not found; run QA or operation=build first", { mapPath });
    try {
      const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
      const errors = validateUiMap(map);
      if (errors.length) return errorResult("Invalid UI Map", { errors, mapPath });
      const controls = map.nodes.reduce((total, node) => total + node.controls.length, 0);
      return richResult(`🗺️ UI Map v${map.schemaVersion} — ${map.nodes.length} states · ${map.edges.length} transitions · ${controls} semantic controls`, { map, path: mapPath });
    } catch (error) { return errorResult("Could not read UI Map", { detail: error.message || String(error) }); }
  }

  if (name === "tapp_task") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    const operation = String(args.operation || "validate").toLowerCase();
    if (!["read", "validate", "compile"].includes(operation)) return errorResult("operation must be read|validate|compile");
    const taskPath = isNonEmptyString(args.taskPath) ? path.resolve(repoRoot, args.taskPath.trim()) : null;
    if (!taskPath || !isInsideDir(repoRoot, taskPath)) return errorResult("taskPath must be inside the repo");
    if (!fs.existsSync(taskPath)) return errorResult("Task file not found", { taskPath: args.taskPath });
    const { applyTaskCoverage, compileTaskSteps, loadTaskFile, loadTaskRegistry, validateTaskAgainstUiMap } = await import("./task-runtime.js");
    let task;
    try { task = loadTaskFile(taskPath); }
    catch (error) { return errorResult("Invalid Task", { detail: error.message || String(error) }); }
    if (operation === "read") return richResult(`🧩 Task ${task.name} v${task.version}`, { task, path: taskPath });
    let grounding = { errors: [], warnings: [] };
    let groundingMap = null;
    let groundingMapPath = null;
    if (isNonEmptyString(args.mapPath)) {
      const mapPath = path.resolve(repoRoot, args.mapPath.trim());
      if (!isInsideDir(repoRoot, mapPath)) return errorResult("mapPath must be inside the repo");
      if (!fs.existsSync(mapPath)) return errorResult("UI Map not found", { mapPath: args.mapPath });
      groundingMapPath = mapPath;
      try {
        groundingMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));
        grounding = validateTaskAgainstUiMap(task, groundingMap, args.platform || "");
      }
      catch (error) { return errorResult("Could not ground Task", { detail: error.message || String(error) }); }
    }
    if (grounding.errors.length) return errorResult("Task is not grounded", grounding);
    if (args.updateMap === true) {
      if (!groundingMap || !groundingMapPath) return errorResult("updateMap requires mapPath");
      fs.writeFileSync(groundingMapPath, JSON.stringify(applyTaskCoverage(groundingMap, task), null, 2) + "\n");
    }
    if (operation === "validate") {
      return richResult(`🧩 Valid Task — ${task.name} v${task.version} · ${(task.coverage?.nodes || []).length} states · ${(task.coverage?.edges || []).length} transitions${grounding.warnings.length ? `\n${grounding.warnings.map((warning) => `⚠️ ${warning}`).join("\n")}` : ""}`, { task, grounding, path: taskPath });
    }
    let registry;
    try {
      registry = loadTaskRegistry({ sourcePath: taskPath });
      if (!registry.has(task.name)) registry.set(task.name, task);
    } catch (error) { return errorResult("Could not load Task registry", { detail: error.message || String(error) }); }
    const vars = {};
    const plan = [];
    let compiled;
    try { compiled = compileTaskSteps({ steps: [{ task: task.name, with: args.inputs || {} }], registry, platform: args.platform || "", flowVars: vars, plan }); }
    catch (error) { return errorResult("Could not compile Task", { detail: error.message || String(error) }); }
    const flow = { name: `Task: ${task.name}`, kind: "flow", platform: args.platform || "", vars: compiled.vars, steps: compiled.steps, taskPlan: compiled.plan };
    let outPath = null;
    if (isNonEmptyString(args.outPath)) {
      outPath = path.resolve(repoRoot, args.outPath.trim());
      if (!isInsideDir(repoRoot, outPath)) return errorResult("outPath must be inside the repo");
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(flow, null, 2) + "\n");
    }
    return richResult(`🧩 Compiled ${task.name} into ${flow.steps.length} deterministic Flow steps${outPath ? `\n${path.relative(repoRoot, outPath)}` : ""}`, { flow, grounding, path: outPath });
  }

  if (name === "tapp_release_contract") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    const operation = String(args.operation || "validate").toLowerCase();
    if (!["read", "validate", "compile", "run"].includes(operation)) return errorResult("operation must be read|validate|compile|run");
    const contractPath = isNonEmptyString(args.contractPath) ? path.resolve(repoRoot, args.contractPath.trim()) : null;
    if (!contractPath || !isInsideDir(repoRoot, contractPath)) return errorResult("contractPath must be inside the repo");
    const {
      applyReleaseContractCoverage,
      compileReleaseContract,
      loadReleaseContractFile,
      validateReleaseContractAgainstUiMap,
    } = await import("./release-contract.js");
    let contract;
    try { contract = await loadReleaseContractFile(contractPath); }
    catch (error) { return errorResult("Invalid Release Contract", { detail: error.message || String(error) }); }
    if (operation === "read") return richResult(`📜 ${contract.title} — ${contract.criticality}`, { contract, path: contractPath });
    let grounding = { errors: [], warnings: [] };
    let groundingMap = null;
    let groundingMapPath = null;
    if (isNonEmptyString(args.mapPath)) {
      groundingMapPath = path.resolve(repoRoot, args.mapPath.trim());
      if (!isInsideDir(repoRoot, groundingMapPath)) return errorResult("mapPath must be inside the repo");
      if (!fs.existsSync(groundingMapPath)) return errorResult("UI Map not found", { mapPath: args.mapPath });
      try {
        groundingMap = JSON.parse(fs.readFileSync(groundingMapPath, "utf8"));
        grounding = validateReleaseContractAgainstUiMap(contract, groundingMap);
      } catch (error) { return errorResult("Could not ground Release Contract", { detail: error.message || String(error) }); }
    }
    if (grounding.errors.length) return errorResult("Release Contract is not grounded", grounding);
    if (args.updateMap === true) {
      if (!groundingMapPath) return errorResult("updateMap requires mapPath");
      fs.writeFileSync(groundingMapPath, JSON.stringify(applyReleaseContractCoverage(groundingMap, contract), null, 2) + "\n");
    }
    if (operation === "validate") {
      return richResult(`📜 Valid Release Contract — ${contract.title} · ${contract.criticality} · ${Object.keys(contract.actors).length} actor(s) · ${contract.steps.length} business steps${grounding.warnings.length ? `\n${grounding.warnings.map((warning) => `⚠️ ${warning}`).join("\n")}` : ""}`, { contract, grounding, path: contractPath });
    }
    const platform = String(args.platform || (contract.platforms.length === 1 ? contract.platforms[0] : "")).toLowerCase();
    let execution;
    try { execution = compileReleaseContract(contract, { platform, sourcePath: contractPath }); }
    catch (error) { return errorResult("Could not compile Release Contract", { detail: error.message || String(error) }); }
    let outPath = null;
    if (isNonEmptyString(args.outPath)) {
      outPath = path.resolve(repoRoot, args.outPath.trim());
      if (!isInsideDir(repoRoot, outPath)) return errorResult("outPath must be inside the repo");
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(execution, null, 2) + "\n");
    }
    if (operation === "compile") {
      return richResult(`📜 Compiled ${contract.name} into ${execution.steps.length} deterministic ${execution.kind === "scenario" ? "Scenario" : "Flow"} steps`, { contract, execution, grounding, path: outPath });
    }
    const flowLog = path.join(os.tmpdir(), `mcp-contract-${Date.now()}.log`);
    const evidenceDir = path.join(capturesDir, `contract-${platform}-${Date.now()}`);
    try {
      if (execution.kind === "scenario") {
        const { runWebScenario } = await import("./scenario-runtime.js");
        await runWebScenario({ scenario: execution, url: isNonEmptyString(args.url) ? args.url.trim() : undefined, logPath: flowLog, screenshotDir: evidenceDir });
      } else if (platform === "web") {
        const { runWebFlow } = await import("./web-flow.js");
        await runWebFlow({ flow: execution, url: isNonEmptyString(args.url) ? args.url.trim() : undefined, logPath: flowLog, screenshotDir: evidenceDir });
      } else if (platform === "android") {
        const { runAndroidFlow } = await import("./android-flow.js");
        await runAndroidFlow({
          flow: execution,
          appId: isNonEmptyString(args.androidAppId) ? args.androidAppId.trim() : execution.app,
          apkPath: isNonEmptyString(args.apkPath) ? path.resolve(args.apkPath) : undefined,
          serial: isNonEmptyString(args.androidSerial) ? args.androidSerial.trim() : undefined,
          logPath: flowLog,
          screenshotDir: evidenceDir,
        });
      } else {
        const prepared = await runCommand("bash", [path.join(scriptsDir, "quick-capture.sh"), "build-harness"], { cwd: repoRoot, timeoutMs: 10 * 60 * 1000 });
        if (prepared.code !== 0) return errorResult("Could not prepare iOS harness", { stderr: prepared.stderr, stdout: prepared.stdout });
        const compiledPath = path.join(os.tmpdir(), `mcp-contract-${Date.now()}.json`);
        fs.writeFileSync(compiledPath, JSON.stringify({ ...execution, app: isNonEmptyString(args.appBundleId) ? args.appBundleId.trim() : execution.app }));
        const run = await runCommand("bash", [path.join(scriptsDir, "run-flow.sh"), compiledPath, isNonEmptyString(args.appBundleId) ? args.appBundleId.trim() : execution.app || ""], { cwd: repoRoot, timeoutMs: 10 * 60 * 1000, env: { ...process.env, FLOW_LOG: flowLog } });
        if (!fs.existsSync(flowLog)) return errorResult("iOS Release Contract produced no evidence", { stderr: run.stderr, stdout: run.stdout });
      }
    } catch (error) { return errorResult("Release Contract failed to start", { detail: error.message || String(error) }); }
    const jsonRes = await runCommand("python3", [path.join(scriptsDir, "flow_lib.py"), "report", "--json", flowLog], { cwd: repoRoot });
    const textRes = await runCommand("python3", [path.join(scriptsDir, "flow_lib.py"), "report", flowLog], { cwd: repoRoot });
    let structured = null;
    try { structured = JSON.parse(jsonRes.stdout.trim()); } catch {}
    return richResult((textRes.stdout || "").trim(), { ...(structured || {}), contract: contract.name, criticality: contract.criticality, platform, evidenceDir });
  }

  if (name === "tapp_pr_plan") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    const operation = isNonEmptyString(args.operation) ? args.operation.trim().toLowerCase() : "plan";
    if (!['plan', 'adopt'].includes(operation)) return errorResult("operation must be plan|adopt");
    const projectDir = isNonEmptyString(args.projectDir) ? path.resolve(repoRoot, args.projectDir.trim()) : repoRoot;
    if (!isInsideDir(repoRoot, projectDir)) return errorResult("projectDir must be inside the repo");
    if (operation === "adopt") {
      if (!isNonEmptyString(args.prPlanPath) || !isNonEmptyString(args.item)) return errorResult("adopt requires prPlanPath and item");
      const prPlanPath = path.resolve(projectDir, args.prPlanPath.trim());
      if (!isInsideDir(repoRoot, prPlanPath)) return errorResult("prPlanPath must be inside the repo");
      const { adoptPrCoverageProposal } = await import("./pr-selection.js");
      try {
        const adopted = adoptPrCoverageProposal({
          projectDir,
          prPlanPath,
          item: args.item.trim(),
          releasePlanPath: isNonEmptyString(args.releasePlanPath) ? args.releasePlanPath.trim() : undefined,
        });
        return richResult(`📥 ${adopted.mode === "reconciled-existing" ? "Reconciled PR evidence into" : "Adopted"} ${adopted.item.name}${adopted.mode === "reconciled-existing" ? ` while preserving decision '${adopted.item.decision}'` : " as a pending release-plan item"}; no Task or contract was generated or trusted`, { path: adopted.path, item: adopted.item, plan: adopted.plan, mode: adopted.mode });
      } catch (error) { return errorResult("Could not adopt PR coverage proposal", { detail: error.message || String(error) }); }
    }
    const validChange = (item) => isNonEmptyString(item) || (item && typeof item === "object" && !Array.isArray(item) && isNonEmptyString(item.filename) &&
      (item.previous_filename === undefined || isNonEmptyString(item.previous_filename)) && (item.patch === undefined || typeof item.patch === "string"));
    if (!Array.isArray(args.changedFiles) || !args.changedFiles.length || args.changedFiles.some((item) => !validChange(item))) {
      return errorResult("changedFiles must be a non-empty array of repository-relative paths or change objects");
    }
    const { buildPrContractPlan } = await import("./pr-selection.js");
    try {
      const plan = await buildPrContractPlan({
        projectDir,
        changedFiles: args.changedFiles,
        platform: isNonEmptyString(args.platform) ? args.platform.trim().toLowerCase() : "",
        mapPath: isNonEmptyString(args.mapPath) ? args.mapPath.trim() : "",
      });
      const summary = `📋 PR contract plan — ${plan.selected.length} selected · ${plan.skipped.length} skipped · ${plan.explorationTargets.length} bounded exploration target(s) · ${plan.uncoveredChangedFiles.length} uncovered changed file(s)` +
        (plan.selected.length ? `\n${plan.selected.map((item) => `✅ ${item.name} (${item.criticality}) — ${item.reasons.map((reason) => reason.type).join(", ")}`).join("\n")}` : "") +
        (plan.uncoveredChangedFiles.length ? `\n${plan.uncoveredChangedFiles.map((file) => `⚠️ uncovered: ${file}`).join("\n")}` : "");
      return richResult(summary, { plan });
    } catch (error) { return errorResult("Could not build PR contract plan", { detail: error.message || String(error) }); }
  }

  if (name === "tapp_flow_run") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;

    // Resolve the flow file: inline `flow` object → temp .json, else repo-relative `flowPath`.
    let flowFile;
    let parsedFlow;
    if (args.flow && typeof args.flow === "object") {
      flowFile = path.join(os.tmpdir(), `mcp-flow-${Date.now()}.json`);
      fs.writeFileSync(flowFile, JSON.stringify(args.flow));
      parsedFlow = args.flow;
    } else if (isNonEmptyString(args.flowPath)) {
      const p = path.resolve(repoRoot, args.flowPath.trim());
      if (!isInsideDir(repoRoot, p)) return errorResult("flowPath must be inside the repo");
      if (!fs.existsSync(p)) return errorResult("Flow file not found", { flowPath: args.flowPath });
      flowFile = p;
    } else {
      return errorResult("Provide `flow` (inline) or `flowPath`");
    }

    if (!parsedFlow) {
      const parsed = await runCommand("python3", [path.join(scriptsDir, "flow_lib.py"), "to-json", flowFile], { cwd: repoRoot });
      if (parsed.code !== 0) return errorResult("Could not parse Flow", { stderr: parsed.stderr });
      try { parsedFlow = JSON.parse(parsed.stdout); } catch { return errorResult("Flow parser returned invalid JSON"); }
    }

    const platform = String(
      args.platform || parsedFlow.platform ||
      (args.androidAppId ? "android" :
        (args.url || parsedFlow.url || /^https?:\/\//i.test(parsedFlow.app || "")) ? "web" : "ios")
    ).toLowerCase();

    const flowLog = path.join(os.tmpdir(), `mcp-flow-${Date.now()}.log`);
    const runEnv = { ...process.env, FLOW_LOG: flowLog };
    if (isNonEmptyString(args.testEmail)) runEnv.OCQA_TEST_EMAIL = args.testEmail.trim();
    if (isNonEmptyString(args.testPassword)) runEnv.OCQA_TEST_PASSWORD = args.testPassword.trim();
    let run = { stdout: "", stderr: "", code: 0 };
    if (platform === "web") {
      try {
        const { runWebFlow } = await import("./web-flow.js");
        const evidenceDir = path.join(capturesDir, `flow-web-${Date.now()}`);
        const result = await runWebFlow({
          flow: parsedFlow,
          url: isNonEmptyString(args.url) ? args.url.trim() : undefined,
          logPath: flowLog,
          screenshotDir: evidenceDir,
        });
        run = { ...run, code: result.passed ? 0 : 1, evidenceDir };
      } catch (error) {
        return errorResult("Web Flow failed to start", { detail: error.message || String(error) });
      }
    } else if (platform === "ios") {
      const cmdArgs = [path.join(scriptsDir, "run-flow.sh"), flowFile];
      if (isNonEmptyString(args.appBundleId)) cmdArgs.push(args.appBundleId.trim());
      run = await runCommand("bash", cmdArgs, { cwd: repoRoot, timeoutMs: 10 * 60 * 1000, env: runEnv });
    } else if (platform === "android") {
      try {
        const { runAndroidFlow } = await import("./android-flow.js");
        const evidenceDir = path.join(capturesDir, `flow-android-${Date.now()}`);
        const result = await runAndroidFlow({
          flow: parsedFlow,
          appId: isNonEmptyString(args.androidAppId)
            ? args.androidAppId.trim()
            : isNonEmptyString(args.appBundleId) ? args.appBundleId.trim() : undefined,
          apkPath: isNonEmptyString(args.apkPath) ? path.resolve(args.apkPath) : undefined,
          serial: isNonEmptyString(args.androidSerial) ? args.androidSerial.trim() : undefined,
          logPath: flowLog,
          screenshotDir: evidenceDir,
        });
        run = { ...run, code: result.passed ? 0 : 1, evidenceDir };
      } catch (error) {
        return errorResult("Android Flow failed to start", { detail: error.message || String(error) });
      }
    } else {
      return errorResult("Unsupported Flow platform", { platform });
    }
    if (!fs.existsSync(flowLog)) {
      return errorResult("Flow run produced no log (harness build / launch failure?)", { stderr: run.stderr, stdout: run.stdout });
    }
    // Structured report from the harness markers, plus the scannable text the runner already renders.
    const jsonRes = await runCommand("python3", [path.join(scriptsDir, "flow_lib.py"), "report", "--json", flowLog], { cwd: repoRoot });
    let structured = null;
    try { structured = JSON.parse(jsonRes.stdout.trim()); } catch { /* fall through */ }
    const textRes = await runCommand("python3", [path.join(scriptsDir, "flow_lib.py"), "report", flowLog], { cwd: repoRoot });
    const text = (textRes.stdout || "").trim() || run.stdout;
    return richResult(text, { ...(structured || { raw: run.stdout }), platform, evidenceDir: run.evidenceDir });
  }

  if (name === "tapp_scenario_run") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    let scenario;
    if (args.scenario && typeof args.scenario === "object") {
      scenario = args.scenario;
    } else if (isNonEmptyString(args.scenarioPath)) {
      const scenarioFile = path.resolve(repoRoot, args.scenarioPath.trim());
      if (!isInsideDir(repoRoot, scenarioFile)) return errorResult("scenarioPath must be inside the repo");
      if (!fs.existsSync(scenarioFile)) return errorResult("Scenario file not found", { scenarioPath: args.scenarioPath });
      try {
        const { loadScenarioFile } = await import("./scenario-runtime.js");
        scenario = loadScenarioFile(scenarioFile);
      } catch (error) {
        return errorResult("Could not parse Scenario", { detail: error.message || String(error) });
      }
    } else {
      return errorResult("Provide `scenario` (inline) or `scenarioPath`");
    }
    const flowLog = path.join(os.tmpdir(), `mcp-scenario-${Date.now()}.log`);
    const evidenceDir = path.join(capturesDir, `scenario-web-${Date.now()}`);
    try {
      const { runWebScenario } = await import("./scenario-runtime.js");
      await runWebScenario({
        scenario,
        url: isNonEmptyString(args.url) ? args.url.trim() : undefined,
        variables: args.variables && typeof args.variables === "object" ? args.variables : {},
        logPath: flowLog,
        screenshotDir: evidenceDir,
      });
    } catch (error) {
      return errorResult("Scenario failed to start", { detail: error.message || String(error) });
    }
    const jsonRes = await runCommand("python3", [path.join(scriptsDir, "flow_lib.py"), "report", "--json", flowLog], { cwd: repoRoot });
    const textRes = await runCommand("python3", [path.join(scriptsDir, "flow_lib.py"), "report", flowLog], { cwd: repoRoot });
    let structured = null;
    try { structured = JSON.parse(jsonRes.stdout.trim()); } catch { /* raw evidence remains available */ }
    return richResult((textRes.stdout || "").trim(), { ...(structured || {}), platform: "web", evidenceDir });
  }

  if (name === "tapp_flow_generate") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    if (!isNonEmptyString(args.goal)) return errorResult("goal is required");
    if (!isNonEmptyString(args.appBundleId)) return errorResult("appBundleId is required");
    const backend = resolveModelBackend();
    if (!backend) return errorResult("AI-generate needs a model backend — set TAPP_SUBSCRIPTION_TOKEN or ANTHROPIC_API_KEY.");
    const bundleId = args.appBundleId.trim();

    // 1) Grounding: reuse a capture's markers, else explore the app to build a screen/control map.
    let markersText = "";
    if (isNonEmptyString(args.captureId)) {
      const p = normalizeCapturePath(path.join(capturesDir, args.captureId.trim()));
      const mf = p && path.join(p, "ocqa-markers.txt");
      if (mf && fs.existsSync(mf)) markersText = fs.readFileSync(mf, "utf8");
      else return errorResult("captureId has no markers", { captureId: args.captureId });
    } else {
      const actions = Math.max(5, Math.min(200, asInteger(args.maxActions, 35)));
      const { created } = await runExploreStreaming(bundleId, actions, 400, explorationEnvFromArgs(args), () => {});
      if (!created) return errorResult("Could not explore the app to build grounding (is it installed on a booted sim?)");
      markersText = fs.readFileSync(path.join(created.path, "ocqa-markers.txt"), "utf8");
    }
    const grounding = buildAppGrounding(markersText);
    if (grounding.screens.length === 0) return errorResult("No screens observed — the app may not have launched or is behind a wall. Try running QA/login first.");

    // 2) Author the flow from the goal, grounded in the observed screens.
    const userText = `${renderGroundingForPrompt(grounding)}\n\nGOAL: ${args.goal.trim()}\n\nEmit the Flow as JSON now.`;
    const mres = await callModel(backend, { system: FLOW_AUTHOR_SYSTEM, userText, maxTokens: 1500 });
    if (mres.error) return errorResult("Model call failed", { detail: mres.error });
    const parsed = parseGeneratedFlow(mres.text);
    if (!parsed) return errorResult("Model did not return a valid Flow", { raw: mres.text.slice(0, 500) });

    // 3) Ground-check + write.
    const ungrounded = ungroundedScreens(parsed.steps, grounding);
    const flow = { name: args.name || parsed.name, app: bundleId, steps: parsed.steps };
    const slug = flow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "generated-flow";
    const dir = path.join(repoRoot, ".tapp", "flows");
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, `${slug}.yml`);
    const yamlRes = await runCommand("python3", [path.join(scriptsDir, "flow_lib.py"), "to-yaml", JSON.stringify(flow)], { cwd: repoRoot });
    const yaml = (yamlRes.stdout || "").trim();
    if (!yaml) return errorResult("Failed to render flow YAML", { stderr: yamlRes.stderr });
    fs.writeFileSync(outPath, yaml + "\n");
    const rel = path.relative(repoRoot, outPath);

    const L = [`🤖 Generated flow **${flow.name}** from your goal → \`${rel}\``];
    L.push(`Grounded in ${grounding.screens.length} observed screen(s). ${ungrounded.length ? `⚠️ references unobserved: ${ungrounded.join(", ")} — review before relying on it.` : "All referenced screens were observed."}`);
    L.push("", "```yaml", yaml, "```");

    // 4) Optionally replay it now.
    if (args.run === true) {
      const flowLog = path.join(os.tmpdir(), `mcp-gen-${Date.now()}.log`);
      const runEnv = { ...process.env, FLOW_LOG: flowLog };
      if (isNonEmptyString(args.testEmail)) runEnv.OCQA_TEST_EMAIL = args.testEmail.trim();
      if (isNonEmptyString(args.testPassword)) runEnv.OCQA_TEST_PASSWORD = args.testPassword.trim();
      await runCommand("bash", [path.join(scriptsDir, "run-flow.sh"), outPath, bundleId], { cwd: repoRoot, timeoutMs: 10 * 60 * 1000, env: runEnv });
      if (fs.existsSync(flowLog)) {
        const rep = await runCommand("python3", [path.join(scriptsDir, "flow_lib.py"), "report", flowLog], { cwd: repoRoot });
        L.push("", "---", "", (rep.stdout || "").trim());
      }
    } else {
      L.push("", `Replay it: \`tapp_flow_run\` with \`flowPath: "${rel}"\`.`);
    }
    return richResult(L.join("\n"), { path: rel, flow, groundedScreens: grounding.screens.length, ungrounded });
  }

  if (name === "tapp_ui_tree") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    const wantsAndroid = isNonEmptyString(args.androidAppId);
    const wantsIos = isNonEmptyString(args.appBundleId);
    if (wantsAndroid && wantsIos) return errorResult("Provide appBundleId or androidAppId, not both");
    if (wantsAndroid) {
      try {
        const { AndroidDriver } = await import("./android-driver.js");
        const driver = new AndroidDriver({ appId: args.androidAppId.trim(), serial: args.androidSerial });
        await driver.ensureDevice();
        const snap = await driver.snapshot();
        return richResult(formatScreen(snap.screenTitle, snap.elements), { screenTitle: snap.screenTitle, elementCount: snap.elements.length, elements: snap.elements, platform: "android" });
      } catch (error) { return errorResult(error.message || String(error)); }
    }
    if (!isNonEmptyString(args.appBundleId)) return errorResult("appBundleId or androidAppId is required");

    const r = await captureUiTree(String(args.appBundleId).trim());
    if (r.error) return errorResult(r.error, r.details || {});
    return richResult(formatScreen(r.screenTitle, r.elements), {
      screenTitle: r.screenTitle,
      elementCount: r.elements.length,
      elements: r.elements,
      capture: r.capture,
    });
  }

  if (name === "tapp_screenshot") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    if (activeSession?.platform === "android") {
      try {
        const data = await activeSession.driver.screenshot();
        return { content: [
          { type: "text", text: `📸 Captured current Android screen — image/png, ~${Math.round(data.length / 1024)}KB` },
          { type: "image", data: data.toString("base64"), mimeType: "image/png" },
        ] };
      } catch (error) { return errorResult(error.message || String(error)); }
    }
    const maxWidth = Math.max(200, Math.min(1400, asInteger(args.maxWidth, 700)));
    const img = await captureScreenshotImage(maxWidth);
    if (img.error) return errorResult(img.error, { stderr: img.stderr });
    return {
      content: [
        { type: "text", text: `📸 Captured current screen — ${img.mimeType}, ~${Math.round(img.bytes / 1024)}KB` },
        { type: "image", data: img.data, mimeType: img.mimeType },
      ],
    };
  }

  if (name === "tapp_open_app") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    const wantsAndroid = isNonEmptyString(args.androidAppId);
    const wantsIos = isNonEmptyString(args.appBundleId);
    if (wantsAndroid === wantsIos) return errorResult("Provide exactly one of appBundleId or androidAppId");
    if (wantsAndroid) {
      try {
        const { AndroidDriver } = await import("./android-driver.js");
        const appId = args.androidAppId.trim();
        const driver = new AndroidDriver({ appId, serial: args.androidSerial });
        await driver.ensureDevice();
        if (isNonEmptyString(args.apkPath)) await driver.install(path.resolve(args.apkPath));
        const snap = await driver.launch({ clearData: args.clearData === true });
        const data = await driver.screenshot();
        await driver.forceStop().catch(() => {});
        return {
          content: [
            { type: "text", text: `🚀 Launched \`${appId}\` (Android)\n\n` + formatScreen(snap.screenTitle, snap.elements) },
            { type: "image", data: data.toString("base64"), mimeType: "image/png" },
          ],
          structuredContent: { platform: "android", screenTitle: snap.screenTitle, elementCount: snap.elements.length, elements: snap.elements },
        };
      } catch (error) {
        return errorResult(error.message || String(error));
      }
    }
    const maxWidth = Math.max(200, Math.min(1400, asInteger(args.maxWidth, 700)));
    const r = await openApp(String(args.appBundleId).trim(), explorationEnvFromArgs(args), maxWidth);
    if (r.error) return errorResult(r.error);
    const content = [];
    content.push({ type: "text", text: `🚀 Launched \`${String(args.appBundleId).trim()}\`\n\n` + formatScreen(r.screenTitle, r.elements) });
    if (r.img && !r.img.error) content.push({ type: "image", data: r.img.data, mimeType: r.img.mimeType });
    return { content, structuredContent: { screenTitle: r.screenTitle, elementCount: r.elements.length, elements: r.elements } };
  }

  if (name === "tapp_list_simulators") {
    const sims = await listSimulators();
    const list = sims.simulators || [];
    const booted = (sims.booted || []).map((s) => s.name);
    const L = [`### 📱 ${list.length} simulator${list.length === 1 ? "" : "s"}${booted.length ? ` · ${booted.length} booted` : ""}`, ""];
    for (const s of list.slice(0, 20)) {
      L.push(`- ${s.booted ? "🟢" : "⚪️"} **${s.name}** — ${s.runtime || "?"}${s.booted ? " · **booted**" : ""}  \`${s.udid}\``);
    }
    if (!booted.length) L.push("", "No simulator booted — `tapp_boot_simulator` to start one before QA.");
    return richResult(L.join("\n"), sims);
  }

  if (name === "tapp_boot_simulator") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;

    const target = isNonEmptyString(args.udid) ? args.udid.trim() : isNonEmptyString(args.name) ? args.name.trim() : "";
    if (!target) return errorResult("Provide udid or name");

    const res = await runCommand("xcrun", ["simctl", "boot", target], { timeoutMs: 2 * 60 * 1000 });
    const alreadyBooted = (res.stderr || "").includes("current state: Booted");
    const ok = res.code === 0 || alreadyBooted;
    if (ok) {
      await runCommand("xcrun", ["simctl", "bootstatus", target], { timeoutMs: 2 * 60 * 1000 });
    }
    if (ok) {
      const t = alreadyBooted ? "already booted" : "booted";
      return richResult(`📱 Simulator ${t}: \`${target}\``, { ok, target, alreadyBooted, code: res.code });
    }
    return richResult(`❌ Could not boot simulator \`${target}\``, { ok, target, alreadyBooted, code: res.code, stderr: res.stderr });
  }

  if (name === "tapp_install_app") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    const scheme = isNonEmptyString(args.scheme) ? args.scheme.trim() : "";
    if (!scheme) return errorResult("scheme is required");
    const project = isNonEmptyString(args.project) ? args.project.trim() : "";
    const workspace = isNonEmptyString(args.workspace) ? args.workspace.trim() : "";
    if (!project && !workspace) return errorResult("Provide project or workspace");
    const configuration = isNonEmptyString(args.configuration) ? args.configuration.trim() : "Debug";
    const sims = await listSimulators();
    const booted = (sims.booted || [])[0];
    if (!booted) return errorResult("No booted simulator. Call tapp_boot_simulator first.");
    const target = workspace || project;
    if (!fs.existsSync(target)) return errorResult("Project/workspace path not found", { target });

    const derived = `/tmp/tapp-target-${scheme.replace(/[^a-zA-Z0-9]/g, "")}`;
    const buildArgs = [
      "build",
      workspace ? "-workspace" : "-project", target,
      "-scheme", scheme,
      "-configuration", configuration,
      "-destination", `platform=iOS Simulator,id=${booted.udid}`,
      "-derivedDataPath", derived,
      "-sdk", "iphonesimulator",
    ];
    const build = await runCommand("xcodebuild", buildArgs, { cwd: path.dirname(target), timeoutMs: 25 * 60 * 1000 });
    if (build.code !== 0) return errorResult("Build failed", { stderr: (build.stderr || build.stdout || "").slice(-3000) });

    const productsDir = path.join(derived, "Build/Products", `${configuration}-iphonesimulator`);
    const app = fs.existsSync(productsDir) ? fs.readdirSync(productsDir).find((f) => f.endsWith(".app")) : null;
    if (!app) return errorResult("Built .app not found after build", { productsDir });
    const appPath = path.join(productsDir, app);
    // Clean install by default: uninstall first so the app's data + keychain-backed session are
    // cleared. Installing OVER an existing app leaves stale keychain items that Firebase Auth (etc.)
    // can't access ("An error occurred when accessing the keychain") and starts in a half-signed-in
    // state — a clean uninstall gives a fresh signed-out app. Opt out with cleanInstall:false.
    const cleanInstall = args.cleanInstall !== false;
    const bidRes = await runCommand("/usr/libexec/PlistBuddy", ["-c", "Print CFBundleIdentifier", path.join(appPath, "Info.plist")]);
    const bundleId = (bidRes.stdout || "").trim();
    if (cleanInstall && bundleId) {
      await runCommand("xcrun", ["simctl", "terminate", booted.udid, bundleId], { timeoutMs: 30_000 });
      await runCommand("xcrun", ["simctl", "uninstall", booted.udid, bundleId], { timeoutMs: 60_000 });
    }
    const inst = await runCommand("xcrun", ["simctl", "install", booted.udid, appPath], { timeoutMs: 3 * 60 * 1000 });
    if (inst.code !== 0) return errorResult("Install failed", { stderr: inst.stderr });
    const L = [
      `✅ Installed app on **${booted.name}**`,
      "",
      `Bundle: \`${bundleId || "(unknown)"}\``,
      `App: \`${appPath}\``,
      `DerivedData: \`${derived}\``,
    ];
    if (cleanInstall) L.push("Mode: clean install");
    return richResult(L.join("\n"), { ok: true, installed: appPath, bundleId: bundleId || undefined, cleanInstall, simulator: booted.name, derivedDataPath: derived });
  }

  if (name === "tapp_session_start") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    const ios = isNonEmptyString(args.appBundleId);
    const android = isNonEmptyString(args.androidAppId);
    if (ios === android) return errorResult("Provide exactly one of appBundleId or androidAppId");
    const target = ios ? args.appBundleId.trim() : args.androidAppId.trim();
    const r = ios
      ? await startSession(target, explorationEnvFromArgs(args))
      : await startAndroidSession(target, { serial: args.androidSerial, apkPath: args.apkPath, clearData: args.clearData !== false, testEmail: args.testEmail, testPassword: args.testPassword });
    if (r.error) return errorResult(r.error);
    return richResult(
      `🎬 Session started — \`${target}\` (${ios ? "iOS" : "Android"})\n\n` + formatScreen(r.screenTitle, r.elements) +
        `\n\nDrive it with \`tapp_session_act\` (tap · type · swipe · back · wait · tree · screenshot).`,
      r
    );
  }

  if (name === "tapp_session_act") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    const action = isNonEmptyString(args.action) ? args.action.trim().toLowerCase() : "";
    const allowed = new Set(["tap", "type", "swipe", "back", "wait", "tree", "screenshot", "login"]);
    if (!allowed.has(action)) return errorResult("Invalid action", { allowed: Array.from(allowed), received: args.action ?? null });
    const cmd = { action };
    if (isNonEmptyString(args.id)) cmd.id = args.id.trim();
    if (typeof args.x === "number") cmd.x = args.x;
    if (typeof args.y === "number") cmd.y = args.y;
    if (typeof args.text === "string") cmd.text = args.text;
    if (isNonEmptyString(args.direction)) cmd.direction = args.direction.trim();
    if (isNonEmptyString(args.label)) cmd.label = args.label.trim();
    if (action === "login") {
      if (isNonEmptyString(args.email)) cmd.email = args.email.trim();
      if (isNonEmptyString(args.password)) cmd.password = args.password;
    }
    if (action === "wait") cmd.timeoutMs = Math.max(500, Math.min(60_000, asInteger(args.timeoutMs, 5000)));
    const r = await sessionAct(cmd);
    if (r.error) return errorResult(r.error);
    // Action-word recap: what was done → where we are now.
    const tgt = cmd.id || cmd.label || cmd.text || cmd.direction || "";
    const verb = { tap: "👆 Tapped", type: "⌨️ Typed", swipe: "↔️ Swiped", back: "◀️ Went back", wait: "⏳ Waited for", tree: "🌳 Inspected", screenshot: "📸 Captured", login: "🔐 Signed in" }[action] || action;
    const ok = r.status === "ok";
    // For `type`, say WHERE the text landed and never echo the text itself (it may be a password).
    const did = action === "type"
      ? ok ? `⌨️ Typed into \`${r.typedInto || cmd.id || "focused field"}\`` : `⌨️ Type \`${cmd.id || "?"}\``
      : action === "login"
      ? ok ? "🔐 Signed in" : "🔐 Sign-in"
      : tgt ? `${verb} \`${tgt}\`` : verb;
    const detailNote = !ok && r.detail ? ` — ${r.detail}` : "";
    const head = `${did} — ${ok ? "ok" : `⚠️ ${r.status}${detailNote}`} → now on **${r.screenTitle || "Unknown"}**`;
    const rec = typeof r.recordedSteps === "number" ? `\n\n🔴 Recording — ${r.recordedSteps} step(s). \`tapp_flow_save\` to keep it as a test.` : "";
    return richResult(head + "\n\n" + formatScreen(r.screenTitle, r.elements) + rec, r);
  }

  if (name === "tapp_flow_save") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    try {
      const saved = await saveInteractiveSessionFlow({ projectDir:repoRoot, name:args.name, addFinalAssertion:args.addFinalAssertion !== false, replace:args.replace === true });
      const text = `💾 Saved flow **${saved.flow.name}** → \`${saved.path}\` (${saved.flow.steps.length} steps)\n\n\`\`\`yaml\n${saved.yaml}\n\`\`\`\n\nReplay it anytime: \`tapp_flow_run\` with \`flowPath: "${saved.path}"\`.`;
      return richResult(text, { path:saved.path, flow:saved.flow });
    } catch (error) {
      return errorResult(error.message || String(error), error.code ? { code:error.code } : {});
    }
  }

  if (name === "tapp_session_end") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    const recorded = activeSession && activeSession.recording ? activeSession.recording.length : 0;
    await endSession();
    const hint = recorded > 0 ? ` (${recorded} recorded step(s) discarded — use tapp_flow_save before ending to keep them)` : "";
    return richResult(`🏁 Session ended.${hint}`, { ok: true, recordedStepsDiscarded: recorded });
  }

  return errorResult(`Unknown tool: ${name}`);
});

export async function startMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Self-start only when executed directly (`node src/index.js`, `npm run start`/`dev`).
// bin/tapp.js imports this module — for `tapp mcp` it calls startMcpServer() explicitly,
// while the CLI verbs (qa/open/tree/shot) use the exported engine without starting a server.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await startMcpServer();
}

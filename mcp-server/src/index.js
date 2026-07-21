import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { parseOcqaMarkers, buildQaReport, computeRegression } from "./report.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const scriptsDir = path.join(repoRoot, "scripts");
// AUTOTAP_HOME (set by the `tapp` CLI when running as an installed npm package) redirects
// all writable output to a user dir; unset (repo dev flow) captures stay in the repo.
const autotapHome = (process.env.AUTOTAP_HOME || "").trim();
const capturesDir = autotapHome ? path.join(autotapHome, "captures") : path.join(repoRoot, "captures");
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
      reason: "Provide valid authToken when AUTOTAP_MCP_TOKEN is set",
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
async function ensureBootedSim({ autoBoot = false } = {}) {
  const sims = await listSimulators();
  if (sims.booted && sims.booted.length) return { booted: sims.booted[0] };
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
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const cmdPath = `/tmp/ocqa-session-${token}-cmd.json`;
  const resultPath = `/tmp/ocqa-session-${token}-res.json`;
  for (const p of [cmdPath, resultPath]) { try { fs.rmSync(p, { force: true }); } catch {} }

  const captureScript = path.join(scriptsDir, "quick-capture.sh");
  const proc = spawn("bash", [captureScript, "session", bundleId], {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv, OCQA_SESSION_CMD_PATH: cmdPath, OCQA_SESSION_RESULT_PATH: resultPath, OCQA_SESSION_TIMEOUT: "1800" },
  });
  activeSession = {
    proc, bundleId, seq: 0, cmdPath, resultPath, latestTree: null, treeVersion: 0, buffer: "", ready: false, ended: false,
    // Always-on recorder: each act appends a Flow step; tapp_flow_save snapshots it to a file.
    recording: [],
    creds: { email: extraEnv.OCQA_TEST_EMAIL || "", password: extraEnv.OCQA_TEST_PASSWORD || "" },
    lastScreen: null,
  };
  proc.stdout.on("data", (d) => consumeSessionStdout(String(d)));
  proc.stderr.on("data", () => {});
  proc.on("close", () => { if (activeSession && activeSession.proc === proc) activeSession.ended = true; });

  const deadline = Date.now() + 240_000; // build + launch can take a few minutes on first run
  while (!activeSession.ready && Date.now() < deadline && !activeSession.ended) await sleep(300);
  if (activeSession.ended) { activeSession = null; return { error: "Session process exited before it became ready (build/launch failed?)." }; }
  if (!activeSession.ready) { return { error: "Session did not become ready within the time limit." }; }

  const td = Date.now() + 10_000;
  while (!activeSession.latestTree && Date.now() < td) await sleep(200);
  activeSession.lastScreen = treeSnapshot().screenTitle;
  return { ok: true, ...treeSnapshot() };
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
  activeSession.seq += 1;
  const seq = activeSession.seq;
  const beforeVer = activeSession.treeVersion;
  const tmp = activeSession.cmdPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ seq, ...cmd }));
  fs.renameSync(tmp, activeSession.cmdPath); // atomic so the harness never reads a partial command

  // A `wait` can block in the harness up to its own timeout — give the ack poll enough headroom.
  let status = "timeout";
  const ackBudget = cmd.action === "wait" ? (cmd.timeoutMs || 5000) + 10_000 : 30_000;
  const deadline = Date.now() + ackBudget;
  while (Date.now() < deadline && !activeSession.ended) {
    await sleep(150);
    try {
      const res = JSON.parse(fs.readFileSync(activeSession.resultPath, "utf8"));
      if (res.seq === seq) { status = res.status; break; }
    } catch {}
  }
  // Give the post-action tree a moment to arrive.
  const td = Date.now() + 5_000;
  while (activeSession.treeVersion === beforeVer && Date.now() < td && !activeSession.ended) await sleep(150);
  const snap = treeSnapshot();
  if (status === "ok") recordStep(cmd, snap); // record only successful acts
  return { status, ...snap, recordedSteps: activeSession ? activeSession.recording.length : 0 };
}

async function endSession() {
  if (!activeSession) return { ok: true, note: "no session" };
  const s = activeSession;
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

// Fast "just show me a screen": launch the app fresh (optionally bypassing login), grab a screenshot
// while it's on screen, return the tree too, then close it. No exploration. Uses the session
// machinery only to keep the app alive long enough to photograph it.
async function openApp(bundleId, extraEnv, maxWidth) {
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
  const hardDeadline = Date.now() + (timeout + 240) * 1000;

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
async function captureScreenshotImage(maxWidth) {
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
function resolveModelBackend() {
  const token = (process.env.AUTOTAP_SUBSCRIPTION_TOKEN || "").trim();
  if (token) {
    const base = (process.env.AUTOTAP_PROXY_URL || "http://localhost:8787").replace(/\/$/, "");
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
  const body = JSON.stringify({ model: model || process.env.AUTOTAP_FLOW_MODEL || "claude-sonnet-4-6", max_tokens: maxTokens, system, messages: [{ role: "user", content: userText }] });
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
function explorationEnvFromArgs(args) {
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
  if (args.inputOverrides && typeof args.inputOverrides === "object" && !Array.isArray(args.inputOverrides)) {
    const entries = Object.entries(args.inputOverrides).filter(
      ([k, v]) => typeof k === "string" && typeof v === "string" && k.trim() && v.length > 0
    );
    if (entries.length) env.OCQA_INPUT_OVERRIDES_JSON = JSON.stringify(Object.fromEntries(entries.map(([k, v]) => [k.trim(), v])));
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
const VERDICT_BADGE = { ready: "🟢 SHIP-READY", caution: "🟡 CAUTION", blocked: "🔴 BLOCKED" };

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
function formatQaReport(report, { regression, inputHint, timedOut, bundleId, aiConfigured, reportHtml } = {}) {
  const c = report.findingCounts || {};
  const badge = VERDICT_BADGE[report.verdict] || report.verdict;
  const sevBits = ["critical", "high", "medium", "low"]
    .map((k) => (c[k] ? `${SEV[k]} ${c[k]} ${k}` : null))
    .filter(Boolean)
    .join(", ");
  const L = [];
  L.push(`### 🧪 QA complete — ${badge} · confidence ${report.confidence}/100${bundleId ? `\n\`${bundleId}\`` : ""}`);
  L.push("");
  L.push(report.headline);
  L.push("");
  L.push(`**Coverage** — ${report.screensExplored} screens · ${report.actionsPerformed} actions${timedOut ? " · ⏱️ hit time limit" : ""}`);
  if (reportHtml) L.push(`**Evidence** — 📄 ${reportHtml} (screenshots of every screen + findings, shareable)`);
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
      L.push("> 💡 Want a root cause + suggested fix for each finding? Set `ANTHROPIC_API_KEY` and re-run — analysis appears inline.");
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
    }
  }
  const next = [];
  if (report.findings && report.findings.length) next.push("open a flagged screen with `tapp_open_app`");
  next.push("re-run with `baselineFindings` to gate a fix");
  next.push("drive it step-by-step via `tapp_session_start`");
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
function formatScreen(screenTitle, elements) {
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

const server = new Server(
  {
    name: "tapp-mcp",
    version: "0.7.0",
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
      title: "Build Tapp",
      description: "Build Tapp app locally (optionally clean and include harness)",
      inputSchema: {
        type: "object",
        properties: {
          authToken: {
            type: "string",
            description: "Required when AUTOTAP_MCP_TOKEN is set",
          },
          clean: { type: "boolean", default: false },
          harness: { type: "boolean", default: false },
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
            description: "Required when AUTOTAP_MCP_TOKEN is set",
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
        "Run autonomous QA against an installed iOS app on a BOOTED simulator (appBundleId) OR a web app " +
        "in a real browser (url — beta, requires Playwright installed) and return a structured " +
        "ship/no-ship verdict. Use ONLY when the user wants a QA assessment / to find bugs / a verdict — this " +
        "runs for MINUTES exploring the whole app. Do NOT use it just to view, screenshot, or reach a specific " +
        "screen — use tapp_open_app (launch + screenshot) or a session for that. Tapp explores the app " +
        "like a tester (taps, types, navigates, scrolls) and detects real issues — crashes, dead buttons, failed sign-ins, error screens, " +
        "stuck/hung screens; on web also uncaught JS exceptions, failed/5xx requests, broken links and assets. " +
        "Returns {verdict: ready|caution|blocked, confidence, headline, screensExplored, " +
        "actionsPerformed, findings:[{type,severity,category,title,screen}]}. The verdict has a coverage floor: " +
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
          authToken: { type: "string", description: "Required when AUTOTAP_MCP_TOKEN is set" },
          appBundleId: { type: "string", description: "iOS: bundle id of the installed app to test, e.g. com.acme.app. Provide exactly one of appBundleId | url." },
          url: { type: "string", description: "Web (beta): URL of the app to explore in a real browser (same-origin only; your own app/staging). Provide exactly one of appBundleId | url." },
          maxActions: { type: "integer", minimum: 1, maximum: 1000, default: 60, description: "Exploration action budget" },
          timeout: { type: "integer", minimum: 30, maximum: 3600, default: 600, description: "Max wall-clock seconds" },
          testEmail: { type: "string", description: "Email for the login preamble, if the app has a sign-in" },
          testPassword: { type: "string", description: "Password for the login preamble" },
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
      name: "tapp_flow_run",
      title: "Run a deterministic E2E flow",
      description:
        "Replay a deterministic, authored end-to-end test (a Flow) against an installed app on the booted " +
        "simulator, and return a scannable pass/fail report. A Flow is a list of steps + assertions " +
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
          authToken: { type: "string", description: "Required when AUTOTAP_MCP_TOKEN is set" },
          flow: {
            type: "object",
            description:
              "Inline Flow: {name, app, steps:[...], vars?}. Example: {name:'login', app:'com.acme.app', steps:[{tap:'Sign In'}, {type:{field:'Email', value:'$TEST_EMAIL'}}, {tap:'Continue'}, {assert_screen:'Home'}]}",
          },
          flowPath: { type: "string", description: "Alternative to `flow`: repo-relative path to a .yml/.json Flow (e.g. .autotap/flows/login.yml)" },
          appBundleId: { type: "string", description: "Overrides the flow's `app:` field" },
          testEmail: { type: "string", description: "Value for $TEST_EMAIL" },
          testPassword: { type: "string", description: "Value for $TEST_PASSWORD" },
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
        "screens/controls that were actually observed. Saves it to .autotap/flows/<name>.yml and returns the " +
        "YAML for review (optionally runs it). Needs a model backend (Tapp subscription token or " +
        "ANTHROPIC_API_KEY). Use this to bootstrap a test you then refine; use tapp_flow_run to replay it.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when AUTOTAP_MCP_TOKEN is set" },
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
        "writes them to .autotap/flows/<name>.yml with wait_for steps auto-inserted on screen changes and a " +
        "final assert_screen checkpoint. Typed credentials are templated to $TEST_EMAIL/$TEST_PASSWORD so the " +
        "flow is shareable. The saved flow replays with tapp_flow_run. Do it once → it's a test.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when AUTOTAP_MCP_TOKEN is set" },
          name: { type: "string", description: "Human name for the flow, e.g. 'Sign in and reach Home'" },
          addFinalAssertion: { type: "boolean", default: true, description: "Append assert_screen for the final screen as a checkpoint" },
        },
        required: ["name"],
      },
    },
    {
      name: "tapp_ui_tree",
      title: "Inspect screen (a11y tree)",
      description:
        "Dump the accessibility (UI) tree of the current screen of an installed app on the booted simulator — " +
        "the inspection primitive (like Playwright's snapshot). Returns {screenTitle, elements:[{type,id,label," +
        "enabled,hittable,x,y,w,h}]}. Use it to see what's on screen before/after acting.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when AUTOTAP_MCP_TOKEN is set" },
          appBundleId: { type: "string", description: "Bundle id of the installed app" },
        },
        required: ["appBundleId"],
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
          authToken: { type: "string", description: "Required when AUTOTAP_MCP_TOKEN is set" },
          maxWidth: { type: "integer", minimum: 200, maximum: 1400, default: 700, description: "Max image width in px (downscaled to keep payload small)" },
        },
      },
    },
    {
      name: "tapp_open_app",
      title: "Launch app + screenshot",
      description:
        "Launch an installed app on the booted simulator and return a SCREENSHOT of the screen it lands on " +
        "(plus the accessibility tree) — with NO exploration. This is the fast way (seconds) to just SEE a " +
        "screen. Use this — NOT tapp_run_qa — whenever the user wants to view or screenshot a screen. Pass " +
        "appLaunchArgs like [\"--uitesting\"] to bypass login and land on the home screen, and appLaunchEnv for " +
        "a backend override. The app is launched fresh and closed afterward. (To screenshot a screen reached by " +
        "real login or several taps, use a session instead and call tapp_screenshot along the way.)",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when AUTOTAP_MCP_TOKEN is set" },
          appBundleId: { type: "string", description: "Bundle id of the installed app" },
          appLaunchArgs: { type: "array", items: { type: "string" }, description: "Launch args, e.g. [\"--uitesting\"] to bypass login" },
          appLaunchEnv: { type: "object", additionalProperties: { type: "string" }, description: "Launch env, e.g. {\"UI_TEST_BACKEND\": \"staging\"}" },
          maxWidth: { type: "integer", minimum: 200, maximum: 1400, default: 700, description: "Max screenshot width in px" },
        },
        required: ["appBundleId"],
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
          authToken: { type: "string", description: "Required when AUTOTAP_MCP_TOKEN is set" },
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
          authToken: { type: "string", description: "Required when AUTOTAP_MCP_TOKEN is set" },
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
        "Start a PERSISTENT interactive session against an installed app on the booted simulator. The app " +
        "launches once and stays up, so you can drive a Playwright-style tap → inspect loop without a cold " +
        "launch per action. Returns the initial screen {screenTitle, elements[]}. Drive it with " +
        "tapp_session_act and finish with tapp_session_end. Only one session at a time. Starts from a " +
        "fresh launch. Use appLaunchArgs/appLaunchEnv for apps that need a backend override or login bypass. " +
        "When you reach a screen with input fields and don't have values for them, ASK THE USER what to type " +
        "(offer defaults/skip) before typing — the session does not prompt on its own.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when AUTOTAP_MCP_TOKEN is set" },
          appBundleId: { type: "string", description: "Bundle id of the installed app to drive" },
          testEmail: { type: "string", description: "Email available to the app/harness, if it has a sign-in" },
          testPassword: { type: "string", description: "Password available to the app/harness" },
          appLaunchArgs: { type: "array", items: { type: "string" }, description: "Launch arguments, e.g. [\"--uitesting\"]" },
          appLaunchEnv: { type: "object", additionalProperties: { type: "string" }, description: "Launch environment, e.g. {\"UI_TEST_BACKEND\": \"staging\"}" },
        },
        required: ["appBundleId"],
      },
    },
    {
      name: "tapp_session_act",
      title: "Session: tap/type/inspect",
      description:
        "Perform ONE action in the active interactive session and get the resulting screen back (the fresh " +
        "accessibility tree). Actions: 'tap' (by `id` = accessibility identifier or visible/partial label, or " +
        "by `x`/`y` coordinates), 'type' (`text`, optional `id` to target a field), 'swipe' (`direction`), " +
        "'back', 'wait' (block until an element with `id`/`text` appears, up to `timeoutMs` — use after " +
        "navigation/loading), 'tree' (just re-inspect without acting), 'screenshot'. Returns {status, " +
        "screenTitle, elements[]}; status is 'not_found'/'timeout' when an element wasn't located.",
      inputSchema: {
        type: "object",
        properties: {
          authToken: { type: "string", description: "Required when AUTOTAP_MCP_TOKEN is set" },
          action: { type: "string", enum: ["tap", "type", "swipe", "back", "wait", "tree", "screenshot"] },
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
        properties: { authToken: { type: "string", description: "Required when AUTOTAP_MCP_TOKEN is set" } },
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

    const buildScript = path.join(scriptsDir, "deploy-and-build.sh");
    if (!fs.existsSync(buildScript)) {
      return errorResult("Build script not found", { buildScript });
    }

    const cmdArgs = [];
    if (asBoolean(args.clean, false)) cmdArgs.push("--clean");
    if (asBoolean(args.harness, false)) cmdArgs.push("--harness");

    const startedAt = Date.now();
    const result = await runCommand("bash", [buildScript, ...cmdArgs], {
      cwd: repoRoot,
      timeoutMs: 30 * 60 * 1000,
    });
    const ok = result.code === 0;
    const what = ["Tapp app", asBoolean(args.harness, false) ? "+ harness" : null].filter(Boolean).join(" ");
    let text;
    if (ok) {
      text = `🔨 Built ${what} in ${fmtDuration(Date.now() - startedAt)}${asBoolean(args.clean, false) ? " (clean)" : ""} ✅`;
    } else {
      const errs = (result.stdout + "\n" + result.stderr).split("\n").filter((l) => /error:/i.test(l)).slice(0, 6);
      text = `❌ Build failed${result.timedOut ? " (timed out)" : ""}\n\n` + (errs.length ? errs.map((e) => "- " + e.trim()).join("\n") : "```\n" + (result.stderr || result.stdout).slice(-1200) + "\n```");
    }
    return richResult(text, { code: result.code, ok, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr });
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
    if (wantsWeb === isNonEmptyString(args.appBundleId)) {
      return errorResult("Provide exactly one of appBundleId (iOS) or url (web beta)");
    }

    // Web (beta): same judgment layer, different driver — the Playwright crawler emits
    // OCQA markers into a normal capture dir, and everything downstream is shared.
    if (wantsWeb) {
      const actions = Math.max(1, Math.min(1000, asInteger(args.maxActions, 60)));
      const timeout = Math.max(30, Math.min(3600, asInteger(args.timeout, 600)));
      const id = "web-" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14).replace(/^(\d{8})/, "$1-");
      const outDir = path.join(capturesDir, id);
      const progressToken = request.params && request.params._meta ? request.params._meta.progressToken : undefined;
      let webResult;
      try {
        const { exploreWeb } = await import("./web-explorer.js");
        webResult = await exploreWeb({
          url: args.url.trim(),
          maxActions: actions,
          timeoutSec: timeout,
          outDir,
          testEmail: isNonEmptyString(args.testEmail) ? args.testEmail.trim() : "",
          testPassword: isNonEmptyString(args.testPassword) ? args.testPassword.trim() : "",
          onProgress: (p) => {
            if (progressToken === undefined) return;
            server.notification({
              method: "notifications/progress",
              params: { progressToken, progress: p.action || 0, total: p.max || actions, message: `🔍 Exploring… ${p.action}/${p.max || actions} actions · ${p.states} pages reached` },
            }).catch(() => {});
          },
        });
      } catch (err) {
        return errorResult(String(err.message || err));
      }
      const report = buildQaReport(webResult.markersPath);
      if (!report) return errorResult("Web exploration produced no markers", { capture: { id, path: outDir } });
      const backend = resolveModelBackend();
      if (backend && report.findings.length) {
        const { enrichFindings } = await import("./enrich.js");
        await enrichFindings(report.findings, { backend, callModel, screens: report.screens, appLabel: args.url.trim() });
      }
      const regression = computeRegression(report.findings, args.baselineFindings);
      let reportHtml = null;
      try {
        const { writeHtmlReport } = await import("./html-report.js");
        reportHtml = writeHtmlReport(outDir, { report, label: args.url.trim() });
      } catch { /* evidence page is best-effort */ }
      const structured = { ...report, regression, platform: "web", reportHtml, capture: { id, path: outDir, relativePath: path.relative(repoRoot, outDir) } };
      return richResult(formatQaReport(report, { regression, bundleId: args.url.trim(), aiConfigured: !!backend, reportHtml }), structured);
    }

    const captureScript = path.join(scriptsDir, "quick-capture.sh");
    if (!fs.existsSync(captureScript)) return errorResult("Capture script not found", { captureScript });

    // run_qa runs for minutes anyway — auto-boot rather than bounce the user.
    const sim = await ensureBootedSim({ autoBoot: true });
    if (sim.error) return errorResult(sim.error);

    const actions = Math.max(1, Math.min(1000, asInteger(args.maxActions, 60)));
    const timeout = Math.max(30, Math.min(3600, asInteger(args.timeout, 600)));

    const env = explorationEnvFromArgs(args);

    // Stream live progress to the client (if it passed a progressToken) as the harness explores.
    const progressToken = request.params && request.params._meta ? request.params._meta.progressToken : undefined;
    let lastProgress = null;
    const onProgress = (p) => {
      lastProgress = p;
      const total = p.max || actions;
      if (progressToken === undefined) return;
      server
        .notification({
          method: "notifications/progress",
          params: { progressToken, progress: p.action || 0, total, message: `🔍 Exploring… ${p.action}/${total} actions · ${p.states} screens reached` },
        })
        .catch(() => {});
    };

    const { created, timedOut } = await runExploreStreaming(String(args.appBundleId).trim(), actions, timeout, env, onProgress);
    if (!created) {
      return errorResult("Exploration produced no capture run", { timedOut, lastProgress });
    }

    const report = buildQaReport(path.join(created.path, "ocqa-markers.txt"));
    if (!report) {
      return errorResult("No markers parsed from exploration (the app may not have launched)", {
        capture: { id: created.id, relativePath: created.relativePath },
      });
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
    // Post-run AI enrichment (additive, never changes the verdict) when a key is present.
    const backend = resolveModelBackend();
    if (backend && report.findings.length) {
      const { enrichFindings } = await import("./enrich.js");
      await enrichFindings(report.findings, { backend, callModel, screens: report.screens, appLabel: String(args.appBundleId).trim() });
    }
    // Cross-run regression vs. a caller-supplied baseline (the CI gate).
    const regression = computeRegression(report.findings, args.baselineFindings);
    const bundleId = String(args.appBundleId).trim();
    let reportHtml = null;
    try {
      const { writeHtmlReport } = await import("./html-report.js");
      reportHtml = writeHtmlReport(created.path, { report, label: bundleId });
    } catch { /* evidence page is best-effort */ }
    const structured = {
      ...report,
      regression,
      inputHint,
      reportHtml,
      capture: { id: created.id, path: created.path, relativePath: created.relativePath },
      timedOut,
      autoBooted: sim.autoBooted || false,
    };
    return richResult(formatQaReport(report, { regression, inputHint, timedOut, bundleId, aiConfigured: !!backend, reportHtml }), structured);
  }

  if (name === "tapp_flow_run") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;

    // Resolve the flow file: inline `flow` object → temp .json, else repo-relative `flowPath`.
    let flowFile;
    if (args.flow && typeof args.flow === "object") {
      flowFile = path.join(os.tmpdir(), `mcp-flow-${Date.now()}.json`);
      fs.writeFileSync(flowFile, JSON.stringify(args.flow));
    } else if (isNonEmptyString(args.flowPath)) {
      const p = path.resolve(repoRoot, args.flowPath.trim());
      if (!p.startsWith(repoRoot)) return errorResult("flowPath must be inside the repo");
      if (!fs.existsSync(p)) return errorResult("Flow file not found", { flowPath: args.flowPath });
      flowFile = p;
    } else {
      return errorResult("Provide `flow` (inline) or `flowPath`");
    }

    const runFlow = path.join(scriptsDir, "run-flow.sh");
    const flowLog = path.join(os.tmpdir(), `mcp-flow-${Date.now()}.log`);
    const runEnv = { ...process.env, FLOW_LOG: flowLog };
    if (isNonEmptyString(args.testEmail)) runEnv.OCQA_TEST_EMAIL = args.testEmail.trim();
    if (isNonEmptyString(args.testPassword)) runEnv.OCQA_TEST_PASSWORD = args.testPassword.trim();
    const cmdArgs = [runFlow, flowFile];
    if (isNonEmptyString(args.appBundleId)) cmdArgs.push(args.appBundleId.trim());

    const run = await runCommand("bash", cmdArgs, { cwd: repoRoot, timeoutMs: 10 * 60 * 1000, env: runEnv });
    if (!fs.existsSync(flowLog)) {
      return errorResult("Flow run produced no log (harness build / launch failure?)", { stderr: run.stderr, stdout: run.stdout });
    }
    // Structured report from the harness markers, plus the scannable text the runner already renders.
    const jsonRes = await runCommand("python3", [path.join(scriptsDir, "flow_lib.py"), "report", "--json", flowLog], { cwd: repoRoot });
    let structured = null;
    try { structured = JSON.parse(jsonRes.stdout.trim()); } catch { /* fall through */ }
    const textRes = await runCommand("python3", [path.join(scriptsDir, "flow_lib.py"), "report", flowLog], { cwd: repoRoot });
    const text = (textRes.stdout || "").trim() || run.stdout;
    return richResult(text, structured || { raw: run.stdout });
  }

  if (name === "tapp_flow_generate") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    if (!isNonEmptyString(args.goal)) return errorResult("goal is required");
    if (!isNonEmptyString(args.appBundleId)) return errorResult("appBundleId is required");
    const backend = resolveModelBackend();
    if (!backend) return errorResult("AI-generate needs a model backend — set an Tapp subscription token (AUTOTAP_SUBSCRIPTION_TOKEN) or ANTHROPIC_API_KEY.");
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
    const dir = path.join(repoRoot, ".autotap", "flows");
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
    if (!isNonEmptyString(args.appBundleId)) return errorResult("appBundleId is required");

    const captureScript = path.join(scriptsDir, "quick-capture.sh");
    const before = new Set(listCaptureRuns(50).map((r) => r.id));
    const result = await runCommand("bash", [captureScript, "tree", String(args.appBundleId).trim()], {
      cwd: repoRoot,
      timeoutMs: 5 * 60 * 1000,
    });
    const created = listCaptureRuns(50).find((r) => !before.has(r.id));
    if (!created) return errorResult("UI tree produced no capture", { stderr: result.stderr });

    const treePath = path.join(created.path, "uitree.json");
    if (!fs.existsSync(treePath) || fs.statSync(treePath).size === 0) {
      return errorResult("No accessibility tree was produced (is the app installed + foregrounded?)", {
        capture: { id: created.id, relativePath: created.relativePath },
        stderr: result.stderr,
      });
    }
    let tree;
    try {
      tree = JSON.parse(fs.readFileSync(treePath, "utf8"));
    } catch {
      return errorResult("uitree.json was not valid JSON", { treePath });
    }
    const elements = tree.elements || [];
    return richResult(formatScreen(tree.screenTitle, elements), {
      screenTitle: tree.screenTitle ?? null,
      elementCount: elements.length,
      elements,
      capture: { id: created.id, relativePath: created.relativePath },
    });
  }

  if (name === "tapp_screenshot") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
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
    if (!isNonEmptyString(args.appBundleId)) return errorResult("appBundleId is required");
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
      "CODE_SIGNING_ALLOWED=NO",
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
    if (!isNonEmptyString(args.appBundleId)) return errorResult("appBundleId is required");
    const r = await startSession(String(args.appBundleId).trim(), explorationEnvFromArgs(args));
    if (r.error) return errorResult(r.error);
    return richResult(
      `🎬 Session started — \`${String(args.appBundleId).trim()}\`\n\n` + formatScreen(r.screenTitle, r.elements) +
        `\n\nDrive it with \`tapp_session_act\` (tap · type · swipe · back · wait · tree · screenshot).`,
      r
    );
  }

  if (name === "tapp_session_act") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    const action = isNonEmptyString(args.action) ? args.action.trim().toLowerCase() : "";
    const allowed = new Set(["tap", "type", "swipe", "back", "wait", "tree", "screenshot"]);
    if (!allowed.has(action)) return errorResult("Invalid action", { allowed: Array.from(allowed), received: args.action ?? null });
    const cmd = { action };
    if (isNonEmptyString(args.id)) cmd.id = args.id.trim();
    if (typeof args.x === "number") cmd.x = args.x;
    if (typeof args.y === "number") cmd.y = args.y;
    if (typeof args.text === "string") cmd.text = args.text;
    if (isNonEmptyString(args.direction)) cmd.direction = args.direction.trim();
    if (isNonEmptyString(args.label)) cmd.label = args.label.trim();
    if (action === "wait") cmd.timeoutMs = Math.max(500, Math.min(60_000, asInteger(args.timeoutMs, 5000)));
    const r = await sessionAct(cmd);
    if (r.error) return errorResult(r.error);
    // Action-word recap: what was done → where we are now.
    const tgt = cmd.id || cmd.label || cmd.text || cmd.direction || "";
    const verb = { tap: "👆 Tapped", type: "⌨️ Typed", swipe: "↔️ Swiped", back: "◀️ Went back", wait: "⏳ Waited for", tree: "🌳 Inspected", screenshot: "📸 Captured" }[action] || action;
    const did = tgt ? `${verb} ${action === "type" ? `"${tgt}"` : `\`${tgt}\``}` : verb;
    const ok = r.status === "ok";
    const head = `${did} — ${ok ? "ok" : `⚠️ ${r.status}`} → now on **${r.screenTitle || "Unknown"}**`;
    const rec = typeof r.recordedSteps === "number" ? `\n\n🔴 Recording — ${r.recordedSteps} step(s). \`tapp_flow_save\` to keep it as a test.` : "";
    return richResult(head + "\n\n" + formatScreen(r.screenTitle, r.elements) + rec, r);
  }

  if (name === "tapp_flow_save") {
    const unauthorized = ensureAuthorized(args);
    if (unauthorized) return unauthorized;
    if (!activeSession || activeSession.ended) return errorResult("No active session to save. Start one with tapp_session_start and drive it first.");
    if (!isNonEmptyString(args.name)) return errorResult("name is required");
    const steps = [...(activeSession.recording || [])];
    if (steps.length === 0) return errorResult("Nothing recorded yet — perform some session_act steps first.");
    if (args.addFinalAssertion !== false && activeSession.lastScreen) {
      const last = steps[steps.length - 1] || {};
      if (!("assert_screen" in last)) steps.push({ assert_screen: activeSession.lastScreen });
    }
    const flow = { name: args.name.trim(), app: activeSession.bundleId, steps };
    const slug = args.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "flow";
    const dir = path.join(repoRoot, ".autotap", "flows");
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, `${slug}.yml`);
    const yamlRes = await runCommand("python3", [path.join(scriptsDir, "flow_lib.py"), "to-yaml", JSON.stringify(flow)], { cwd: repoRoot });
    const yaml = (yamlRes.stdout || "").trim();
    if (!yaml) return errorResult("Failed to render flow YAML", { stderr: yamlRes.stderr });
    fs.writeFileSync(outPath, yaml + "\n");
    const rel = path.relative(repoRoot, outPath);
    const text = `💾 Saved flow **${flow.name}** → \`${rel}\` (${steps.length} steps)\n\n\`\`\`yaml\n${yaml}\n\`\`\`\n\nReplay it anytime: \`tapp_flow_run\` with \`flowPath: "${rel}"\`.`;
    return richResult(text, { path: rel, flow });
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

const transport = new StdioServerTransport();
await server.connect(transport);

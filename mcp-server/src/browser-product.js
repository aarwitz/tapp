// Local transport adapter for Tapp's shared customer product operations. The
// browser is a customer interface, not a web-only test driver. Repository
// sources are server-owned workspaces and every target operation resolves a
// canonical Application Model identity before it builds or runs anything.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { customerProductContract } from "../../browser/product-contract.js";
import { BrowserWorkspaceRegistry } from "./browser-workspaces.js";
import { selectApplicationTarget } from "./ci-setup.js";
import { initializeProductProject, prepareProductTarget, readProductProject, runProductGate } from "./product-operations.js";
import { readCaptureProvenance } from "./capture-provenance.js";
import { collectShots } from "./html-report.js";
import { classifyPrompt } from "../../browser/view-model.js";
import { JobLanes } from "./job-lanes.js";
import { AccountStore } from "./account-store.js";
import { ActorStore, hostKey } from "./actor-store.js";
import { createMailer, signInMessage } from "./mailer.js";
import { accessConfig, createAccessVerifier } from "./access-jwt.js";
import { journeyFromCapture, JourneyStore, slugify } from "./journeys.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const assetRoot = path.join(packageRoot, "browser");
const JSON_BODY_LIMIT = 1024 * 1024;
const SESSION_COOKIE = "tapp_local_session";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"], [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"], [".json", "application/json; charset=utf-8"],
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".webm", "video/webm"], [".mov", "video/quicktime"], [".svg", "image/svg+xml"],
]);

function sameSecret(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookies(request) {
  return Object.fromEntries(String(request.headers.cookie || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const at = part.indexOf("=");
    return at < 0 ? [part, ""] : [part.slice(0, at), decodeURIComponent(part.slice(at + 1))];
  }));
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(value));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > JSON_BODY_LIMIT) { reject(Object.assign(new Error("Request body exceeds 1 MiB"), { statusCode: 413 })); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("Request body must be valid JSON"), { statusCode: 400 })); }
    });
    request.on("error", reject);
  });
}

function serveFile(response, file, { inline = true } = {}) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end("Not found"); return; }
  const headers = {
    "content-type": contentTypes.get(path.extname(file).toLowerCase()) || "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (!inline) headers["content-disposition"] = `attachment; filename="${path.basename(file).replaceAll('"', "")}"`;
  response.writeHead(200, headers);
  fs.createReadStream(file).pipe(response);
}

function serveBrowserIndex(response, { apiBase = "", loginUrl = "" } = {}) {
  const file = path.join(assetRoot, "index.html");
  let html = fs.readFileSync(file, "utf8");
  const encode = (value) => String(value || "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  html = html
    .replace('<meta name="tapp-api-base" content="">', `<meta name="tapp-api-base" content="${encode(apiBase)}">`)
    .replace('<meta name="tapp-login-url" content="">', `<meta name="tapp-login-url" content="${encode(loginUrl)}">`);
  response.writeHead(200, {
    "content-type":"text/html; charset=utf-8",
    "content-length":Buffer.byteLength(html),
    "cache-control":"no-store",
    "x-content-type-options":"nosniff",
  });
  response.end(html);
}

function assetPath(pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/assets\//, "");
  const candidate = path.resolve(assetRoot, relative);
  return candidate.startsWith(assetRoot + path.sep) ? candidate : null;
}

function captureRoot() {
  return path.join(process.env.TAPP_HOME || path.join(os.homedir(), ".tapp"), "captures");
}

function capturePath(captureId, relative = "report.html") {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(captureId)) return null;
  const root = path.resolve(captureRoot(), captureId);
  const candidate = path.resolve(root, relative || "report.html");
  return candidate === root || candidate.startsWith(root + path.sep) ? candidate : null;
}

// Captures live in one flat directory shared by every run on this machine. A public Studio has
// many visitors in it, so an anonymous visitor's capture is stamped with their visitor id and
// only ever listed or served back to them. An unstamped capture belongs to the operator.
const VISITOR_MARKER = ".visitor";
const VISITOR_COOKIE = "tapp_visitor";
// A signed-in tapp account on a public Studio (ADR-0009 slice 2). The cookie is a session token
// whose hash the account store knows; see account-store.js.
const ACCOUNT_COOKIE = "tapp_account";

// What a signed-out visitor on a public Studio may reach. Everything absent from this list is
// refused, so a new route is private until someone deliberately opens it.
function anonymousAllows(method, pathname) {
  if (method === "GET") {
    if (pathname === "/" || pathname === "/api/version" || pathname === "/api/session" || pathname === "/api/audits") return true;
    if (pathname.startsWith("/assets/")) return true;
    if (/^\/api\/captures\/[A-Za-z0-9._-]{1,128}\/files$/.test(pathname)) return true;
    if (/^\/evidence\/captures\//.test(pathname)) return true;
    if (/^\/api\/jobs\/[a-f0-9]{20}(\/frame)?$/.test(pathname)) return true;
    // Following a sign-in link from an email, or arriving back from Cloudflare Access.
    if (pathname === "/auth/cloudflare" || /^\/auth\/[A-Za-z0-9_-]{20,}$/.test(pathname)) return true;
    return false;
  }
  // Asking for a sign-in link is the one thing a stranger may post besides a run.
  if (method === "POST" && pathname === "/api/auth/link") return true;
  // A visitor may start a read-only audit, and may *ask* about the other kinds of target so the
  // Studio can say where they actually run. A bare 401 reads as "broken" to someone who typed a
  // repo into the landing page, which is how five of its six examples used to dead-end.
  // `explore` is listed so a visitor receives the honest "run this on your own machine" answer
  // from the handler, rather than a bare 401 that reads as broken.
  return method === "POST" && ["/api/operations/audit", "/api/operations/open", "/api/operations/explore-build", "/api/operations/explore"].includes(pathname);
}

// A signed-in account may do what a visitor may, plus: start a real exploration (which can stop
// at a sign-in and ask), answer that ask, and see and forget the test accounts it has stored.
// Repositories, live sessions and the gate stay the operator's — they are this machine's.
function accountAllows(method, pathname) {
  if (anonymousAllows(method, pathname)) return true;
  if (method === "POST" && (pathname === "/api/auth/signout" || /^\/api\/jobs\/[a-f0-9]{20}\/input$/.test(pathname))) return true;
  if (method === "GET" && (pathname === "/api/actors" || pathname === "/api/journeys")) return true;
  if (method === "DELETE" && /^\/api\/actors\/[A-Za-z0-9.:-]{1,253}\/[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(pathname)) return true;
  // Journeys: keep a proven run, replay it, forget it (ADR-0009 slice 3).
  if (method === "POST" && (/^\/api\/captures\/[A-Za-z0-9._-]{1,128}\/keep$/.test(pathname) || pathname === "/api/operations/run-flow")) return true;
  if (method === "DELETE" && /^\/api\/journeys\/[a-z0-9-]{1,60}$/.test(pathname)) return true;
  return false;
}

// One visitor may start a bounded number of audits per hour. Each audit drives a real browser
// over as many as 20 pages, so this is about the machine, not about abuse alone.
const AUDIT_LIMIT_PER_HOUR = 10;
const auditHistory = new Map();
function auditRateLimit(visitorId, method, pathname) {
  if (method !== "POST" || !["/api/operations/audit", "/api/operations/explore"].includes(pathname)) return 0;
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const recent = (auditHistory.get(visitorId) || []).filter((at) => now - at < hour);
  if (auditHistory.size > 5000) auditHistory.clear();
  if (recent.length >= AUDIT_LIMIT_PER_HOUR) return Math.ceil((hour - (now - recent[0])) / 1000);
  recent.push(now);
  auditHistory.set(visitorId, recent);
  return 0;
}

function captureOwner(captureId) {
  const marker = capturePath(captureId, VISITOR_MARKER);
  if (!marker) return null;
  try { return fs.readFileSync(marker, "utf8").trim() || null; } catch { return null; }
}

function setCaptureOwner(captureId, visitorId) {
  const marker = capturePath(captureId, VISITOR_MARKER);
  if (!marker || !visitorId) return;
  try { fs.writeFileSync(marker, `${visitorId}\n`, { mode: 0o600 }); } catch { /* evidence is still written */ }
}

// `owner` null means the operator, who sees every capture; a visitor id sees only their own.
function visibleToOwner(captureId, owner) {
  return owner === null || captureOwner(captureId) === owner;
}

// Read-only website audits live in the captures directory like every other run; the Studio
// lists the ones with a summary file. Newest first, bounded.
function listAudits(limit = 50, owner = null) {
  const root = captureRoot();
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  const audits = [];
  for (const name of names) {
    if (!name.startsWith("web-audit-")) continue;
    if (!visibleToOwner(name, owner)) continue;
    const summaryPath = path.join(root, name, "audit.json");
    let summary;
    try { summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")); } catch { continue; }
    const provenance = readCaptureProvenance(path.join(root, name));
    audits.push({
      id: name, createdAt: provenance?.createdAt || fs.statSync(summaryPath).mtime.toISOString(),
      url: summary.url, pagesAudited: summary.pagesAudited || 0, pagesWithUnverifiableWiring: summary.pagesWithUnverifiableWiring || 0,
      findingCounts: summary.findingCounts || {}, issueCount: summary.issueCount ?? (summary.issues || []).length,
      issues: (summary.issues || []).slice(0, 60), checkedFor: summary.checkedFor || [], notChecked: summary.notChecked || [],
    });
  }
  return audits.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

// Everything the Studio can show for one capture, as paths relative to /evidence/captures/<id>/.
function captureFiles(captureId) {
  const root = capturePath(captureId, ".");
  if (!root || !fs.existsSync(root)) return null;
  const shots = collectShots(root).slice(0, 24);
  const recording = ["exploration.webm", "exploration.mov", "exploration.mp4"].find((name) => fs.existsSync(path.join(root, name))) || null;
  return { id: captureId, shots, recording, report: fs.existsSync(path.join(root, "report.html")) ? "report.html" : null, provenance: readCaptureProvenance(root) };
}

// Explorations started from the prompt (a bundle id, an .app or .apk) have no repository to list
// them under; they are listed from their captures like audits are.
function listBuildExplores(limit = 50, owner = null) {
  const root = captureRoot();
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  const runs = [];
  for (const name of names) {
    if (!visibleToOwner(name, owner)) continue;
    const provenance = readCaptureProvenance(path.join(root, name));
    if (!provenance || provenance.kind !== "explore" || provenance.origin !== "studio-prompt") continue;
    let report = null;
    try { report = JSON.parse(fs.readFileSync(path.join(root, name, "report.json"), "utf8")); } catch { /* older capture */ }
    runs.push({ id: name, createdAt: provenance.createdAt, platform: provenance.platform, target: provenance.target, report });
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

// Mark a capture as prompt-started so the Studio lists it in Runs without a repository. The
// report summary beside it is what the list row and detail read; the capture stays the evidence.
function markPromptStarted(structured) {
  try {
    const captureDir = structured?.capture?.path;
    if (!captureDir) return;
    const provenancePath = path.join(captureDir, "provenance.json");
    const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
    fs.writeFileSync(provenancePath, JSON.stringify({ ...provenance, origin: "studio-prompt" }, null, 2));
    fs.writeFileSync(path.join(captureDir, "report.json"), JSON.stringify({ headline: structured.headline, inconclusive: structured.inconclusive, screensExplored: structured.screensExplored, actionsPerformed: structured.actionsPerformed, findingCounts: structured.findingCounts, findings: structured.findings, checkedFor: structured.checkedFor, notChecked: structured.notChecked, platform: structured.platform, target: structured.target }, null, 2));
  } catch { /* listing is a convenience; the capture is the evidence */ }
}

// Replay one web journey and record how it went. Shared by the Studio's Run button and the
// daily check, so both leave the same status and the same evidence behind.
async function replayJourney({ store, slug, flow, actorRoot = "", ownerKey = null, progress = () => {} }) {
  // A journey that signs in does so as the test account tapp was told about for that site: the
  // values come from the encrypted actor store at replay and never from the file.
  const variables = {};
  let storageStatePath = "";
  if (flow.url && (flow.actor || (flow.steps || []).some((step) => step && typeof step === "object" && "login" in step))) {
    const actors = new ActorStore(actorRoot ? { root: actorRoot } : {});
    const record = actors.read(flow.url, flow.actor || "default");
    if (record?.credentials?.email) variables.TEST_EMAIL = record.credentials.email;
    if (record?.credentials?.password) variables.TEST_PASSWORD = record.credentials.password;
    // A journey that began inside replays from the actor's saved session, like the run did.
    if (flow.actor) storageStatePath = actors.sessionFile(flow.url, flow.actor) || "";
  }
  const captureId = `flow-web-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const evidenceDir = path.join(captureRoot(), captureId);
  fs.mkdirSync(evidenceDir, { recursive: true });
  if (ownerKey) setCaptureOwner(captureId, ownerKey);
  progress({ phase: "runtime", text: `Replaying ${flow.name || slug}` });
  const { runWebFlow } = await import("./web-flow.js");
  let result;
  try { result = await runWebFlow({ flow, variables, storageStatePath, logPath: path.join(evidenceDir, "flow.log"), screenshotDir: evidenceDir, recordVideoDir: evidenceDir }); }
  finally { if (storageStatePath) { try { fs.rmSync(storageStatePath, { force: true }); } catch { /* temp */ } } }
  // The runner's log is marker lines; the chat wants one plain sentence per step.
  for (const line of result.lines || []) {
    const raw = typeof line === "string" ? line : (line.text || "");
    const step = raw.match(/^OCQA_FLOW_STEP:(\{.*\})$/);
    if (step) {
      try {
        const st = JSON.parse(step[1]);
        const what = st.action === "login" ? "Signed in" : st.action === "wait_for" ? `Reached ${st.target}` : st.action === "assert_screen" ? `On ${st.target}` : st.action === "tap" ? `Tapped "${st.target}"` : `${st.action} ${st.target || ""}`.trim();
        progress({ phase: "replay", text: st.status === "pass" ? `${what}` : `Step ${st.index}: ${what} — ${st.detail || "failed"}` });
      } catch { progress({ phase: "replay", text: raw }); }
      continue;
    }
    if (/^OCQA_(FLOW_RESULT|ISSUE):/.test(raw)) continue;
    if (raw) progress({ phase: "replay", text: raw });
  }
  const status = store.recordRun(slug, { passed: result.passed, captureId, executed: result.executed, total: result.total, failed: result.failed });
  return { kind: "journey", name: flow.name || slug, slug, passed: result.passed, executed: result.executed, total: result.total, failed: result.failed, status, capture: { id: captureId, path: evidenceDir } };
}

// "Make sure this always works": kept journeys on a public Studio are replayed on a schedule,
// each in its owner's lane so a check never queues ahead of the owner's own run. A journey is
// due when its last result is older than the interval (TAPP_JOURNEY_CHECK_HOURS, default 24);
// a restart therefore does not re-run everything, and a busy lane simply waits for the next tick.
export function dueJourneys(journeys, { intervalMs, now = Date.now() }) {
  return journeys.filter((j) => (j.platform || "web") === "web" && (!j.status || now - Date.parse(j.status.at || 0) >= intervalMs));
}

function openBrowser(url) {
  const invocation = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  const child = spawn(invocation[0], invocation[1], { detached: true, stdio: "ignore", shell: false });
  child.unref();
}

function publicJob(job, { hosted = false } = {}) {
  return {
    id: job.id, operation: job.operation, status: job.status, repositoryId: job.repositoryId || null,
    createdAt: job.createdAt, completedAt: job.completedAt || null, progress: job.progress.slice(-80), frame: !!job.latestFrame || !!job.liveSimulator, platform: job.platform || null,
    result: hosted ? hostedPayload(job.result) : job.result || null,
    error: job.error || null,
    // Fields only (labels, which are secure); what the person typed never travels back out.
    input: job.input ? { requestId: job.input.requestId, screen: job.input.screen, fields: job.input.fields, askedAt: job.input.askedAt } : null,
  };
}

export function normalizeInteractiveElements(elements = []) {
  const actionableRoles = new Set(["button", "cell", "checkbox", "input", "link", "secureField", "switch", "tab", "textField", "textView"]);
  const seen = new Set();
  const normalized = [];
  for (const element of Array.isArray(elements) ? elements : []) {
    const id = String(element.id || "").trim();
    const label = String(element.label || element.text || element.description || "").trim();
    const target = id || label;
    const role = String(element.role || (element.secure ? "secureField" : "other"));
    const type = String(element.type || element.class || "");
    const input = element.secure === true || /input|textfield|edittext|textarea|secure/i.test(`${role} ${type}`);
    const actionable = element.clickable === true || actionableRoles.has(role) || /XCUIElementType\(rawValue:\s*9\)/.test(type) || input;
    const key = target.toLocaleLowerCase();
    if (!target || !actionable || seen.has(key)) continue;
    seen.add(key);
    const hittable = element.hittable === true || element.clickable === true;
    normalized.push({
      id,
      label,
      type,
      role:input && role === "other" ? "input" : role,
      enabled:element.enabled !== false,
      hittable,
      clickable:!input && actionable && hittable,
      secure:element.secure === true,
      ...(element.frame ? { frame:element.frame } : {}),
    });
    if (normalized.length >= 100) break;
  }
  return normalized;
}

function publicInteractiveResult(result, context = {}) {
  return {
    active: context.active !== false,
    platform: context.platform || "",
    targetId: context.targetId || "",
    targetName: context.targetName || "",
    screenTitle: result?.screenTitle || null,
    status: result?.status || (result?.error ? "error" : "ok"),
    detail: result?.detail || result?.error || null,
    recordedSteps: Number(result?.recordedSteps || 0),
    url: result?.url || context.url || "",
    elements:normalizeInteractiveElements(result?.elements),
  };
}

function disconnectedProject(repository = null) {
  return {
    kind: "tapp-product-project", schemaVersion: 1, connected: false, repository,
    application: { name: "Connect a product", platforms: [], targetIds: [] },
    targets: [], actors: [], capabilities: [], requirements: [], model: null, map: null, plan: null,
    ci: null, baselines: [], flows: [], evidence: [],
    state: { inspected: false, explored: false, reviewComplete: false, generated: false, validated: false, promoted: false, ciPrepared: false, baselineReady: false, blockingRequirements: 0 },
  };
}

function projectSnapshot(registry) {
  const repository = registry.current();
  const root = registry.currentRoot();
  if (!root) return disconnectedProject();
  return { ...readProductProject({ projectDir: root }), connected: true, repository };
}

function selectedTarget(root, body) {
  const project = readProductProject({ projectDir: root });
  if (!project.model) throw new Error("Inspect the repository before selecting a target");
  return selectApplicationTarget(project.model, { platform: String(body.platform || "").toLowerCase(), target: String(body.target || "") });
}

function runtimeRequest(body = {}) {
  return {
    maxActions: Number(body.maxActions || body.actions) || 40,
    timeout: Number(body.timeout) || 600,
    maxContracts: Number(body.maxContracts) || 15,
    testEmail: typeof body.testEmail === "string" ? body.testEmail : undefined,
    testPassword: typeof body.testPassword === "string" ? body.testPassword : undefined,
    serial: typeof body.serial === "string" ? body.serial.trim() : "",
  };
}

function runnerSummary({ hosted = false } = {}) {
  if (hosted) return [
    { id:"managed-ios", platform:"ios", label:"Managed macOS runner", status:"unavailable", remediation:"The hosted customer adapter is not yet connected to a lease-backed macOS runner." },
    { id:"managed-android", platform:"android", label:"Managed Android runner", status:"unavailable", remediation:"The hosted customer adapter is not yet connected to a lease-backed Android runner." },
    { id:"hosted-web", platform:"web", label:"Hosted Chromium", status:"needs-check", remediation:"Tapp verifies the isolated Chromium runtime when the selected web target starts." },
  ];
  const executable = (name) => String(process.env.PATH || "").split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, name)));
  const ios = process.platform === "darwin" && (fs.existsSync("/usr/bin/xcodebuild") || executable("xcodebuild"));
  const android = executable(process.platform === "win32" ? "adb.exe" : "adb") || !!process.env.ANDROID_SDK_ROOT || !!process.env.ANDROID_HOME;
  return [
    { id: "local-ios", platform: "ios", label: "Local Xcode simulator", status: ios ? "available" : "unavailable", remediation: ios ? "" : "Use a macOS runner with Xcode for iOS." },
    { id: "local-android", platform: "android", label: "Local Android runtime", status: android ? "available" : "needs-check", remediation: android ? "Start or connect an emulator/device." : "Install Android SDK platform-tools or connect a managed Android runner." },
    { id: "local-web", platform: "web", label: "Local Chromium", status: "needs-check", remediation: "Tapp verifies Playwright and Chromium when the target starts." },
  ];
}

function hostedRepository(repository) {
  if (!repository) return null;
  const { root: _root, ...safe } = repository;
  return safe;
}

function hostedPayload(value) {
  if (Array.isArray(value)) return value.map(hostedPayload);
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && path.isAbsolute(value)) return `tapp-workspace:${path.basename(value)}`;
    return value ?? null;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "repository" ? hostedRepository(item) : hostedPayload(item)]));
}

function requireMutationAuth(request, origin, csrfToken) {
  const allowed = Array.isArray(origin) ? origin : [origin];
  if (!allowed.includes(request.headers.origin) || !sameSecret(request.headers["x-tapp-csrf"], csrfToken)) {
    const error = new Error("Same-origin CSRF validation failed");
    error.statusCode = 403;
    throw error;
  }
}

function readFormBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    request.on("data", (chunk) => {
      received += chunk.length;
      if (received > 64 * 1024) { request.destroy(); reject(Object.assign(new Error("Request body too large"), { statusCode: 413 })); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    request.on("error", reject);
  });
}

const escapeHtml = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// A path the sign-in flow may return to. Only a local path is ever accepted: anything with a
// scheme or authority (including the "//evil.com" protocol-relative form) would make /login an
// open redirect, so it is rejected rather than sanitized.
function safeReturnPath(raw) {
  const value = String(raw || "");
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "";
  if (value.startsWith("/login")) return "";
  // "/" is where sign-in lands anyway; carrying it adds a querystring that says nothing.
  if (value === "/") return "";
  return value.slice(0, 2048);
}

function serveLoginPage(response, { failed = false, next = "" } = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>tapp — sign in</title><style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c1210;color:#e8efe9;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  main{width:min(360px,90vw)}
  h1{font-size:44px;margin:0 0 4px;letter-spacing:-.03em}h1 span{color:#4f6cf7}
  p.tag{margin:0 0 28px;color:#93a89b;font-family:ui-monospace,monospace;font-size:14px}
  form{display:grid;gap:12px}
  label{display:grid;gap:6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#93a89b}
  input{padding:11px 12px;border-radius:8px;border:1px solid #2c3a31;background:#131b17;color:#e8efe9;font-size:15px}
  input:focus{outline:2px solid #4f6cf7;border-color:transparent}
  button{margin-top:6px;padding:12px;border:0;border-radius:8px;background:#1f5c3d;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  .err{background:#3a1a1c;border:1px solid #6e2a2e;color:#f0b9bd;padding:10px 12px;border-radius:8px;font-size:14px}
  small{color:#657a6c}
</style></head><body><main>
  <h1>tapp<span>.</span></h1><p class="tag">ship with proof.</p>
  ${failed ? '<p class="err" role="alert">That username or password did not match.</p>' : ""}
  <form method="post" action="/api/auth">
    ${next ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : ""}
    <label>Username<input name="username" autocomplete="username" placeholder="username" required></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" placeholder="password" required></label>
    <button type="submit">Launch Tapp →</button>
  </form>
  <p><small>Demo access: demo / demo. Uploaded repositories run in a restricted pilot workspace.</small></p>
</main></body></html>`;
  response.writeHead(failed ? 401 : 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
}

export async function startBrowserProduct({ projectDir, port = 0, launch = false, workspaceRoot, githubProvider, publicOrigin = "", trustedProxyToken = "", directLogin = null, publicEgressOnly = null, publicAccess = false, accessVerifier = undefined } = {}) {
  const hosted = !!trustedProxyToken || !!directLogin || !!publicAccess;
  // publicOrigin accepts a comma-separated allowlist; the first entry is canonical.
  const publicOrigins = String(publicOrigin || "").split(",").map((value) => value.trim().replace(/\/$/, "")).filter(Boolean);
  if (hosted && !publicOrigins.length) throw new Error("Hosted browser mode requires an explicit publicOrigin");
  const loginFailures = { count: 0, windowStartedAt: 0 };
  // A hosted Studio audits whatever URL a visitor types, from a machine that can also see its
  // own loopback services and private network. Route the browser through the egress proxy, which
  // resolves and pins every connection — redirects and subresources included — and refuses
  // anything that is not a public address. TAPP_ENFORCE_PUBLIC_EGRESS makes a missing proxy fail
  // the run rather than silently reaching the private network. On by default whenever hosted:
  // forgetting to opt in is exactly the mistake that matters here.
  const enforcePublicEgress = publicEgressOnly === null ? hosted : !!publicEgressOnly;
  // The engine reads the proxy off process.env, so enabling it mutates process-wide state. Keep
  // what was there and put it back on close: a local Studio started later in the same process
  // would otherwise inherit a proxy that no longer exists and fail every run.
  let egressProxy = null;
  const previousEgressEnv = {
    server: process.env.TAPP_BROWSER_PROXY_SERVER,
    enforce: process.env.TAPP_ENFORCE_PUBLIC_EGRESS,
  };
  const restoreEgressEnv = () => {
    for (const [key, value] of [["TAPP_BROWSER_PROXY_SERVER", previousEgressEnv.server], ["TAPP_ENFORCE_PUBLIC_EGRESS", previousEgressEnv.enforce]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  if (enforcePublicEgress) {
    const { startPublicBrowserProxy } = await import("./public-network.js");
    egressProxy = await startPublicBrowserProxy();
    process.env.TAPP_BROWSER_PROXY_SERVER = egressProxy.url;
    process.env.TAPP_ENFORCE_PUBLIC_EGRESS = "1";
  }
  const registry = new BrowserWorkspaceRegistry({ initialProjectDir: projectDir, workspaceRoot, githubProvider });
  // Accounts exist only on a public Studio: a local one has exactly one person, the operator.
  const accounts = publicAccess ? new AccountStore() : null;
  const mailer = publicAccess ? createMailer() : null;
  // With Cloudflare Access in front of /auth/cloudflare, identity comes from Cloudflare's signed
  // assertion and tapp sends no email at all. Configured by TAPP_ACCESS_TEAM_DOMAIN + TAPP_ACCESS_AUD;
  // tests inject a verifier. The email link stays available as the provider-free path.
  const access = accessVerifier !== undefined ? accessVerifier : (publicAccess && accessConfig() ? createAccessVerifier(accessConfig()) : null);
  const signInProvider = access ? "cloudflare" : "email";
  const openAccountSession = (response, signedIn, location = "/?signin=done") => {
    logUsage("signin.done", { account: signedIn.account.id.slice(0, 8), provider: signInProvider });
    response.writeHead(303, { location, "set-cookie": `${ACCOUNT_COOKIE}=${encodeURIComponent(signedIn.session)}; HttpOnly; SameSite=Lax;${secureCookies ? " Secure;" : ""} Path=/; Max-Age=7776000` });
    response.end();
  };
  const secureCookies = publicOrigins[0]?.startsWith("https:") ?? false;
  const serverStartedAt = new Date().toISOString();
  const sessionToken = crypto.randomBytes(32).toString("base64url");
  const csrfToken = crypto.randomBytes(24).toString("base64url");
  const jobs = new Map();
  // A public Studio serves strangers, and until now it recorded nothing about that — the journal
  // held only startup lines, so "is anyone using this?" had no answer at all. These lines go to
  // stdout, which systemd already captures, so there is no new storage to run:
  //
  //   journalctl -u tapp-demo | grep tapp-usage
  //
  // Deliberately not collected: no IP address (Cloudflare fronts this and we do not need it), no
  // full URL (a query string can carry a token or an email), and only the first eight characters
  // of the visitor id — enough to tell two visitors apart in a day's log, not enough to be a
  // durable handle for one. Off unless the Studio is public; a local Studio logging its owner's
  // own use is noise.
  const usage = { visitors: new Set(), audits: 0, refusals: 0, startedAt: new Date().toISOString() };
  const logUsage = (event, fields = {}) => {
    if (!publicAccess) return;
    try {
      console.log(`tapp-usage ${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}`);
    } catch { /* logging must never break a run */ }
  };
  // Where a visitor pointed us, without what they may have put in the query string.
  const safeHost = (value) => { try { return new URL(value).host; } catch { return "unparsed"; } };
  // Engine errors quote the URL they failed on, query string and all — which is how a token or
  // an email in someone's link ends up in a log that was supposed to hold neither. Keep the
  // origin and path, drop everything after it.
  const redactUrls = (text) => String(text).replace(/https?:\/\/[^\s"'<>]+/gi, (match) => {
    try { const u = new URL(match); return `${u.origin}${u.pathname}${u.search || u.hash ? "?…" : ""}`; }
    catch { return "[url]"; }
  });

  // Individual lines age out of the journal; a rollup means one grep still answers "did anyone
  // use this last week?". unref'd so it never holds the process open, and cleared on close.
  const usageHeartbeat = publicAccess
    ? setInterval(() => logUsage("rollup", {
        sinceStart: usage.startedAt,
        distinctVisitors: usage.visitors.size,
        audits: usage.audits,
        refusals: usage.refusals,
      }), 60 * 60 * 1000)
    : null;
  if (usageHeartbeat?.unref) usageHeartbeat.unref();

  // Work is serialized per lane rather than globally; see job-lanes.js for why.
  const OPERATOR_LANE = "operator";
  const lanes = new JobLanes({ operatorLane: OPERATOR_LANE });
  let liveSession = null;
  let liveManagedRuntime = null;
  let origin = "";

  const startJob = (operation, work, repositoryId = registry.current()?.id || null, { lane = OPERATOR_LANE } = {}) => {
    const job = { id: crypto.randomBytes(10).toString("hex"), operation, repositoryId, lane, status: "running", createdAt: new Date().toISOString(), progress: [] };
    const claimed = lanes.claim(lane, job);
    if (!claimed.ok) throw Object.assign(new Error(claimed.message), { statusCode: claimed.statusCode });
    const progress = (entry) => {
      const normalized = typeof entry === "string" ? { text: entry } : entry || {};
      job.progress.push({ at: new Date().toISOString(), phase: normalized.phase || operation, text: String(normalized.text || "").slice(-1200), ...(normalized.current ? { current: normalized.current, total: normalized.total } : {}), ...(normalized.screen ? { screen: String(normalized.screen).slice(0, 200) } : {}) });
      if (job.progress.length > 200) job.progress.splice(0, job.progress.length - 200);
      // The engine names the screenshot it just wrote; the Studio device panel polls it as the
      // exploration feed. Only engine-supplied paths ever land here, never client input.
      if (normalized.screenshot && path.isAbsolute(normalized.screenshot)) job.latestFrame = normalized.screenshot;
      // A pause-and-ask from the engine (OCQA_AWAIT_INPUT): keep the request on the job so the
      // Studio can render it, and clear it once the engine says it was resolved.
      if (normalized.awaitInput && typeof normalized.awaitInput === "object") job.input = { ...normalized.awaitInput, askedAt: new Date().toISOString() };
      if (normalized.inputResolved) job.input = null;
    };
    jobs.set(job.id, job);
    Promise.resolve().then(() => work(progress)).then((result) => {
      job.status = "completed";
      job.result = result;
    }).catch((error) => {
      job.status = "failed";
      job.error = { message: error.message || String(error), ...(error.details ? { details: error.details } : {}) };
      logUsage("job.failed", { operation, lane: String(lane).slice(0, 8), message: redactUrls(error.message || error).slice(0, 200) });
    }).finally(() => {
      job.completedAt = new Date().toISOString();
      lanes.release(lane, job);
    });
    return job;
  };

  // Daily checks of every account's kept journeys (public Studio only; a local Studio is not
  // always running, and its journeys are the repository's to guard in CI).
  const checkIntervalMs = Math.max(1, Number(process.env.TAPP_JOURNEY_CHECK_HOURS) || 24) * 60 * 60 * 1000;
  const runJourneyChecks = async () => {
    if (!accounts) return;
    const journeysRoot = path.join(accounts.root, "journeys");
    let owners = [];
    try { owners = fs.readdirSync(journeysRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && /^[a-f0-9]{24}$/.test(d.name)).map((d) => d.name); } catch { return; }
    for (const accountId of owners) {
      const store = JourneyStore.forAccount(accountId);
      const ownerKey = `acct:${accountId}`;
      for (const journey of dueJourneys(store.list(), { intervalMs: checkIntervalMs })) {
        const flowPath = store.flowPath(journey.slug);
        let flow;
        try { const { loadFlowFile } = await import("./flow-runtime.js"); flow = loadFlowFile(flowPath); } catch { continue; }
        let job;
        try {
          job = startJob("check-journey", (progress) => replayJourney({ store, slug: journey.slug, flow, actorRoot: accounts.actorRoot(accountId), ownerKey, progress }), null, { lane: ownerKey });
        } catch { continue; /* the owner is busy; next tick */ }
        job.ownerKey = ownerKey;
        // One at a time per owner: wait for this check before starting the next.
        await new Promise((resolve) => { const tick = () => (job.status === "running" ? setTimeout(tick, 1000) : resolve()); tick(); });
        logUsage("journey.checked", { owner: ownerKey.slice(0, 13), passed: job.result?.passed ?? null });
      }
    }
  };
  const checkTimer = publicAccess ? setInterval(() => { runJourneyChecks().catch(() => {}); }, 60 * 60 * 1000) : null;
  if (checkTimer?.unref) checkTimer.unref();
  const firstCheck = publicAccess ? setTimeout(() => { runJourneyChecks().catch(() => {}); }, 10 * 60 * 1000) : null;
  if (firstCheck?.unref) firstCheck.unref();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", origin || "http://127.0.0.1");
    const baseHeaders = {
      // The application uses bounded runtime style properties for map layout and
      // operation progress. Keep scripts locked to first-party files while
      // allowing those styles to render in both local and relayed deployments.
      "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
    };
    for (const [key, value] of Object.entries(baseHeaders)) response.setHeader(key, value);

    try {
      if (request.method === "GET" && url.searchParams.has("token")) {
        if (!sameSecret(url.searchParams.get("token"), sessionToken)) { response.writeHead(403); response.end("Invalid local session token"); return; }
        response.writeHead(303, { location: "/", "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/` });
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/version") {
        json(response, 200, { product: "tapp-browser", release: process.env.TAPP_RELEASE || "dev", startedAt: serverStartedAt });
        return;
      }
      const proxyAuthenticated = !!trustedProxyToken && sameSecret(request.headers["x-tapp-proxy-token"], trustedProxyToken);
      const authenticated = proxyAuthenticated || sameSecret(cookies(request)[SESSION_COOKIE], sessionToken);

      // A public Studio lets anyone in without an account, but an anonymous visitor gets a far
      // smaller surface than the operator: audit a public website, and read back only the
      // evidence from their own audits. Repositories, live sessions, the gate and this
      // machine's project all stay behind authentication.
      let visitorId = null;
      let anonymous = false;
      // A signed-in account sits between the two: more than a visitor, less than the operator.
      const account = publicAccess && !authenticated ? accounts.sessionAccount(cookies(request)[ACCOUNT_COOKIE] || "") : null;
      if (account && !accountAllows(request.method, url.pathname)) {
        json(response, 401, { error: "That part of the Studio runs on your own machine: npx -y @aarwitz/tapp@latest app" });
        return;
      }
      if (publicAccess && !authenticated && !account) {
        anonymous = true;
        visitorId = String(cookies(request)[VISITOR_COOKIE] || "");
        const returning = /^[a-f0-9]{32}$/.test(visitorId);
        if (!returning) {
          visitorId = crypto.randomBytes(16).toString("hex");
          response.setHeader("set-cookie", `${VISITOR_COOKIE}=${visitorId}; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=2592000`);
        }
        const permitted = anonymousAllows(request.method, url.pathname);
        // Count someone as a visitor only when they ask for something the Studio actually
        // offers. A public host is scanned constantly — in one afternoon this recorded 404
        // "new visitors", 383 of which were bots probing for .env files, which is a reading
        // that answers "is anyone using this?" with noise.
        if (!returning && permitted) {
          if (usage.visitors.size < 50_000) usage.visitors.add(visitorId.slice(0, 8));
          logUsage("visitor.new", { visitor: visitorId.slice(0, 8), distinctVisitors: usage.visitors.size });
        }
        if (!permitted) {
          usage.refusals += 1;
          // Scanners are the overwhelming majority of refusals and say nothing about the
          // product; count them, and keep one line per path rather than one per request.
          const scanning = /\.(env|git|aws|ssh)|wp-|phpunit|vendor\/|\.ya?ml$|\.ini$|credentials/i.test(url.pathname);
          if (!scanning) logUsage("refused", { visitor: visitorId.slice(0, 8), reason: "not-public", method: request.method, path: url.pathname, status: 401 });
          else if (usage.refusals % 100 === 0) logUsage("scanned", { refusalsSoFar: usage.refusals, note: "automated probes for secrets; all refused" });
          json(response, 401, { error: "Sign in to use this. A public visitor can audit a website read-only; repositories, live sessions and the release gate need an account." });
          return;
        }
        const limited = auditRateLimit(visitorId, request.method, url.pathname);
        if (limited) { usage.refusals += 1; logUsage("refused", { visitor: visitorId.slice(0, 8), reason: "rate-limit", retryAfterSec: limited, status: 429 }); response.writeHead(429, { "content-type": "application/json; charset=utf-8", "retry-after": String(limited) }); response.end(JSON.stringify({ error: `Too many audits from here. Try again in ${Math.ceil(limited / 60)} minute(s).` })); return; }
      }
      // The operator sees every capture; a visitor sees only captures stamped with their id, an
      // account only the ones stamped with its id. `ownerKey` is also the job lane: one person's
      // runs queue behind each other, never behind a stranger's.
      const ownerKey = anonymous ? visitorId : account ? `acct:${account.id}` : null;
      const evidenceOwner = ownerKey;
      if (account) {
        const limited = auditRateLimit(ownerKey, request.method, url.pathname);
        if (limited) { response.writeHead(429, { "content-type": "application/json; charset=utf-8", "retry-after": String(limited) }); response.end(JSON.stringify({ error: `Too many runs from this account. Try again in ${Math.ceil(limited / 60)} minute(s).` })); return; }
      }
      // A job belongs to whoever started it; the operator sees them all.
      const jobVisible = (job) => !!job && (ownerKey === null || job.ownerKey === ownerKey);
      if (!authenticated && directLogin) {
        if (request.method === "GET" && url.pathname === "/login") { serveLoginPage(response, { failed: url.searchParams.has("failed"), next: safeReturnPath(url.searchParams.get("next")) }); return; }
        if (request.method === "POST" && url.pathname === "/api/auth") {
          const now = Date.now();
          if (now - loginFailures.windowStartedAt > 10 * 60_000) { loginFailures.windowStartedAt = now; loginFailures.count = 0; }
          if (loginFailures.count >= 50) { response.writeHead(429, { "retry-after": "600", "content-type": "text/plain; charset=utf-8" }); response.end("Too many sign-in attempts; try again later."); return; }
          // Browsers serialize Origin as the literal string "null" (not absent) for
          // navigation-type requests — i.e. a real <form> POST, not fetch/XHR — when the
          // response carries Referrer-Policy: no-referrer (see baseHeaders above and the
          // Fetch spec's "append a request Origin header" algorithm). That is expected,
          // spec-compliant behavior for every browser hitting this login form, not a
          // cross-origin request, so trust the browser-guaranteed Sec-Fetch-Site header
          // (unaffected by Referrer-Policy) to distinguish it from a genuine foreign origin.
          const originHeader = request.headers.origin;
          const sameOriginNavigation = originHeader === "null" && new Set(["same-origin", "none"]).has(request.headers["sec-fetch-site"]);
          if (originHeader && originHeader !== "null" && !publicOrigins.includes(originHeader)) { response.writeHead(403); response.end("Cross-origin sign-in rejected"); return; }
          if (originHeader === "null" && !sameOriginNavigation) { response.writeHead(403); response.end("Cross-origin sign-in rejected"); return; }
          const form = await readFormBody(request);
          const valid = sameSecret(form.get("username"), directLogin.username) && sameSecret(form.get("password"), directLogin.password);
          if (!valid) {
            loginFailures.count += 1;
            await new Promise((resolve) => setTimeout(resolve, 400));
            const retry = safeReturnPath(form.get("next"));
            response.writeHead(303, { location: retry ? `/login?failed=1&next=${encodeURIComponent(retry)}` : "/login?failed=1" });
            response.end();
            return;
          }
          response.writeHead(303, { location: safeReturnPath(form.get("next")) || "/", "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Secure; Path=/` });
          response.end();
          return;
        }
        if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
          // Carry the destination through sign-in; landing on an empty Studio loses whatever
          // the visitor asked for (the landing page sends ?target=... here).
          const want = safeReturnPath(`${url.pathname}${url.search}`);
          response.writeHead(302, { location: want ? `/login?next=${encodeURIComponent(want)}` : "/login" });
          response.end();
          return;
        }
      }
      if (!authenticated && !anonymous && !account) { response.writeHead(401, { "content-type": "text/plain; charset=utf-8" }); response.end(directLogin ? "Sign in at /login to continue." : "Open Tapp from the authenticated launch URL printed by the CLI."); return; }

      if (request.method === "GET" && url.pathname === "/") {
        // Without a sign-in page there is nowhere to bounce an anonymous visitor to, and a
        // loginUrl would send them in a loop on their first privileged 401.
        serveBrowserIndex(response, hosted
          ? (proxyAuthenticated ? { apiBase:"/api/tapp", loginUrl:"/solutions/tapp" } : { apiBase:"", loginUrl: directLogin ? "/login" : "" })
          : {});
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
        const file = assetPath(url.pathname);
        if (!file) { response.writeHead(404); response.end("Not found"); return; }
        serveFile(response, file);
        return;
      }
      // Signing in: an email address gets a link; the link, used once, becomes a session cookie.
      // The response to the request is the same whether or not the address was ever seen, so
      // this cannot be used to find out who has an account.
      if (publicAccess && request.method === "POST" && url.pathname === "/api/auth/link") {
        requireMutationAuth(request, publicOrigins, csrfToken);
        const body = await readJsonBody(request);
        let link;
        try { link = accounts.requestLink(body.email); }
        catch (error) { json(response, error.statusCode || 400, { error: error.message }); return; }
        const message = signInMessage({ to: link.email, link: `${publicOrigins[0]}/auth/${link.token}`, origin: publicOrigins[0] });
        try {
          const sent = await mailer.send(message);
          logUsage("signin.link", { transport: sent.transport });
        } catch (error) {
          logUsage("signin.link.failed", { transport: mailer.transport, error: String(error.message || error).slice(0, 200) });
          json(response, 502, { error: "The sign-in email could not be sent right now. Try again in a minute." });
          return;
        }
        json(response, 200, { ok: true, sent: true });
        return;
      }
      const authLinkMatch = publicAccess && request.method === "GET" ? url.pathname.match(/^\/auth\/([A-Za-z0-9_-]{20,})$/) : null;
      if (authLinkMatch) {
        const signedIn = accounts.redeem(authLinkMatch[1]);
        if (!signedIn) { response.writeHead(303, { location: "/?signin=expired" }); response.end(); return; }
        openAccountSession(response, signedIn);
        return;
      }
      // Back from Cloudflare Access: the assertion header is only ever set by Cloudflare on a
      // request that passed its policy, and the signature proves it. Without Access configured
      // the path says so instead of pretending.
      if (publicAccess && request.method === "GET" && url.pathname === "/auth/cloudflare") {
        if (!access) { response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); response.end("Cloudflare Access sign-in is not configured here; use the email link."); return; }
        const assertion = String(request.headers["cf-access-jwt-assertion"] || cookies(request).CF_Authorization || "");
        try {
          const { email } = await access.verify(assertion);
          openAccountSession(response, accounts.signIn(email));
        } catch (error) {
          logUsage("signin.access.refused", { reason: String(error.message || error).slice(0, 120) });
          response.writeHead(303, { location: "/?signin=expired" });
          response.end();
        }
        return;
      }
      if (account && request.method === "POST" && url.pathname === "/api/auth/signout") {
        requireMutationAuth(request, publicOrigins, csrfToken);
        accounts.signOut(cookies(request)[ACCOUNT_COOKIE] || "");
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": `${ACCOUNT_COOKIE}=; HttpOnly; SameSite=Lax;${secureCookies ? " Secure;" : ""} Path=/; Max-Age=0` });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      // The test accounts tapp has been told about, by application: names and whether a password
      // or a signed-in session is held — never the values. An account sees its own; the operator
      // sees this machine's.
      const actorRootFor = () => (account ? accounts.actorRoot(account.id) : undefined);
      if (!anonymous && request.method === "GET" && url.pathname === "/api/actors") {
        const store = new ActorStore(actorRootFor() ? { root: actorRootFor() } : {});
        let hosts = [];
        try { hosts = fs.readdirSync(store.root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none yet */ }
        json(response, 200, { apps: hosts.map((host) => ({ host, actors: store.list(`https://${host}/`) })).filter((app) => app.actors.length) });
        return;
      }
      const actorForgetMatch = !anonymous && request.method === "DELETE" ? url.pathname.match(/^\/api\/actors\/([A-Za-z0-9.:-]{1,253})\/([A-Za-z][A-Za-z0-9_-]{0,63})$/) : null;
      if (actorForgetMatch) {
        requireMutationAuth(request, hosted ? publicOrigins : origin, csrfToken);
        const store = new ActorStore(actorRootFor() ? { root: actorRootFor() } : {});
        store.forget(`https://${actorForgetMatch[1]}/`, actorForgetMatch[2]);
        json(response, 200, { ok: true });
        return;
      }
      // Where this person's journeys live: the open repository's .tapp/flows/ for the operator,
      // the account's own store on a public Studio, this machine's store otherwise.
      const journeyStore = () => {
        if (account) return JourneyStore.forAccount(account.id);
        const root = registry.currentRoot();
        return root ? JourneyStore.forRepository(root) : JourneyStore.forMachine();
      };
      const keepMatch = !anonymous && request.method === "POST" ? url.pathname.match(/^\/api\/captures\/([A-Za-z0-9._-]{1,128})\/keep$/) : null;
      if (keepMatch) {
        requireMutationAuth(request, hosted ? publicOrigins : origin, csrfToken);
        if (!visibleToOwner(keepMatch[1], evidenceOwner)) { response.writeHead(404); response.end("Not found"); return; }
        const captureDir = capturePath(keepMatch[1], ".");
        if (!captureDir || !fs.existsSync(captureDir)) { json(response, 404, { error: "No such capture" }); return; }
        const body = await readJsonBody(request);
        const journey = journeyFromCapture(captureDir, { name: String(body.name || "").slice(0, 120), actor: /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(String(body.actor || "")) ? String(body.actor) : "default" });
        if (!journey) { json(response, 409, { error: "That run only looked around; there is no path to keep." }); return; }
        // A preview names the journey and lists where it went without keeping anything, so the
        // Studio can offer it with the right name instead of a guess.
        if (body.preview === true) { json(response, 200, { name: journey.flow.name, slug: slugify(journey.flow.name), steps: journey.steps, screens: journey.screens, signedIn: journey.signedIn, preview: true }); return; }
        let kept;
        try { kept = journeyStore().keep(journey, { replace: body.replace === true }); }
        catch (error) { json(response, error.statusCode || 500, { error: error.message }); return; }
        logUsage("journey.kept", { owner: (ownerKey || "operator").slice(0, 13), steps: journey.steps, signedIn: journey.signedIn });
        json(response, 200, { name: journey.flow.name, slug: kept.slug, steps: journey.steps, screens: journey.screens, signedIn: journey.signedIn, path: registry.currentRoot() && !account ? path.relative(registry.currentRoot(), kept.path) : null });
        return;
      }
      if (!anonymous && request.method === "GET" && url.pathname === "/api/journeys") {
        const store = journeyStore();
        const root = !account ? registry.currentRoot() : null;
        let journeys;
        if (root) {
          // The repository's committed flows, recursively, with the last Studio replay beside each.
          const { readProductProject } = await import("./product-operations.js");
          const flows = readProductProject({ projectDir: root }).flows || [];
          journeys = flows.map((flow) => ({ name: flow.name, slug: flow.relativePath.replace(/^\.tapp\/flows\//, "").replace(/\.(?:ya?ml|json)$/i, ""), group: flow.group || "", platform: flow.platform, steps: flow.steps, source: "repo", status: store.status(flow.relativePath.replace(/^\.tapp\/flows\//, "").replace(/\.(?:ya?ml|json)$/i, "")) }));
        } else {
          journeys = store.list().map((journey) => ({ ...journey, group: "" }));
        }
        json(response, 200, { journeys });
        return;
      }
      const forgetJourneyMatch = !anonymous && request.method === "DELETE" ? url.pathname.match(/^\/api\/journeys\/([a-z0-9-]{1,60})$/) : null;
      if (forgetJourneyMatch) {
        requireMutationAuth(request, hosted ? publicOrigins : origin, csrfToken);
        // Committed flows are the repository's; only kept journeys are forgotten from here.
        if (!account && registry.currentRoot()) { json(response, 409, { error: "That journey is committed in the repository; remove the file there." }); return; }
        journeyStore().forget(forgetJourneyMatch[1]);
        json(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        if (account) {
          json(response, 200, {
            csrfToken, mode: "public", product: "Tapp", root: null, repository: null, repositories: [],
            contract: customerProductContract, supportedPlatforms: ["web"], runners: [],
            access: "account", email: account.email, signInProvider,
            accepts: ["url"],
            selfHostOnly: ["path", "github", "bundle", "app", "apk"],
          });
          return;
        }
        if (anonymous) {
          json(response, 200, {
            csrfToken, mode: "public", product: "Tapp", root: null, repository: null, repositories: [],
            contract: customerProductContract, supportedPlatforms: ["web"], runners: [],
            access: "anonymous", signInProvider,
            // The prompt screen offers folders, bundle ids and builds. None of them can work in
            // a hosted Studio — there is no Mac, no simulator and no access to the visitor's
            // disk — so say so here rather than letting the UI offer them.
            accepts: ["url"],
            selfHostOnly: ["path", "github", "bundle", "app", "apk"],
          });
          return;
        }
        json(response, 200, { csrfToken, mode: hosted ? "managed" : "local", product: "Tapp", root: hosted ? null : registry.currentRoot(), repository: hosted ? hostedRepository(registry.current()) : registry.current(), repositories: hosted ? registry.list().map(hostedRepository) : registry.list(), contract: customerProductContract, supportedPlatforms: customerProductContract.targetPlatforms, runners: runnerSummary({ hosted }) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/repositories") { json(response, 200, hosted ? { current:hostedRepository(registry.current()), repositories:registry.list().map(hostedRepository) } : { current: registry.current(), repositories: registry.list() }); return; }
      if (request.method === "GET" && url.pathname === "/api/audits") { const audits = listAudits(50, evidenceOwner); const explores = anonymous ? [] : listBuildExplores(50, evidenceOwner); json(response, 200, { audits: hosted ? hostedPayload(audits) : audits, explores: hosted ? hostedPayload(explores) : explores }); return; }
      const filesMatch = url.pathname.match(/^\/api\/captures\/([A-Za-z0-9._-]{1,128})\/files$/);
      if (request.method === "GET" && filesMatch) {
        if (!visibleToOwner(filesMatch[1], evidenceOwner)) { response.writeHead(404); response.end("Not found"); return; }
        const files = captureFiles(filesMatch[1]);
        if (!files) { json(response, 404, { error: "No such capture" }); return; }
        json(response, 200, files);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/project") { json(response, 200, hosted ? hostedPayload(projectSnapshot(registry)) : projectSnapshot(registry)); return; }
      if (request.method === "GET" && url.pathname === "/api/live-session") { json(response, 200, liveSession || { active:false }); return; }
      if (request.method === "GET" && url.pathname === "/api/live-session/frame") {
        if (!liveSession?.active) { json(response, 409, { error:"No active live session" }); return; }
        const engine = await import("./index.js");
        const frame = await engine.captureInteractiveSessionFrame(1000);
        if (frame?.error) { json(response, 500, { error:frame.error }); return; }
        const data = Buffer.from(frame.data, "base64");
        response.writeHead(200, { "content-type":frame.mimeType || "image/jpeg", "content-length":data.length, "cache-control":"no-store", "x-content-type-options":"nosniff" });
        response.end(data);
        return;
      }

      const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9]{20})$/);
      if (request.method === "GET" && jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (job && !jobVisible(job)) { response.writeHead(404); response.end("Not found"); return; }
        if (!job) { json(response, 404, { error: "No such operation" }); return; }
        json(response, 200, publicJob(job, { hosted }));
        return;
      }
      // Answering an ask. Only the operator may: an anonymous visitor is never asked (see the
      // explore operation below), and this is the one place typed credentials pass through the
      // server — straight to the engine's response file (0600), optionally into the encrypted
      // actor store, and nowhere else. They are not logged and not kept on the job.
      const jobInputMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9]{20})\/input$/);
      if (request.method === "POST" && jobInputMatch) {
        if (anonymous) { response.writeHead(401); response.end("Sign in to answer a run"); return; }
        requireMutationAuth(request, hosted ? publicOrigins : origin, csrfToken);
        const job = jobs.get(jobInputMatch[1]);
        if (job && !jobVisible(job)) { response.writeHead(404); response.end("Not found"); return; }
        if (!job || !job.input || !job.inputResponsePath) { json(response, 409, { error: "This run is not waiting for anything" }); return; }
        const body = await readJsonBody(request);
        const action = ["submit", "defaults", "skip", "dont_ask"].includes(body.action) ? body.action : "skip";
        const values = action === "submit" && body.values && typeof body.values === "object"
          ? Object.fromEntries(Object.entries(body.values).filter(([k, v]) => typeof k === "string" && typeof v === "string").map(([k, v]) => [k.slice(0, 64), v.slice(0, 512)]))
          : {};
        fs.writeFileSync(job.inputResponsePath, JSON.stringify({ requestId: job.input.requestId, action, values }), { mode: 0o600 });
        if (action === "submit" && body.remember === true && job.actorTarget) {
          new ActorStore(job.actorRoot ? { root: job.actorRoot } : {}).write(job.actorTarget, job.actorName || "default", { credentials: { email: values.email || "", password: values.password || "" } });
        }
        json(response, 200, { ok: true, action });
        return;
      }
      const jobFrameMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9]{20})\/frame$/);
      if (request.method === "GET" && jobFrameMatch && jobs.get(jobFrameMatch[1]) && !jobVisible(jobs.get(jobFrameMatch[1]))) { response.writeHead(404); response.end("Not found"); return; }
      if (request.method === "GET" && jobFrameMatch) {
        const job = jobs.get(jobFrameMatch[1]);
        if (job && !job.latestFrame && job.liveSimulator && job.status === "running") {
          // An iOS exploration drives the booted simulator; photograph it (throttled) the way a
          // live session does, so the stage shows the device while the run happens.
          const engine = await import("./index.js");
          const frame = await engine.captureScreenshotImage(1000);
          if (frame?.error) { json(response, 404, { error: frame.error }); return; }
          const data = Buffer.from(frame.data, "base64");
          response.writeHead(200, { "content-type": frame.mimeType || "image/jpeg", "content-length": data.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
          response.end(data);
          return;
        }
        if (!job?.latestFrame || !fs.existsSync(job.latestFrame)) { json(response, 404, { error: "No exploration frame yet" }); return; }
        const data = fs.readFileSync(job.latestFrame);
        response.writeHead(200, { "content-type": job.latestFrame.endsWith(".jpg") || job.latestFrame.endsWith(".jpeg") ? "image/jpeg" : "image/png", "content-length": data.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        response.end(data);
        return;
      }
      const captureMatch = url.pathname.match(/^\/evidence\/captures\/([A-Za-z0-9._-]{1,128})(?:\/(.*))?$/);
      if (request.method === "GET" && captureMatch) {
        if (!visibleToOwner(captureMatch[1], evidenceOwner)) { response.writeHead(404); response.end("Not found"); return; }
        const file = capturePath(captureMatch[1], captureMatch[2] || "report.html");
        if (!file) { response.writeHead(404); response.end("Not found"); return; }
        serveFile(response, file);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/repositories/select") {
        requireMutationAuth(request, hosted ? publicOrigins : origin, csrfToken);
        const busy = lanes.running(OPERATOR_LANE);
        if (busy) throw Object.assign(new Error(`Operation '${busy.operation}' is still running`), { statusCode: 409 });
        if (liveSession?.active) throw Object.assign(new Error("End the active live session before changing repositories"), { statusCode:409 });
        const body = await readJsonBody(request);
        const repository = registry.select(body.id);
        json(response, 200, { repository: hosted ? hostedRepository(repository) : repository });
        return;
      }

      if (request.method !== "POST" || !url.pathname.startsWith("/api/operations/")) { response.writeHead(404); response.end("Not found"); return; }
      requireMutationAuth(request, hosted ? publicOrigins : origin, csrfToken);
      const body = await readJsonBody(request);
      const operation = url.pathname.slice("/api/operations/".length);
      // "What should tapp test?" — a repository on this machine or on GitHub becomes the current
      // project; a build is explored directly; a URL goes to `audit`; a business name is not
      // something Tapp can resolve yet, and says so instead of guessing.
      if (operation === "open") {
        const prompt = classifyPrompt(body.input);
        if (liveSession?.active) throw Object.assign(new Error("End the active live session before opening another project"), { statusCode: 409 });
        if (prompt.kind === "path") {
          if (anonymous) {
            logUsage("self-host.answered", { visitor: visitorId.slice(0, 8), kind: "path" });
            json(response, 200, { kind: "self-host", target: prompt.value, command: `npx -y @aarwitz/tapp@latest app ${prompt.value}`,
              message: `A folder on your machine is not visible from the cloud. Open it with the Studio there: npx -y @aarwitz/tapp@latest app ${prompt.value}` });
            return;
          }
          if (hosted) throw Object.assign(new Error("A hosted Studio cannot open a path on your machine; run `tapp app /path/to/repo` locally"), { statusCode: 400 });
          const resolved = prompt.value.startsWith("~") ? path.join(os.homedir(), prompt.value.slice(1)) : path.resolve(prompt.value);
          if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw Object.assign(new Error(`No folder at ${resolved}`), { statusCode: 400 });
          const repository = registry.addExisting(resolved);
          json(response, 200, { kind: "repository", repository: hosted ? hostedRepository(repository) : repository });
          return;
        }
        if (prompt.kind === "github") {
          if (anonymous) {
            logUsage("self-host.answered", { visitor: visitorId.slice(0, 8), kind: "github" });
            json(response, 200, { kind: "self-host", target: prompt.value, command: "npx -y @aarwitz/tapp@latest app",
              message: `Cloning and building ${prompt.value} needs a machine with your toolchain on it. Run the Studio there and paste the same thing: npx -y @aarwitz/tapp@latest app` });
            return;
          }
          const job = startJob(operation, async (progress) => ({ kind: "repository", repository: await registry.cloneGithub(prompt.value, progress) }), null);
          json(response, 202, { job: publicJob(job, { hosted }) });
          return;
        }
        if (prompt.kind === "business") {
          json(response, 200, { kind: "business", message: `I can't find a business's website or app from a name yet — paste its URL and I'll audit it read-only, or open its repository.` });
          return;
        }
        json(response, 200, { kind: prompt.kind, value: prompt.value });
        return;
      }
      if (operation === "explore-build") {
        if (anonymous) {
          const asked = classifyPrompt(body.input);
          logUsage("self-host.answered", { visitor: visitorId.slice(0, 8), kind: asked.kind });
          const where = asked.kind === "apk" ? "an Android device or emulator" : "a Mac with an iOS simulator";
          json(response, 200, { kind: "self-host", target: asked.value, command: "npx -y @aarwitz/tapp@latest app",
            message: `Running ${asked.value || "a build"} needs ${where}, which the cloud does not have. Start the Studio on that machine: npx -y @aarwitz/tapp@latest app` });
          return;
        }
        if (hosted) throw Object.assign(new Error("Builds are explored on the machine that has the simulator; run the Studio locally"), { statusCode: 400 });
        const prompt = classifyPrompt(body.input);
        if (!["bundle", "app", "apk"].includes(prompt.kind)) throw Object.assign(new Error("Give a bundle id (com.company.app), a simulator .app, or an .apk"), { statusCode: 400 });
        const job = startJob(operation, async (progress) => {
          const engine = await import("./index.js");
          job.platform = prompt.kind === "apk" ? "android" : "ios";
          job.liveSimulator = job.platform === "ios";
          const forward = (entry) => progress({ phase: "explore", text: entry.narrative || `${entry.action || 0}/${entry.max || 0} actions · ${entry.states || 0} states`, ...(entry.action ? { current: entry.action, total: entry.max } : {}), ...(entry.screen ? { screen: entry.screen } : {}), ...(entry.screenshot ? { screenshot: entry.screenshot } : {}) });
          let result;
          if (prompt.kind === "apk") {
            progress({ phase: "runtime", text: `Installing ${path.basename(prompt.value)} on the connected Android device` });
            result = await engine.runQaAndroid({ apkPath: prompt.value, appId: String(body.appId || ""), maxActions: Number(body.maxActions) || 40, timeout: Number(body.timeout) || 600, onProgress: forward });
          } else {
            let bundleId = prompt.value;
            if (prompt.kind === "app") {
              progress({ phase: "runtime", text: `Installing ${path.basename(prompt.value)} on the booted simulator` });
              const installed = await engine.installAppOnBootedSim(prompt.value, { onStatus: (text) => progress({ phase: "runtime", text }) });
              if (installed?.error) throw new Error(installed.error);
              bundleId = installed.bundleId;
            }
            progress({ phase: "runtime", text: `Launching ${bundleId} on the booted simulator` });
            result = await engine.runQaIos({ bundleId, maxActions: Number(body.maxActions) || 40, timeout: Number(body.timeout) || 600, device: String(body.device || ""), onProgress: forward });
          }
          if (result?.error) throw Object.assign(new Error(result.error), { details: result.details || {} });
          const structured = result.structured;
          markPromptStarted(structured);
          return structured;
        }, null);
        json(response, 202, { job: publicJob(job, { hosted }) });
        return;
      }
      // A website audit needs no repository: it is read-only against a URL and writes a capture.
      // Going inside a website: a full exploration that can stop at a sign-in and ask. Operator
      // only — a public Studio asking a stranger for their login to another site is
      // phishing-shaped, so a visitor is told to run this on their own machine instead.
      if (operation === "explore") {
        if (anonymous) {
          json(response, 200, { kind: "self-host", command: "npx -y @aarwitz/tapp@latest app",
            message: "Going inside a site means signing in, and that is something to do on your own machine. Start the Studio there: npx -y @aarwitz/tapp@latest app" });
          return;
        }
        let target;
        try { target = new URL(String(body.url || "")); } catch { throw Object.assign(new Error("Explore needs a valid http(s) URL"), { statusCode: 400 }); }
        if (!/^https?:$/.test(target.protocol)) throw Object.assign(new Error("Explore needs a valid http(s) URL"), { statusCode: 400 });
        const actorName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(String(body.actor || "")) ? String(body.actor) : "default";
        const responsePath = path.join(os.tmpdir(), `tapp-input-${crypto.randomBytes(8).toString("hex")}.json`);
        const actorRoot = actorRootFor() || "";
        const job = startJob(operation, async (progress) => {
          const engine = await import("./index.js");
          const result = await engine.runQaWeb({
            url: target.href, maxActions: Number(body.maxActions) || 40, timeout: Number(body.timeout) || 600,
            interactive: true, inputResponsePath: responsePath, inputWaitSec: 180, actor: actorName, actorRoot,
            onProgress: (entry) => progress({ phase: entry.awaitInput ? "ask" : "explore", text: entry.narrative || `${entry.action || 0}/${entry.max || 0} actions · ${entry.states || 0} screens`, ...(entry.action ? { current: entry.action, total: entry.max } : {}), ...(entry.screen ? { screen: entry.screen } : {}), ...(entry.screenshot ? { screenshot: entry.screenshot } : {}), ...(entry.awaitInput ? { awaitInput: entry.awaitInput } : {}), ...(entry.inputResolved ? { inputResolved: entry.inputResolved } : {}) }),
          });
          if (result?.error) throw Object.assign(new Error(result.error), { details: result.details || {} });
          markPromptStarted(result.structured);
          if (ownerKey && result.structured?.capture?.id) setCaptureOwner(result.structured.capture.id, ownerKey);
          return result.structured;
        }, null, { lane: ownerKey || OPERATOR_LANE });
        if (account) logUsage("explore.start", { account: account.id.slice(0, 8), host: safeHost(target.href) });
        job.ownerKey = ownerKey;
        job.inputResponsePath = responsePath;
        job.actorTarget = target.href;
        job.actorName = actorName;
        job.actorRoot = actorRoot;
        json(response, 202, { job: publicJob(job, { hosted }) });
        return;
      }
      // Replay a committed journey from the open project's .tapp/flows/. Web journeys run here
      // with a recording; an iOS or Android journey needs the simulator or device, so it is
      // answered with the command to run it where that is.
      if (operation === "run-flow") {
        if (anonymous) { json(response, 401, { error: "Sign in to replay a journey" }); return; }
        const store = journeyStore();
        const root = !account ? registry.currentRoot() : null;
        const name = String(body.name || "").replace(/\.ya?ml$/i, "");
        if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,120}$/.test(name) || name.includes("..")) throw Object.assign(new Error("That is not a journey name"), { statusCode: 400 });
        // A repository journey may sit in a subfolder; a kept one is a flat slug in its store.
        const flowPath = root ? path.join(root, ".tapp", "flows", `${name}.yml`) : store.flowPath(name);
        if (!flowPath.startsWith(store.root + path.sep) || !fs.existsSync(flowPath)) throw Object.assign(new Error(`No journey named ${name}`), { statusCode: 404 });
        const { loadFlowFile, inferFlowPlatform } = await import("./flow-runtime.js");
        const flow = loadFlowFile(flowPath);
        const platform = inferFlowPlatform(flow);
        const shown = root ? path.relative(root, flowPath) : `${name}.yml`;
        if (platform !== "web") {
          json(response, 200, { kind: "self-host", command: `npx -y @aarwitz/tapp@latest run ${shown}`,
            message: `${flow.name || name} runs on ${platform === "android" ? "an Android device or emulator" : "an iOS simulator"}, which the Studio does not have. Run it where that is: npx -y @aarwitz/tapp@latest run ${shown}` });
          return;
        }
        const slug = root ? name : slugify(name);
        const job = startJob(operation, async (progress) => {
          const result = await replayJourney({ store, slug, flow, actorRoot: actorRootFor() || "", ownerKey, progress });
          logUsage("journey.run", { owner: (ownerKey || "operator").slice(0, 13), passed: result.passed });
          return result;
        }, null, { lane: ownerKey || OPERATOR_LANE });
        job.ownerKey = ownerKey;
        json(response, 202, { job: publicJob(job, { hosted }) });
        return;
      }
      if (operation === "audit") {
        let target;
        try { target = new URL(String(body.url || "")); } catch { throw Object.assign(new Error("Audit needs a valid http(s) URL"), { statusCode: 400 }); }
        if (!/^https?:$/.test(target.protocol)) throw Object.assign(new Error("Audit needs a valid http(s) URL"), { statusCode: 400 });
        // Six was a quiet default with nothing in the UI to change it, so every site a visitor
        // pointed the Studio at came back as a six-page site — including ones with a dozen
        // sections, a login and a booking flow. A read-only page costs a couple of seconds.
        const pages = Math.max(1, Math.min(20, Number(body.pages) || 12));
        // Mint the capture id here so the evidence can be stamped as this visitor's before the
        // run writes anything; a capture that appeared first and was claimed afterwards would be
        // briefly readable by everyone.
        const auditCapture = `web-audit-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
        if (ownerKey) {
          try { fs.mkdirSync(path.join(captureRoot(), auditCapture), { recursive: true }); } catch { /* the run reports its own failure */ }
          setCaptureOwner(auditCapture, ownerKey);
        }
        const auditStartedMs = Date.now();
        usage.audits += 1;
        logUsage("audit.start", { visitor: (visitorId || "operator").slice(0, 8), host: safeHost(target.href), pages, totalAudits: usage.audits });
        const job = startJob(operation, async (progress) => {
          const { auditWebSite } = await import("./web-audit.js");
          progress({ phase: "runtime", text: `Opening ${target.href} read-only (up to ${pages} pages, nothing will be clicked)` });
          const summary = await auditWebSite({
            url: target.href, pages, delayMs: 750, capturesDir: captureRoot(), captureId: auditCapture,
            // Hand the page's screenshot to the progress channel: the Studio's device stage polls
            // the job's latest frame, and without this an audit watches an empty panel for its
            // whole run while the real screenshots sit in the capture.
            onPage: (page, n) => progress({ phase: "explore", text: `Audited ${page.url} — ${page.findings.length} finding(s)`, current: n, total: pages, ...(page.frame || page.screenshot ? { screenshot: page.frame || page.screenshot } : {}) }),
          });
          logUsage("audit.done", {
            visitor: (visitorId || "operator").slice(0, 8), host: safeHost(target.href),
            pagesAudited: summary?.pagesAudited ?? null,
            findings: summary?.issueCount ?? (summary?.issues || []).length,
            seconds: Math.round((Date.now() - auditStartedMs) / 100) / 10,
          });
          return hosted ? hostedPayload(summary) : summary;
        }, null, { lane: ownerKey || OPERATOR_LANE });
        job.ownerKey = ownerKey;
        json(response, 202, { job: publicJob(job, { hosted }) });
        return;
      }
      const root = registry.currentRoot();
      if (!root) throw Object.assign(new Error("Open a repository first: tapp app /path/to/repo"), { statusCode: 409 });
      const repositoryId = registry.current().id;
      const job = startJob(operation, async (progress) => {
        const engine = await import("./index.js");
        const runtime = runtimeRequest(body);
        if (liveSession?.active && !["session-act", "session-save-flow", "session-end"].includes(operation)) throw new Error("End the active live session before starting another build, exploration, validation, or gate operation");
        if (operation === "session-start") {
          const selected = selectedTarget(root, body);
          const prepared = await prepareProductTarget({ projectDir: root, platform:selected.platform, target:selected.id, buildIos:engine.buildAppForSim, installIos:engine.installAppOnBootedSim, buildAndroid:engine.buildAndroidApp, onProgress:progress });
          let result;
          try {
            if (selected.platform === "ios") {
              result = await engine.startIosInteractiveSession(prepared.runtime.bundleId, {
                ...(runtime.testEmail ? { OCQA_TEST_EMAIL:runtime.testEmail } : {}),
                ...(runtime.testPassword ? { OCQA_TEST_PASSWORD:runtime.testPassword } : {}),
              });
            } else if (selected.platform === "android") {
              result = await engine.startAndroidInteractiveSession(prepared.runtime.appId, { serial:runtime.serial, apkPath:prepared.runtime.apkPath, clearData:true, testEmail:runtime.testEmail || "", testPassword:runtime.testPassword || "" });
            } else {
              let sessionUrl = prepared.runtime.url || "";
              if (!sessionUrl) {
                liveManagedRuntime = await engine.startManagedWebTarget({ root, requestedTarget:selected.id, timeout:runtime.timeout, onStatus:(text) => progress({ phase:"runtime", text }) });
                if (liveManagedRuntime?.error) throw Object.assign(new Error(liveManagedRuntime.error), { details:liveManagedRuntime.details || {} });
                sessionUrl = liveManagedRuntime.url;
              }
              result = await engine.startWebInteractiveSession(sessionUrl, { testEmail:runtime.testEmail || "", testPassword:runtime.testPassword || "" });
            }
            if (result?.error) throw new Error(result.error);
            liveSession = publicInteractiveResult(result, { active:true, platform:selected.platform, targetId:selected.id, targetName:selected.name, url:result?.url || "" });
            return liveSession;
          } catch (error) {
            if (liveManagedRuntime) await engine.stopManagedWebTarget(liveManagedRuntime).catch(() => {});
            liveManagedRuntime = null;
            liveSession = null;
            throw error;
          }
        }
        if (operation === "session-act") {
          if (!liveSession?.active) throw new Error("Start a live session first");
          const allowed = new Set(["tap", "type", "wait", "back", "swipe", "tree"]);
          const action = String(body.action || "");
          if (!allowed.has(action)) throw new Error(`Unsupported live-session action '${action}'`);
          const result = await engine.actInteractiveSession({
            action,
            ...(typeof body.id === "string" && body.id ? { id:body.id } : {}),
            ...(typeof body.label === "string" && body.label ? { label:body.label } : {}),
            ...(typeof body.text === "string" ? { text:body.text } : {}),
            ...(typeof body.direction === "string" ? { direction:body.direction } : {}),
            ...(Number.isFinite(Number(body.timeoutMs)) ? { timeoutMs:Number(body.timeoutMs) } : {}),
          });
          liveSession = publicInteractiveResult(result, liveSession);
          if (result?.error || result?.status === "error") throw new Error(result.error || result.detail || "Live-session action failed");
          return liveSession;
        }
        if (operation === "session-save-flow") {
          if (!liveSession?.active) throw new Error("Start and drive a live session before saving a Flow");
          const saved = await engine.saveInteractiveSessionFlow({
            projectDir:root,
            name:body.name,
            addFinalAssertion:body.addFinalAssertion !== false,
            replace:body.replace === true,
            // Repository-managed web runtimes are resolved again by the
            // target-aware product gate; ephemeral localhost ports never enter source.
            url:"",
          });
          return { path:saved.path, flow:saved.flow, yaml:saved.yaml, replaced:saved.replaced };
        }
        if (operation === "session-end") {
          await engine.endInteractiveSession();
          if (liveManagedRuntime) await engine.stopManagedWebTarget(liveManagedRuntime).catch(() => {});
          liveManagedRuntime = null;
          liveSession = null;
          return { active:false, ended:true };
        }
        if (operation === "initialize") {
          if (body.explore !== true) {
            return initializeProductProject({ projectDir: root, mode: body.write === false ? "inspect" : body.refresh === true ? "refresh" : "write", platform: String(body.platform || "").toLowerCase(), maxContracts: runtime.maxContracts });
          }
          if (!readProductProject({ projectDir: root }).model) await initializeProductProject({ projectDir: root, mode: "write", maxContracts: runtime.maxContracts });
          const selected = selectedTarget(root, body);
          const prepared = await prepareProductTarget({
            projectDir:root,
            platform:selected.platform,
            target:selected.id,
            buildIos:engine.buildAppForSim,
            buildAndroid:engine.buildAndroidApp,
            onProgress:progress,
          });
          return initializeProductProject({
            projectDir: root, mode: "explore",
            platform: selected.platform,
            target: selected.platform === "ios" ? prepared.runtime.appPath : selected.id,
            bundleId: prepared.runtime.bundleId || selected.runtime?.bundleId || "", appId: prepared.runtime.appId || selected.runtime?.applicationId || "",
            apkPath: prepared?.runtime.apkPath, serial: runtime.serial,
            scheme: selected.build?.proposedScheme || "", configuration: selected.build?.configuration || "Debug",
            maxActions: runtime.maxActions, timeout: runtime.timeout, maxContracts: runtime.maxContracts,
            testEmail: runtime.testEmail, testPassword: runtime.testPassword,
            runExploration: engine.runInitExploration,
            onProgress: (entry) => progress({ phase: "explore", text: entry.narrative || `${entry.action || 0}/${entry.max || runtime.maxActions} actions · ${entry.states || 0} states`, current: entry.action || 0, total: entry.max || runtime.maxActions, screen: entry.screen, screenshot: entry.screenshot }),
            onStatus: (text) => progress({ phase: "runtime", text }),
          });
        }
        if (operation === "gate") {
          const selected = selectedTarget(root, body);
          const prepared = await prepareProductTarget({ projectDir: root, platform: selected.platform, target: selected.id, buildIos: engine.buildAppForSim, buildAndroid: engine.buildAndroidApp, onProgress: progress });
          return runProductGate({
            projectDir: root, platform: selected.platform, target: selected.id,
            url: prepared.runtime.url || "", appPath: prepared.runtime.appPath || "", bundleId: prepared.runtime.bundleId || "", appId: prepared.runtime.appId || "", apkPath: prepared.runtime.apkPath || "", serial: runtime.serial,
            actions: runtime.maxActions, timeout: runtime.timeout, baseline: body.baseline || "", testEmail: runtime.testEmail, testPassword: runtime.testPassword, onProgress: progress,
          });
        }
        throw new Error(`Unsupported product operation '${operation}'`);
      }, repositoryId);
      json(response, 202, { job: publicJob(job, { hosted }) });
    } catch (error) {
      if (!response.headersSent) json(response, error.statusCode || 500, { error: error.message || String(error), ...(error.code ? { code: error.code } : {}) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port) || 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  const launchUrl = `${origin}/?token=${encodeURIComponent(sessionToken)}`;
  if (launch) openBrowser(launchUrl);
  return {
    root: registry.currentRoot(), origin, launchUrl, server, registry,
    close: async () => {
      if (liveSession?.active) {
        const engine = await import("./index.js");
        await engine.endInteractiveSession().catch(() => {});
        if (liveManagedRuntime) await engine.stopManagedWebTarget(liveManagedRuntime).catch(() => {});
      }
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (usageHeartbeat) clearInterval(usageHeartbeat);
      if (checkTimer) clearInterval(checkTimer);
      if (firstCheck) clearTimeout(firstCheck);
      if (egressProxy) { await egressProxy.close().catch(() => {}); restoreEgressEnv(); }
      registry.close();
    },
  };
}

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
import {
  createProductBaseline,
  generateProductPlan,
  initializeProductProject,
  installProductCi,
  prepareProductCi,
  prepareProductTarget,
  promoteProductPlan,
  readProductProject,
  reviewProductPlan,
  runProductGate,
  validateProductPlan,
} from "./product-operations.js";

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
    createdAt: job.createdAt, completedAt: job.completedAt || null, progress: job.progress.slice(-80),
    result: hosted ? hostedPayload(job.result) : job.result || null,
    error: job.error || null,
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

function serveLoginPage(response, { failed = false } = {}) {
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
    <label>Username<input name="username" autocomplete="username" placeholder="username" required></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" placeholder="password" required></label>
    <button type="submit">Launch Tapp →</button>
  </form>
  <p><small>Demo access: demo / demo. Uploaded repositories run in a restricted pilot workspace.</small></p>
</main></body></html>`;
  response.writeHead(failed ? 401 : 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
}

export async function startBrowserProduct({ projectDir, port = 0, launch = false, workspaceRoot, githubProvider, publicOrigin = "", trustedProxyToken = "", directLogin = null } = {}) {
  const hosted = !!trustedProxyToken || !!directLogin;
  // publicOrigin accepts a comma-separated allowlist; the first entry is canonical.
  const publicOrigins = String(publicOrigin || "").split(",").map((value) => value.trim().replace(/\/$/, "")).filter(Boolean);
  if (hosted && !publicOrigins.length) throw new Error("Hosted browser mode requires an explicit publicOrigin");
  const loginFailures = { count: 0, windowStartedAt: 0 };
  const registry = new BrowserWorkspaceRegistry({ initialProjectDir: projectDir, workspaceRoot, githubProvider });
  const serverStartedAt = new Date().toISOString();
  const sessionToken = crypto.randomBytes(32).toString("base64url");
  const csrfToken = crypto.randomBytes(24).toString("base64url");
  const jobs = new Map();
  let activeMutation = null;
  let liveSession = null;
  let liveManagedRuntime = null;
  let origin = "";

  const startJob = (operation, work, repositoryId = registry.current()?.id || null) => {
    if (activeMutation) {
      const error = new Error(`Operation '${activeMutation.operation}' is still running`);
      error.statusCode = 409;
      throw error;
    }
    const job = { id: crypto.randomBytes(10).toString("hex"), operation, repositoryId, status: "running", createdAt: new Date().toISOString(), progress: [] };
    const progress = (entry) => {
      const normalized = typeof entry === "string" ? { text: entry } : entry || {};
      job.progress.push({ at: new Date().toISOString(), phase: normalized.phase || operation, text: String(normalized.text || "").slice(-1200), ...(normalized.current ? { current: normalized.current, total: normalized.total } : {}) });
      if (job.progress.length > 200) job.progress.splice(0, job.progress.length - 200);
    };
    jobs.set(job.id, job);
    activeMutation = job;
    Promise.resolve().then(() => work(progress)).then((result) => {
      job.status = "completed";
      job.result = result;
    }).catch((error) => {
      job.status = "failed";
      job.error = { message: error.message || String(error), ...(error.details ? { details: error.details } : {}) };
    }).finally(() => {
      job.completedAt = new Date().toISOString();
      if (activeMutation === job) activeMutation = null;
    });
    return job;
  };

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
      if (!authenticated && directLogin) {
        if (request.method === "GET" && url.pathname === "/login") { serveLoginPage(response, { failed: url.searchParams.has("failed") }); return; }
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
            response.writeHead(303, { location: "/login?failed=1" });
            response.end();
            return;
          }
          response.writeHead(303, { location: "/", "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Secure; Path=/` });
          response.end();
          return;
        }
        if (request.method === "GET" && !url.pathname.startsWith("/api/")) { response.writeHead(302, { location: "/login" }); response.end(); return; }
      }
      if (!authenticated) { response.writeHead(401, { "content-type": "text/plain; charset=utf-8" }); response.end(directLogin ? "Sign in at /login to continue." : "Open Tapp from the authenticated launch URL printed by the CLI."); return; }

      if (request.method === "GET" && url.pathname === "/") {
        serveBrowserIndex(response, hosted ? (proxyAuthenticated ? { apiBase:"/api/tapp", loginUrl:"/solutions/tapp" } : { apiBase:"", loginUrl:"/login" }) : {});
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
        const file = assetPath(url.pathname);
        if (!file) { response.writeHead(404); response.end("Not found"); return; }
        serveFile(response, file);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        json(response, 200, { csrfToken, mode: hosted ? "managed" : "local", product: "Tapp", root: hosted ? null : registry.currentRoot(), repository: hosted ? hostedRepository(registry.current()) : registry.current(), repositories: hosted ? registry.list().map(hostedRepository) : registry.list(), contract: customerProductContract, supportedPlatforms: customerProductContract.targetPlatforms, runners: runnerSummary({ hosted }) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/repositories") { json(response, 200, hosted ? { current:hostedRepository(registry.current()), repositories:registry.list().map(hostedRepository) } : { current: registry.current(), repositories: registry.list() }); return; }
      if (request.method === "GET" && url.pathname === "/api/repositories/github") { json(response, 200, { repositories: await registry.listGithub() }); return; }
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
        if (!job) { json(response, 404, { error: "No such operation" }); return; }
        json(response, 200, publicJob(job, { hosted }));
        return;
      }
      const captureMatch = url.pathname.match(/^\/evidence\/captures\/([A-Za-z0-9._-]{1,128})(?:\/(.*))?$/);
      if (request.method === "GET" && captureMatch) {
        const file = capturePath(captureMatch[1], captureMatch[2] || "report.html");
        if (!file) { response.writeHead(404); response.end("Not found"); return; }
        serveFile(response, file);
        return;
      }

      const uploadFileMatch = url.pathname.match(/^\/api\/repositories\/uploads\/(upload_[a-f0-9]{20})\/files$/);
      if (request.method === "PUT" && uploadFileMatch) {
        requireMutationAuth(request, hosted ? publicOrigins : origin, csrfToken);
        let relativePath;
        try { relativePath = decodeURIComponent(String(request.headers["x-tapp-relative-path"] || "")); }
        catch { throw Object.assign(new Error("Repository file path header is invalid"), { statusCode: 400 }); }
        const result = await registry.writeUploadFile(uploadFileMatch[1], relativePath, request, request.headers["content-length"]);
        json(response, 200, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/repositories/uploads") {
        requireMutationAuth(request, hosted ? publicOrigins : origin, csrfToken);
        json(response, 201, registry.createUpload(await readJsonBody(request)));
        return;
      }
      const uploadCompleteMatch = url.pathname.match(/^\/api\/repositories\/uploads\/(upload_[a-f0-9]{20})\/complete$/);
      if (request.method === "POST" && uploadCompleteMatch) {
        requireMutationAuth(request, hosted ? publicOrigins : origin, csrfToken);
        if (liveSession?.active) throw Object.assign(new Error("End the active live session before changing repositories"), { statusCode:409 });
        const repository = registry.finishUpload(uploadCompleteMatch[1]);
        json(response, 200, { repository: hosted ? hostedRepository(repository) : repository });
        return;
      }
      const uploadAbortMatch = url.pathname.match(/^\/api\/repositories\/uploads\/(upload_[a-f0-9]{20})$/);
      if (request.method === "DELETE" && uploadAbortMatch) {
        requireMutationAuth(request, hosted ? publicOrigins : origin, csrfToken);
        json(response, 200, { aborted: registry.abortUpload(uploadAbortMatch[1]) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/repositories/select") {
        requireMutationAuth(request, hosted ? publicOrigins : origin, csrfToken);
        if (activeMutation) throw Object.assign(new Error(`Operation '${activeMutation.operation}' is still running`), { statusCode: 409 });
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
      if (operation === "connect-github") {
        if (liveSession?.active) throw Object.assign(new Error("End the active live session before changing repositories"), { statusCode:409 });
        const job = startJob(operation, (progress) => registry.cloneGithub(body.repository, progress), null);
        json(response, 202, { job: publicJob(job, { hosted }) });
        return;
      }
      const root = registry.currentRoot();
      if (!root) throw Object.assign(new Error("Connect a local folder or GitHub repository first"), { statusCode: 409 });
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
            onProgress: (entry) => progress({ phase: "explore", text: `${entry.action || 0}/${entry.max || runtime.maxActions} actions · ${entry.states || 0} states` }),
            onStatus: (text) => progress({ phase: "runtime", text }),
          });
        }
        if (operation === "review") return reviewProductPlan({ projectDir: root, approve: body.approve || [], reject: body.reject || [], defer: body.defer || [] });
        if (operation === "generate") return generateProductPlan({ projectDir: root });
        if (operation === "validate") {
          const selected = selectedTarget(root, body);
          const prepared = await prepareProductTarget({ projectDir: root, platform: selected.platform, target: selected.id, buildIos: engine.buildAppForSim, installIos: engine.installAppOnBootedSim, buildAndroid: engine.buildAndroidApp, onProgress: progress });
          return validateProductPlan({
            projectDir: root, items: body.items || [], platform: selected.platform, target: selected.id,
            url: prepared.runtime.url || "", bundleId: prepared.runtime.bundleId || "", appId: prepared.runtime.appId || "", apkPath: prepared.runtime.apkPath || "", serial: runtime.serial,
            timeout: runtime.timeout, testEmail: runtime.testEmail, testPassword: runtime.testPassword,
            startWebTarget: engine.startManagedWebTarget, stopWebTarget: engine.stopManagedWebTarget, onProgress: progress,
          });
        }
        if (operation === "promote") return promoteProductPlan({ projectDir: root, items: body.items || [] });
        if (operation === "ci-preview") return prepareProductCi({ projectDir: root, actionRef: body.actionRef, defaultBranch: body.defaultBranch || "main" });
        if (operation === "ci-install") return installProductCi({ projectDir: root, actionRef: body.actionRef, defaultBranch: body.defaultBranch || "main", replace: body.replace === true, allowUnresolved: body.allowUnresolved === true });
        if (operation === "gate") {
          const selected = selectedTarget(root, body);
          const prepared = await prepareProductTarget({ projectDir: root, platform: selected.platform, target: selected.id, buildIos: engine.buildAppForSim, buildAndroid: engine.buildAndroidApp, onProgress: progress });
          return runProductGate({
            projectDir: root, platform: selected.platform, target: selected.id,
            url: prepared.runtime.url || "", appPath: prepared.runtime.appPath || "", bundleId: prepared.runtime.bundleId || "", appId: prepared.runtime.appId || "", apkPath: prepared.runtime.apkPath || "", serial: runtime.serial,
            actions: runtime.maxActions, timeout: runtime.timeout, baseline: body.baseline || "", testEmail: runtime.testEmail, testPassword: runtime.testPassword, onProgress: progress,
          });
        }
        if (operation === "baseline") {
          const project = readProductProject({ projectDir: root });
          const run = project.evidence.find((item) => item.id === body.runId);
          if (!run?.reportPath) throw new Error("Select a completed local gate run before creating a baseline");
          const platform = run.report?.platform || String(body.platform || "").toLowerCase();
          const target = run.report?.targetKey || body.target || "";
          return createProductBaseline({ projectDir: root, reportPath: run.reportPath, platform, target, replace: body.replace === true });
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
      registry.close();
    },
  };
}

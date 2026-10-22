import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeInteractiveElements, startBrowserProduct } from "../mcp-server/src/browser-product.js";

function cookieFrom(response) {
  return response.headers.get("set-cookie").split(";", 1)[0];
}

test("browser live controls keep one actionable semantic target and discard hittable static descendants", () => {
  const elements = normalizeInteractiveElements([
    { type:"XCUIElementType(rawValue: 48)", role:"text", label:"Open Counter Playground", hittable:true, enabled:true },
    { type:"XCUIElementType(rawValue: 9)", role:"button", label:"Open Counter Playground", hittable:true, enabled:true },
    { type:"XCUIElementType(rawValue: 43)", role:"other", id:"chevron.forward", hittable:true, enabled:true },
    { type:"XCUIElementType(rawValue: 9)", role:"button", label:"Add", hittable:false, enabled:false },
    { type:"android.widget.EditText", role:"input", id:"email", label:"Email", hittable:true, enabled:true },
  ]);
  assert.deepEqual(elements.map((element) => element.id || element.label), ["Open Counter Playground", "Add", "email"]);
  assert.equal(elements[0].clickable, true);
  assert.equal(elements[1].clickable, false);
  assert.equal(elements[2].role, "input");
});

test("browser product is a loopback, authenticated, CSRF-protected adapter over shared operations", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-browser-product-"));
  fs.writeFileSync(path.join(root, "index.html"), "<h1>Browser fixture</h1>");
  const product = await startBrowserProduct({ projectDir: root, port: 0, launch: false });
  try {
    assert.match(product.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const denied = await fetch(`${product.origin}/api/project`);
    assert.equal(denied.status, 401);

    const bootstrap = await fetch(product.launchUrl, { redirect: "manual" });
    assert.equal(bootstrap.status, 303);
    assert.equal(bootstrap.headers.get("location"), "/");
    const cookie = cookieFrom(bootstrap);
    assert.doesNotMatch(cookie, /token=/i, "the bootstrap query name is not reused as a readable cookie name");
    const page = await fetch(product.origin, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /What should tapp test\?/);

    const sessionResponse = await fetch(`${product.origin}/api/session`, { headers: { cookie } });
    const session = await sessionResponse.json();
    assert.equal(session.root, fs.realpathSync(root));
    assert.deepEqual(session.contract.targetPlatforms, ["ios", "android", "web"]);
    assert.deepEqual(session.contract.repositorySources, ["local-path", "github"]);
    assert.deepEqual(session.contract.views.map((view) => view.id), ["overview", "runs"]);
    assert.equal(session.contract.operations.includes("audit"), true);
    assert.equal(session.contract.operations.includes("ci-install"), false);
    const rejected = await fetch(`${product.origin}/api/operations/initialize`, { method: "POST", headers: { cookie, origin: product.origin, "content-type": "application/json" }, body: "{}" });
    assert.equal(rejected.status, 403);

    const startedResponse = await fetch(`${product.origin}/api/operations/initialize`, {
      method: "POST",
      headers: { cookie, origin: product.origin, "x-tapp-csrf": session.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ write: true }),
    });
    assert.equal(startedResponse.status, 202);
    const started = await startedResponse.json();
    let job;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      job = await fetch(`${product.origin}/api/jobs/${started.job.id}`, { headers: { cookie } }).then((response) => response.json());
      if (job.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(job.status, "completed", job.error?.message);
    const projectState = await fetch(`${product.origin}/api/project`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(projectState.state.inspected, true);
    assert.equal(fs.existsSync(path.join(root, ".tapp", "application-model.json")), true);
  } finally {
    await product.close();
  }
});

test("hosted browser mode trusts only the authenticated relay and preserves same-origin CSRF", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-browser-hosted-"));
  fs.writeFileSync(path.join(root, "index.html"), "<h1>Hosted fixture</h1>");
  const token = "test-proxy-token-with-enough-entropy";
  const publicOrigin = "https://marketing.example";
  const product = await startBrowserProduct({ projectDir:root, launch:false, trustedProxyToken:token, publicOrigin });
  try {
    assert.equal((await fetch(`${product.origin}/api/session`)).status, 401);
    const proxyHeaders = { "x-tapp-proxy-token":token };
    const hostedPage = await fetch(product.origin, { headers:proxyHeaders });
    assert.equal(hostedPage.status, 200);
    const contentSecurityPolicy = hostedPage.headers.get("content-security-policy");
    assert.match(contentSecurityPolicy, /style-src 'self' 'unsafe-inline'/, "runtime map and progress styles must render");
    assert.match(contentSecurityPolicy, /script-src 'self'(?:;|$)/, "hosted mode must not enable inline scripts");
    const hostedHtml = await hostedPage.text();
    assert.match(hostedHtml, /name="tapp-api-base" content="\/api\/tapp"/);
    assert.match(hostedHtml, /name="tapp-login-url" content="\/solutions\/tapp"/);
    const sessionResponse = await fetch(`${product.origin}/api/session`, { headers:proxyHeaders });
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json();
    assert.equal(session.mode, "managed");
    assert.equal(session.root, null);
    assert.equal(session.repository.root, undefined);
    assert.deepEqual(session.runners.map((runner) => runner.label), ["Managed macOS runner", "Managed Android runner", "Hosted Chromium"]);
    assert.equal(session.runners.find((runner) => runner.platform === "ios").status, "unavailable");

    const projectState = await fetch(`${product.origin}/api/project`, { headers:proxyHeaders }).then((response) => response.json());
    assert.equal(projectState.repository.root, undefined);
    assert.equal(String(projectState.paths?.root || "").startsWith("/"), false);

    const wrongOrigin = await fetch(`${product.origin}/api/operations/initialize`, {
      method:"POST", headers:{ ...proxyHeaders, origin:"https://attacker.example", "x-tapp-csrf":session.csrfToken, "content-type":"application/json" }, body:"{}",
    });
    assert.equal(wrongOrigin.status, 403);
    const accepted = await fetch(`${product.origin}/api/operations/initialize`, {
      method:"POST", headers:{ ...proxyHeaders, origin:publicOrigin, "x-tapp-csrf":session.csrfToken, "content-type":"application/json" }, body:JSON.stringify({ write:true }),
    });
    assert.equal(accepted.status, 202);
  } finally {
    await product.close();
  }
});

test("a public Studio exposes only read-only audits, scoped to the visitor who ran them", async () => {
  // app.runtapp.com lets anyone in. The boundary is what an anonymous visitor may reach: their
  // own audit evidence and nothing else. Repositories, the live session, the gate and other
  // people's captures must stay invisible, on a machine where they all share one directory.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-public-home-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-public-ws-"));
  const previousHome = process.env.TAPP_HOME;
  process.env.TAPP_HOME = home;
  const plant = (id, owner) => {
    const dir = path.join(home, "captures", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "audit.json"), JSON.stringify({ url: "https://planted.test", pagesAudited: 1, issues: [] }));
    fs.writeFileSync(path.join(dir, "report.html"), "<h1>evidence</h1>");
    if (owner) fs.writeFileSync(path.join(dir, ".visitor"), owner);
  };
  plant("web-audit-someone-else", "f".repeat(32));
  plant("web-audit-operator", null);

  const product = await startBrowserProduct({ port: 0, publicOrigin: "https://app.runtapp.com", publicAccess: true, workspaceRoot });
  let cookie = "";
  const call = async (pathname, init = {}) => {
    const response = await fetch(`${product.origin}${pathname}`, {
      ...init, redirect: "manual",
      headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) },
    });
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return response;
  };
  try {
    // Getting in needs no account, and the visitor is given a durable identity.
    assert.equal((await call("/")).status, 200);
    assert.match(cookie, /^tapp_visitor=[a-f0-9]{32}$/);

    // The session says what this deployment can honestly do, and names nothing on the machine.
    const session = await (await call("/api/session")).json();
    assert.equal(session.access, "anonymous");
    assert.deepEqual(session.accepts, ["url"]);
    assert.deepEqual(session.repositories, []);
    assert.equal(session.root, null);

    // Captures belonging to anyone else are not listed and not served.
    assert.deepEqual((await (await call("/api/audits")).json()).audits, []);
    for (const id of ["web-audit-someone-else", "web-audit-operator"]) {
      assert.equal((await call(`/api/captures/${id}/files`)).status, 404, `${id} must not be readable`);
      assert.equal((await call(`/evidence/captures/${id}/report.html`)).status, 404, `${id} evidence must not be served`);
    }

    // Everything that would act on this machine needs an account.
    for (const [method, pathname] of [
      ["GET", "/api/repositories"], ["GET", "/api/project"], ["GET", "/api/live-session"],
      ["POST", "/api/repositories/select"],
      ["POST", "/api/operations/gate"], ["POST", "/api/operations/initialize"],
    ]) {
      assert.equal((await call(pathname, { method })).status, 401, `${method} ${pathname} must require an account`);
    }

    // A visitor may still *ask* about a repository or a build, and is told where it runs instead
    // of being refused — five of the landing page's six examples used to dead-end on a bare 401.
    const csrfToken = (await (await call("/api/session")).json()).csrfToken;
    const ask = (operation, input) => call(`/api/operations/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tapp-csrf": csrfToken, origin: "https://app.runtapp.com" },
      body: JSON.stringify({ input }),
    });
    for (const [operation, input] of [["open", "owner/repo"], ["open", "~/code/my-app"], ["explore-build", "app-release.apk"], ["explore-build", "com.company.app"]]) {
      const answer = await ask(operation, input);
      assert.equal(answer.status, 200, `${operation} ${input} should answer, not refuse`);
      const body = await answer.json();
      assert.equal(body.kind, "self-host", `${operation} ${input} should say where it runs`);
      assert.match(body.command, /@aarwitz\/tapp@latest app/, `${operation} ${input} should hand over a command`);
    }
    // Asking must not have started anything or created a project on this machine.
    assert.deepEqual((await (await call("/api/session")).json()).repositories, []);

    // A visitor does see evidence stamped as their own.
    const visitorId = cookie.split("=")[1];
    plant("web-audit-mine", visitorId);
    assert.deepEqual((await (await call("/api/audits")).json()).audits.map((a) => a.id), ["web-audit-mine"]);
    assert.equal((await call("/evidence/captures/web-audit-mine/report.html")).status, 200);
  } finally {
    await product.close();
    if (previousHome === undefined) delete process.env.TAPP_HOME; else process.env.TAPP_HOME = previousHome;
  }
});

test("a public Studio records that it was used, without recording who or what was in the link", async (t) => {
  // The Studio served strangers while recording nothing, so "is anyone using this?" had no
  // answer. It now logs to stdout for journald. What it must NOT log is the part that made the
  // first version of this leak: an engine error quotes the URL it failed on, query string and
  // all, which is how a token in someone's link reaches a log that promised not to hold one.
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-usage-ws-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-usage-home-"));
  const previousHome = process.env.TAPP_HOME;
  process.env.TAPP_HOME = home;

  const lines = [];
  const realLog = console.log;
  console.log = (...args) => { lines.push(args.join(" ")); };
  t.after(() => { console.log = realLog; });

  const product = await startBrowserProduct({ port: 0, publicOrigin: "https://app.runtapp.com", publicAccess: true, workspaceRoot });
  let cookie = "";
  const call = async (pathname, init = {}) => {
    const response = await fetch(`${product.origin}${pathname}`, {
      ...init, redirect: "manual",
      headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) },
    });
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return response;
  };
  try {
    await call("/");
    await call("/api/project"); // refused

    const usage = lines.filter((line) => line.startsWith("tapp-usage ")).map((line) => JSON.parse(line.slice("tapp-usage ".length)));
    const arrival = usage.find((entry) => entry.event === "visitor.new");
    assert.ok(arrival, "a new visitor is recorded");
    assert.match(arrival.visitor, /^[a-f0-9]{8}$/, "a short prefix, not the whole visitor id");

    const refusal = usage.find((entry) => entry.event === "refused");
    assert.equal(refusal.status, 401);
    assert.equal(refusal.reason, "not-public");

    // A public host is scanned constantly. In one afternoon this recorded 404 "new visitors",
    // 383 of which were bots probing for .env files — a reading that answers "is anyone using
    // this?" with noise. Scanners are refused and counted, but neither logged line by line nor
    // counted as visitors.
    const before = lines.length;
    for (const probe of ["/wp-content/.env", "/.git/config", "/vendor/phpunit.xml", "/aws/credentials"]) {
      assert.equal((await call(probe)).status, 401, `${probe} must still be refused`);
    }
    const added = lines.slice(before)
      .filter((line) => line.startsWith("tapp-usage "))
      .map((line) => JSON.parse(line.slice("tapp-usage ".length)));
    assert.deepEqual(added, [], `secret probes must not fill the log: ${JSON.stringify(added)}`);

    // Nothing that identifies a person or carries a secret.
    const serialized = JSON.stringify(usage);
    assert.doesNotMatch(serialized, /\bcookie\b/i);
    for (const entry of usage) {
      assert.equal(entry.ip, undefined, "no IP address is collected");
      if (entry.visitor) assert.equal(entry.visitor.length, 8);
    }
  } finally {
    console.log = realLog;
    await product.close();
    if (previousHome === undefined) delete process.env.TAPP_HOME; else process.env.TAPP_HOME = previousHome;
  }
});

test("sign-in returns to the requested destination and refuses a foreign one", async () => {
  // runtapp.com's hero hands a target over as /?target=... Losing it at the login bounce makes
  // the handoff pointless, and reflecting it unchecked would make /login an open redirect.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-browser-return-"));
  fs.writeFileSync(path.join(root, "index.html"), "<h1>Return fixture</h1>");
  const appOrigin = "https://app.runtapp.com";
  const product = await startBrowserProduct({
    projectDir: root, launch: false,
    publicOrigin: appOrigin,
    directLogin: { username: "demo", password: "demo" },
  });
  const signIn = (next) => fetch(`${product.origin}/api/auth`, {
    method: "POST", redirect: "manual",
    headers: { origin: appOrigin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "demo", password: "demo", next }).toString(),
  });
  try {
    // The bounce remembers a real destination, and stays quiet about the default one.
    const wanted = await fetch(`${product.origin}/?target=runtapp.com`, { redirect: "manual" });
    assert.equal(wanted.headers.get("location"), "/login?next=%2F%3Ftarget%3Druntapp.com");
    assert.equal((await fetch(product.origin, { redirect: "manual" })).headers.get("location"), "/login");

    const page = await fetch(`${product.origin}/login?next=%2F%3Ftarget%3Druntapp.com`).then((r) => r.text());
    assert.match(page, /name="next" value="\/\?target=runtapp\.com"/);

    assert.equal((await signIn("/?target=runtapp.com")).headers.get("location"), "/?target=runtapp.com");

    // Anything that could leave the origin falls back to the Studio root.
    for (const hostile of ["//evil.example", "https://evil.example", "/\\evil.example", "/login?x=1"]) {
      assert.equal((await signIn(hostile)).headers.get("location"), "/", `next=${hostile} must not be honoured`);
      assert.doesNotMatch(
        await fetch(`${product.origin}/login?next=${encodeURIComponent(hostile)}`).then((r) => r.text()),
        /name="next"/,
        `next=${hostile} must not be reflected into the form`,
      );
    }
  } finally {
    await product.close();
  }
});

test("hosted direct login serves its own sign-in page and mints a first-party session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-browser-direct-"));
  fs.writeFileSync(path.join(root, "index.html"), "<h1>Direct fixture</h1>");
  const appOrigin = "https://app.runtapp.com";
  const relayOrigin = "https://marketing.example";
  const product = await startBrowserProduct({
    projectDir: root, launch: false,
    trustedProxyToken: "test-proxy-token-with-enough-entropy",
    publicOrigin: `${appOrigin},${relayOrigin}`,
    directLogin: { username: "demo", password: "demo" },
  });
  try {
    const version = await fetch(`${product.origin}/api/version`);
    assert.equal(version.status, 200);
    assert.equal((await version.json()).product, "tapp-browser");

    const unauthedPage = await fetch(product.origin, { redirect: "manual" });
    assert.equal(unauthedPage.status, 302);
    assert.equal(unauthedPage.headers.get("location"), "/login");
    assert.match(await fetch(`${product.origin}/login`).then((r) => r.text()), /form method="post" action="\/api\/auth"/);
    assert.equal((await fetch(`${product.origin}/api/session`)).status, 401);

    const badLogin = await fetch(`${product.origin}/api/auth`, {
      method: "POST", redirect: "manual",
      headers: { origin: appOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: "username=demo&password=wrong",
    });
    assert.equal(badLogin.status, 303);
    assert.equal(badLogin.headers.get("location"), "/login?failed=1");
    assert.equal(badLogin.headers.get("set-cookie"), null);

    const crossOrigin = await fetch(`${product.origin}/api/auth`, {
      method: "POST", redirect: "manual",
      headers: { origin: "https://attacker.example", "content-type": "application/x-www-form-urlencoded" },
      body: "username=demo&password=demo",
    });
    assert.equal(crossOrigin.status, 403);

    // Real browsers serialize Origin as the literal string "null" (not absent) for a
    // navigation-type POST — an actual <form> submit, not fetch/XHR — when the response
    // carries Referrer-Policy: no-referrer, which this app sets globally. That is expected,
    // spec-compliant behavior for every browser hitting the login form, so it must still
    // succeed provided the browser-guaranteed Sec-Fetch-Site header confirms same-origin.
    const nullOriginSameSite = await fetch(`${product.origin}/api/auth`, {
      method: "POST", redirect: "manual",
      headers: { origin: "null", "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
      body: "username=demo&password=demo",
    });
    assert.equal(nullOriginSameSite.status, 303, "a no-referrer navigation POST's Origin: null must not be treated as cross-origin");

    const nullOriginNoSignal = await fetch(`${product.origin}/api/auth`, {
      method: "POST", redirect: "manual",
      headers: { origin: "null", "content-type": "application/x-www-form-urlencoded" },
      body: "username=demo&password=demo",
    });
    assert.equal(nullOriginNoSignal.status, 403, "an opaque origin without a same-origin Sec-Fetch-Site signal must still be rejected");

    const login = await fetch(`${product.origin}/api/auth`, {
      method: "POST", redirect: "manual",
      headers: { origin: appOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: "username=demo&password=demo",
    });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get("location"), "/");
    const cookie = String(login.headers.get("set-cookie")).split(";")[0];
    assert.match(cookie, /tapp_local_session=/);

    const page = await fetch(product.origin, { headers: { cookie } });
    const html = await page.text();
    assert.match(html, /name="tapp-api-base" content=""/, "direct sessions must call the adapter's own /api routes");
    assert.match(html, /name="tapp-login-url" content="\/login"/);

    const session = await fetch(`${product.origin}/api/session`, { headers: { cookie } }).then((r) => r.json());
    assert.equal(session.mode, "managed");
    const accepted = await fetch(`${product.origin}/api/operations/initialize`, {
      method: "POST",
      headers: { cookie, origin: appOrigin, "x-tapp-csrf": session.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ write: true }),
    });
    assert.equal(accepted.status, 202);
    const relayAccepted = await fetch(`${product.origin}/api/operations/initialize`, {
      method: "POST",
      headers: { cookie, origin: relayOrigin, "x-tapp-csrf": session.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ write: true }),
    });
    assert.equal([202, 409].includes(relayAccepted.status), true, "the relay origin must stay on the allowlist");
  } finally {
    await product.close();
  }
});

// The audit renders pages in Chromium; hosted unit jobs run without a browser.
test("the Studio audits a website read-only without a repository and lists it with its capture", { skip: process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1" && "real browser tests are skipped" }, async () => {
  const http = await import("node:http");
  const site = http.createServer((request, response) => {
    if (request.url === "/missing.css") { response.writeHead(404); response.end("nope"); return; }
    response.writeHead(200, { "content-type":"text/html" });
    response.end('<!doctype html><title>Acme</title><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/missing.css"><body><h1>Acme</h1></body>');
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-browser-audit-home-"));
  const priorHome = process.env.TAPP_HOME;
  process.env.TAPP_HOME = home;
  const product = await startBrowserProduct({ launch:false });
  try {
    const bootstrap = await fetch(product.launchUrl, { redirect:"manual" });
    const cookie = cookieFrom(bootstrap);
    const session = await fetch(`${product.origin}/api/session`, { headers:{ cookie } }).then((response) => response.json());
    assert.equal(session.root, null);
    const mutationHeaders = { cookie, origin:product.origin, "x-tapp-csrf":session.csrfToken, "content-type":"application/json" };

    // Removed paths are gone: no uploads, no GitHub, no planning or CI operations.
    assert.equal((await fetch(`${product.origin}/api/repositories/uploads`, { method:"POST", headers:mutationHeaders, body:"{}" })).status, 404);
    assert.equal((await fetch(`${product.origin}/api/repositories/github`, { headers:{ cookie } })).status, 404);
    const rejected = await fetch(`${product.origin}/api/operations/ci-install`, { method:"POST", headers:mutationHeaders, body:"{}" });
    assert.equal(rejected.status, 409, "operations that need a repository say so when none is open");

    const bad = await fetch(`${product.origin}/api/operations/audit`, { method:"POST", headers:mutationHeaders, body:JSON.stringify({ url:"ftp://nope" }) });
    assert.equal(bad.status, 400);
    const started = await fetch(`${product.origin}/api/operations/audit`, { method:"POST", headers:mutationHeaders, body:JSON.stringify({ url:`http://127.0.0.1:${site.address().port}/`, pages:2 }) }).then((response) => response.json());
    let job;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      job = await fetch(`${product.origin}/api/jobs/${started.job.id}`, { headers:{ cookie } }).then((response) => response.json());
      if (job.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(job.status, "completed", job.error?.message);
    assert.equal(job.result.readOnly, true);
    assert.equal(job.result.issueCount, 1);
    assert.match(job.result.issues[0].title, /404 asset: \/missing\.css/);
    assert.ok(job.progress.some((entry) => /nothing will be clicked/.test(entry.text)));

    const audits = await fetch(`${product.origin}/api/audits`, { headers:{ cookie } }).then((response) => response.json());
    assert.equal(audits.audits.length, 1);
    assert.equal(audits.audits[0].id, job.result.capture.id);
    assert.equal(audits.audits[0].issueCount, 1);
    const report = await fetch(`${product.origin}/evidence/captures/${audits.audits[0].id}/report.html`, { headers:{ cookie } });
    assert.equal(report.status, 200, "the evidence page the engine wrote is served, not re-rendered");
  } finally {
    await product.close();
    site.close();
    if (priorHome === undefined) delete process.env.TAPP_HOME; else process.env.TAPP_HOME = priorHome;
  }
});

test("a visitor is never asked for a login, and cannot answer one", async () => {
  // Asking a stranger for their login to another site is phishing-shaped. The public Studio
  // tells a visitor to go inside from their own machine, and the answer endpoint is closed to
  // anyone who is not the operator.
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-ask-ws-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-ask-home-"));
  const previousHome = process.env.TAPP_HOME;
  process.env.TAPP_HOME = home;
  const product = await startBrowserProduct({ port: 0, publicOrigin: "https://app.runtapp.com", publicAccess: true, workspaceRoot });
  let cookie = "";
  const call = async (pathname, init = {}) => {
    const response = await fetch(`${product.origin}${pathname}`, { ...init, redirect: "manual", headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) } });
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return response;
  };
  try {
    await call("/");
    const csrfToken = (await (await call("/api/session")).json()).csrfToken;
    const headers = { "content-type": "application/json", "x-tapp-csrf": csrfToken, origin: "https://app.runtapp.com" };

    const explore = await call("/api/operations/explore", { method: "POST", headers, body: JSON.stringify({ url: "https://example.com" }) });
    assert.equal(explore.status, 200);
    const answer = await explore.json();
    assert.equal(answer.kind, "self-host", "a visitor is told to go inside from their own machine, not asked to sign in here");
    assert.match(answer.command, /@aarwitz\/tapp@latest app/);

    const reply = await call("/api/jobs/00000000000000000000/input", { method: "POST", headers, body: JSON.stringify({ action: "submit", values: { password: "x" } }) });
    assert.equal(reply.status, 401, "a visitor cannot answer a run's sign-in prompt");
  } finally {
    await product.close();
    if (previousHome === undefined) delete process.env.TAPP_HOME; else process.env.TAPP_HOME = previousHome;
  }
});

test("an account signs in by email link, may go inside a site, and sees only its own evidence and test accounts", async () => {
  // ADR-0009 slice 2. A public Studio has three kinds of person: a visitor (audits only), an
  // account (can explore, be asked, and have tapp remember test accounts), and the operator.
  // The account is an email address and a link — there is no password anywhere in this flow.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-account-home-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-account-ws-"));
  const outbox = path.join(home, "outbox");
  const previous = { home: process.env.TAPP_HOME, outbox: process.env.TAPP_MAIL_OUTBOX, key: process.env.TAPP_MAIL_RESEND_KEY };
  process.env.TAPP_HOME = home;
  process.env.TAPP_MAIL_OUTBOX = outbox;
  delete process.env.TAPP_MAIL_RESEND_KEY;
  const origin = "https://app.runtapp.com";
  const product = await startBrowserProduct({ port: 0, publicOrigin: origin, publicAccess: true, workspaceRoot });
  const jar = new Map();
  const call = async (pathname, init = {}) => {
    const response = await fetch(`${product.origin}${pathname}`, {
      ...init, redirect: "manual",
      headers: { ...(init.headers || {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    for (const set of response.headers.getSetCookie?.() || [response.headers.get("set-cookie")].filter(Boolean)) {
      const [pair, ...attrs] = set.split(";");
      const [name, value] = pair.split("=");
      if (attrs.some((a) => /max-age=0/i.test(a))) jar.delete(name.trim()); else jar.set(name.trim(), value);
    }
    return response;
  };
  const mutate = (pathname, body, method = "POST") => call(pathname, { method, headers: { origin, "x-tapp-csrf": csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
  let csrf = "";
  try {
    csrf = (await (await call("/api/session")).json()).csrfToken;

    // Asking for a link says the same thing whether or not the address exists, and the link
    // goes to the outbox — never to stdout.
    const asked = await mutate("/api/auth/link", { email: "Owner@Example.test" });
    assert.equal(asked.status, 200);
    assert.deepEqual(await asked.json(), { ok: true, sent: true });
    assert.equal((await mutate("/api/auth/link", { email: "not an address" })).status, 400);
    const mail = fs.readdirSync(outbox).map((name) => fs.readFileSync(path.join(outbox, name), "utf8")).join("\n");
    assert.match(mail, /To: owner@example\.test/);
    const link = mail.match(/https:\/\/app\.runtapp\.com\/auth\/([A-Za-z0-9_-]{20,})/);
    assert.ok(link, "the email carries the sign-in link on the public origin");

    // Following it signs in; following it again does not.
    const followed = await call(`/auth/${link[1]}`);
    assert.equal(followed.status, 303);
    assert.equal(followed.headers.get("location"), "/?signin=done");
    assert.ok(jar.has("tapp_account"), "a session cookie was set");
    assert.equal((await call(`/auth/${link[1]}`)).headers.get("location"), "/?signin=expired", "a link works once");

    const session = await (await call("/api/session")).json();
    assert.equal(session.access, "account");
    assert.equal(session.email, "owner@example.test");
    assert.deepEqual(session.accepts, ["url"]);
    csrf = session.csrfToken;

    // An account may do more than a visitor, but this machine is still not theirs.
    for (const [method, pathname] of [["GET", "/api/repositories"], ["GET", "/api/project"], ["GET", "/api/live-session"], ["POST", "/api/operations/gate"]]) {
      assert.equal((await call(pathname, { method })).status, 401, `${method} ${pathname} stays the operator's`);
    }
    // Going inside is accepted (a visitor gets the self-host answer instead; see the test above).
    const explore = await mutate("/api/operations/explore", { url: "http://127.0.0.1:9/" });
    assert.equal(explore.status, 202, "an account starts a real exploration");
    const job = (await explore.json()).job;
    assert.equal((await call(`/api/jobs/${job.id}`)).status, 200, "the account sees its own job");

    // Test accounts are listed by name only, and forgetting one works.
    const { ActorStore } = await import("../mcp-server/src/actor-store.js");
    const { AccountStore } = await import("../mcp-server/src/account-store.js");
    const accountId = fs.readdirSync(path.join(home, "accounts", "accounts"))[0].replace(/\.json$/, "");
    new ActorStore({ root: new AccountStore().actorRoot(accountId) }).write("https://fitness.example.test/login", "coach", { credentials: { email: "coach@fitness.example.test", password: "Secret-Value-1" } });
    const actors = await (await call("/api/actors")).json();
    assert.equal(actors.apps[0].host, "fitness.example.test");
    assert.equal(actors.apps[0].actors[0].actor, "coach");
    assert.equal(actors.apps[0].actors[0].hasCredentials, true);
    assert.doesNotMatch(JSON.stringify(actors), /Secret-Value-1|coach@fitness\.example\.test/, "values never leave the store");
    assert.equal((await mutate("/api/actors/fitness.example.test/coach", undefined, "DELETE")).status, 200);
    assert.deepEqual((await (await call("/api/actors")).json()).apps, []);

    // A second account sees none of it.
    jar.clear();
    csrf = (await (await call("/api/session")).json()).csrfToken;
    const before = new Set(fs.readdirSync(outbox));
    await mutate("/api/auth/link", { email: "someone@else.test" });
    const newest = fs.readdirSync(outbox).find((name) => !before.has(name));
    const secondLink = fs.readFileSync(path.join(outbox, newest), "utf8").match(/\/auth\/([A-Za-z0-9_-]{20,})/)[1];
    await call(`/auth/${secondLink}`);
    assert.equal((await (await call("/api/session")).json()).email, "someone@else.test");
    assert.equal((await call(`/api/jobs/${job.id}`)).status, 404, "another account's job is invisible");
    assert.deepEqual((await (await call("/api/actors")).json()).apps, []);

    // Signing out ends the session.
    csrf = (await (await call("/api/session")).json()).csrfToken;
    assert.equal((await mutate("/api/auth/signout", {})).status, 200);
    assert.equal((await (await call("/api/session")).json()).access, "anonymous");

  } finally {
    await product.close();
    for (const [key, value] of [["TAPP_HOME", previous.home], ["TAPP_MAIL_OUTBOX", previous.outbox], ["TAPP_MAIL_RESEND_KEY", previous.key]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("with Cloudflare Access in front, a verified assertion signs in and tapp sends no email", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-access-home-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-access-ws-"));
  const outbox = path.join(home, "outbox");
  const previous = { home: process.env.TAPP_HOME, outbox: process.env.TAPP_MAIL_OUTBOX };
  process.env.TAPP_HOME = home;
  process.env.TAPP_MAIL_OUTBOX = outbox;
  // The verifier is Cloudflare's job; here it is a stand-in that accepts exactly one assertion.
  const accessVerifier = { verify: async (token) => { if (token !== "good-assertion") throw new Error("Access token signature does not verify"); return { email: "Owner@Example.test" }; } };
  const product = await startBrowserProduct({ port: 0, publicOrigin: "https://app.runtapp.com", publicAccess: true, workspaceRoot, accessVerifier });
  try {
    const session = await (await fetch(`${product.origin}/api/session`)).json();
    assert.equal(session.signInProvider, "cloudflare", "the Studio knows where Sign in goes");

    const refused = await fetch(`${product.origin}/auth/cloudflare`, { redirect: "manual", headers: { "cf-access-jwt-assertion": "forged" } });
    assert.equal(refused.headers.get("location"), "/?signin=expired");
    assert.doesNotMatch(String(refused.headers.get("set-cookie")), /tapp_account=/, "a bad assertion opens nothing");

    const accepted = await fetch(`${product.origin}/auth/cloudflare`, { redirect: "manual", headers: { "cf-access-jwt-assertion": "good-assertion" } });
    assert.equal(accepted.status, 303);
    assert.equal(accepted.headers.get("location"), "/?signin=done");
    const cookie = accepted.headers.get("set-cookie").split(";")[0];
    assert.match(cookie, /^tapp_account=/);
    const me = await (await fetch(`${product.origin}/api/session`, { headers: { cookie } })).json();
    assert.equal(me.access, "account");
    assert.equal(me.email, "owner@example.test");
    assert.equal(fs.existsSync(outbox), false, "no email was sent");
  } finally {
    await product.close();
    for (const [key, value] of [["TAPP_HOME", previous.home], ["TAPP_MAIL_OUTBOX", previous.outbox]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("without Cloudflare Access configured the path says so, and Sign in is the email link", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-noaccess-home-"));
  const previous = process.env.TAPP_HOME; process.env.TAPP_HOME = home;
  const product = await startBrowserProduct({ port: 0, publicOrigin: "https://app.runtapp.com", publicAccess: true, workspaceRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tapp-noaccess-ws-")), accessVerifier: null });
  try {
    assert.equal((await (await fetch(`${product.origin}/api/session`)).json()).signInProvider, "email");
    assert.equal((await fetch(`${product.origin}/auth/cloudflare`, { redirect: "manual" })).status, 404);
  } finally { await product.close(); if (previous === undefined) delete process.env.TAPP_HOME; else process.env.TAPP_HOME = previous; }
});

test("an account keeps a run that got somewhere as a journey, sees its status, and can forget it", async () => {
  // ADR-0009 slice 3. The capture is planted the way an exploration writes it; keeping it
  // produces a Flow in the runner's vocabulary under the account's own journey store.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-journey-home-"));
  const previous = process.env.TAPP_HOME; process.env.TAPP_HOME = home;
  const origin = "https://app.runtapp.com";
  const accessVerifier = { verify: async () => ({ email: "owner@example.test" }) };
  const product = await startBrowserProduct({ port: 0, publicOrigin: origin, publicAccess: true, workspaceRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tapp-journey-ws-")), accessVerifier });
  try {
    const signedIn = await fetch(`${product.origin}/auth/cloudflare`, { redirect: "manual", headers: { "cf-access-jwt-assertion": "x" } });
    const cookie = signedIn.headers.get("set-cookie").split(";")[0];
    const session = await (await fetch(`${product.origin}/api/session`, { headers: { cookie } })).json();
    const accountId = fs.readdirSync(path.join(home, "accounts", "accounts"))[0].replace(/\.json$/, "");
    const call = (pathname, init = {}) => fetch(`${product.origin}${pathname}`, { ...init, headers: { cookie, origin, "x-tapp-csrf": session.csrfToken, "content-type": "application/json", ...(init.headers || {}) } });

    // A capture this account owns, with a path through a sign-in.
    const captureId = "web-20261022-150000";
    const dir = path.join(home, "captures", captureId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "provenance.json"), JSON.stringify({ kind: "explore", platform: "web", target: "https://fitness.example.test/", createdAt: "2026-10-22T15:00:00.000Z", origin: "studio-prompt" }));
    fs.writeFileSync(path.join(dir, "ocqa-markers.txt"), [
      'OCQA_ACTION:{"t":1,"type":"open","target":"/","via":"/"}', 'OCQA_STATE:{"t":2,"screen":"Sign in","url":"/"}',
      'OCQA_ACTION:{"t":3,"type":"login","target":"Sign in"}', 'OCQA_STATE:{"t":4,"screen":"Dashboard","url":"/"}',
      'OCQA_ACTION:{"t":5,"type":"tap","target":"Bookings"}', 'OCQA_STATE:{"t":6,"screen":"Bookings","url":"/bookings"}', "",
    ].join("\n"));
    fs.writeFileSync(path.join(dir, ".visitor"), `acct:${accountId}\n`);

    assert.deepEqual((await (await call("/api/journeys")).json()).journeys, [], "nothing kept yet");
    const kept = await (await call(`/api/captures/${captureId}/keep`, { method: "POST", body: JSON.stringify({ name: "Coach reaches bookings" }) })).json();
    assert.equal(kept.slug, "coach-reaches-bookings");
    assert.equal(kept.steps, 5);
    assert.equal(kept.signedIn, true);
    const file = path.join(home, "accounts", "journeys", accountId, "coach-reaches-bookings.yml");
    const yaml = fs.readFileSync(file, "utf8");
    assert.match(yaml, /- login:\n    email: \$TEST_EMAIL\n    password: \$TEST_PASSWORD/, "the sign-in is a variable, never a value");
    assert.match(yaml, /- assert_screen: "Bookings"/);
    assert.equal((await call(`/api/captures/${captureId}/keep`, { method: "POST", body: JSON.stringify({ name: "Coach reaches bookings" }) })).status, 409, "a name is not overwritten by accident");

    const [listed] = (await (await call("/api/journeys")).json()).journeys;
    assert.equal(listed.name, "Coach reaches bookings");
    assert.equal(listed.status, null, "never run");
    assert.equal(listed.source, "kept");

    // Someone else's capture cannot be kept, and another account sees no journeys.
    fs.writeFileSync(path.join(dir, ".visitor"), "acct:" + "0".repeat(24) + "\n");
    assert.equal((await call(`/api/captures/${captureId}/keep`, { method: "POST", body: JSON.stringify({ name: "x" }) })).status, 404);

    assert.equal((await call("/api/journeys/coach-reaches-bookings", { method: "DELETE" })).status, 200);
    assert.deepEqual((await (await call("/api/journeys")).json()).journeys, []);
    assert.equal(fs.existsSync(file), false);
  } finally { await product.close(); if (previous === undefined) delete process.env.TAPP_HOME; else process.env.TAPP_HOME = previous; }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { normalizeInteractiveElements, startBrowserProduct, dueJourneys, journeySignInPlan, withAuditPageUrls, serveFile } from "../mcp-server/src/browser-product.js";
import { discoverApps } from "../mcp-server/src/app-store-discovery.js";

test("published video can be played, measured and seeked", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-film-"));
  const file = path.join(root, "demo.mp4");
  fs.writeFileSync(file, "0123456789");
  const server = http.createServer((req, res) => serveFile(res, file, { request: req }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/demo.mp4`;
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.headers.get("content-type"), "video/mp4");
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  for (const [range, expected] of [["0-1","01"], ["7-","789"], ["-2","89"], ["8-99","89"]]) {
    const part = await fetch(url, { headers: { range: "bytes=" + range } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), expected);
  }
  const invalid = await fetch(url, { headers: { range: "bytes=10-" } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */10");
});

test("hosted findings label verified page paths without interpreting file paths as URLs", () => {
  const url = "https://sample.example/services?type=1";
  const finding = { pages: ["/services?type=1", "/private/run.html"], evidence: "/private/capture.png" };
  const audit = withAuditPageUrls({ pages: [{ url, findings: [{ screen: "/services?type=1" }] }], observations: [finding] });
  assert.deepEqual(audit.observations[0], { pages: [url, "/private/run.html"], evidence: finding.evidence });
  assert.equal(audit.pages[0].findings[0].screen, url);
});

test("a business name returns matching publishers and usable website choices", async (t) => {
  const catalog = t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url.origin, "https://itunes.apple.com");
    assert.equal(url.searchParams.get("term"), "Studio Sample");
    return Response.json({ results: [
      { trackId: 12, trackName: "Studio Sample", sellerName: "First", sellerUrl: "https://sample.example" },
      { trackId: 13, trackName: "Studio Sample Photos", sellerName: "Second", sellerUrl: "javascript:alert(1)" },
      { trackId: 14, trackName: "Other", sellerUrl: "https://other.example" },
    ] });
  });
  const result = await discoverApps("Studio Sample");
  assert.deepEqual(result.matches.map(app => app.website), ["https://sample.example/", ""]);
  assert.equal(result.matches[0].listing, "https://apps.apple.com/us/app/id12");
  assert.deepEqual(await discoverApps("studio sample"), result);
  assert.equal(catalog.mock.callCount(), 1);
});

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
    assert.deepEqual(session.contract.targetPlatforms, ["ios", "android", "web", "macos"]);
    assert.deepEqual(session.contract.repositorySources, ["local-path", "github"]);
    // Admin is declared so it can be opened at all (activateView refuses anything undeclared),
    // but it is shown only to an address listed in TAPP_ADMIN_EMAILS.
    assert.deepEqual(session.contract.views.map((view) => view.id), ["overview", "runs", "findings", "coverage", "platforms", "admin"]);
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
    assert.equal(session.plan.kind, "trial", "a new account is on its free trial");
    assert.equal(session.plan.daysLeft, 14);
    const explore = await mutate("/api/operations/explore", { url: "http://127.0.0.1:9/" });
    assert.equal(explore.status, 202, "an account starts a real exploration");
    const job = (await explore.json()).job;
    assert.equal((await call(`/api/jobs/${job.id}`)).status, 200, "the account sees its own job");

    // Once the trial has lapsed, a cloud run is refused with the reason and the way round it;
    // what the account owns is still readable (ADR-0011 §3).
    const accountFile = fs.readdirSync(path.join(home, "accounts", "accounts")).map((name) => path.join(home, "accounts", "accounts", name))
      .find((file) => JSON.parse(fs.readFileSync(file, "utf8")).email === "owner@example.test");
    const record = JSON.parse(fs.readFileSync(accountFile, "utf8"));
    record.plan = { kind: "trial", endsAt: "2026-01-01T00:00:00.000Z" };
    fs.writeFileSync(accountFile, JSON.stringify(record));
    const lapsed = await mutate("/api/operations/explore", { url: "http://127.0.0.1:9/" });
    assert.equal(lapsed.status, 402);
    const refusal = await lapsed.json();
    assert.match(refusal.error, /free trial ended on 2026-01-01/);
    assert.match(refusal.error, /npx -y @aarwitz\/tapp@latest app/, "the way round the gate is the person's own machine");
    assert.equal(refusal.plan.kind, "lapsed");
    assert.equal((await mutate("/api/journeys", { flow: "name: x\n" })).status, 402, "importing a journey is a cloud run too");
    assert.equal((await call("/api/journeys")).status, 200, "but reading what you own stays open");
    assert.equal((await call("/api/actors")).status, 200);
    assert.equal((await (await call("/api/session")).json()).plan.kind, "lapsed", "and the Studio is told");
    assert.equal((await mutate("/api/admin/plan", { accountId: record.id, kind: "paid" })).status, 403, "only the owner changes plans");
    record.plan = { kind: "paid" };
    fs.writeFileSync(accountFile, JSON.stringify(record));
    assert.equal((await (await call("/api/session")).json()).plan.kind, "paid");

    // A journey run on the owner's own machine reports its result here (ADR-0011 §4): listed
    // with where it ran, never runnable from the cloud, forgettable.
    assert.equal((await mutate("/api/journeys/report", { machine: "x" })).status, 400, "a report names the journey");
    const reported = await mutate("/api/journeys/report", { name: "Book a coach", platform: "web", url: "http://localhost:3000/", steps: 7, machine: "aarons-mac", passed: true, executed: 7, total: 7 });
    assert.equal(reported.status, 200);
    assert.equal((await reported.json()).slug, "book-a-coach");
    const listed = (await (await call("/api/journeys")).json()).journeys.find((j) => j.slug === "book-a-coach");
    assert.equal(listed.source, "reported");
    assert.equal(listed.machine, "aarons-mac");
    assert.equal(listed.status.passed, true);
    const broke = await (await mutate("/api/journeys/report", { name: "Book a coach", machine: "aarons-mac", passed: false, executed: 3, total: 7, failed: 1 })).json();
    assert.equal(broke.change, "broke", "a change between reports is news, as it is for a cloud check");
    assert.equal((await mutate("/api/operations/run-flow", { name: "book-a-coach" })).status, 404, "the cloud has no flow for a reported journey");
    assert.equal((await call("/api/journeys/book-a-coach", { method: "DELETE", headers: { origin, "x-tapp-csrf": csrf } })).status, 200);
    assert.equal((await (await call("/api/journeys")).json()).journeys.some((j) => j.slug === "book-a-coach"), false);

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

test("a kept journey is due for its daily check when its last result is older than the interval", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-10-22T18:00:00Z");
  const journeys = [
    { slug: "never", platform: "web", status: null },
    { slug: "fresh", platform: "web", status: { passed: true, at: "2026-10-22T12:00:00Z" } },
    { slug: "stale", platform: "web", status: { passed: false, at: "2026-10-21T12:00:00Z" } },
    { slug: "ios", platform: "ios", status: null },
    { slug: "reported", platform: "web", status: null, source: "reported" },
  ];
  assert.deepEqual(dueJourneys(journeys, { intervalMs: day, now }).map((j) => j.slug), ["never", "stale"], "never-run and day-old journeys are due; a fresh one, a non-web one and one that runs on somebody's own machine are not");
});

test("a journey that types its own credentials is never handed a saved session", () => {
  // Found by filming the product: a journey kept from a run that met the sign-in form starts
  // with `wait_for: Sign in`. Replaying it from the actor's saved session dropped the browser
  // inside the application, where that first step could never match — 1 of 13 steps, "failing".
  const typesCredentials = { actor: "coach", url: "https://app.example.test/", steps: [{ wait_for: "Sign in" }, { login: { email: "$TEST_EMAIL", password: "$TEST_PASSWORD" } }, { tap: "Orders" }] };
  assert.deepEqual(journeySignInPlan(typesCredentials), { signsIn: true, usesSession: false });

  // A journey kept from a run that already began inside has no sign-in form to type into; the
  // saved session is the only way back in.
  const resumesSession = { actor: "coach", url: "https://app.example.test/", steps: [{ wait_for: "Dashboard" }, { tap: "Orders" }] };
  assert.deepEqual(journeySignInPlan(resumesSession), { signsIn: false, usesSession: true });

  // Without an actor there is no session to resume, whatever the steps say.
  assert.deepEqual(journeySignInPlan({ steps: [{ tap: "Orders" }] }), { signsIn: false, usesSession: false });
  assert.deepEqual(journeySignInPlan({}), { signsIn: false, usesSession: false });
});

test("a personal access token lets a coding agent act as its owner, and only as its owner", async () => {
  // ADR-0009 slice 4: the owner's agent asks "is everything still passing?" without a browser.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-agent-home-"));
  const previous = process.env.TAPP_HOME; process.env.TAPP_HOME = home;
  const origin = "https://app.runtapp.com";
  let nextEmail = "owner@example.test";
  const accessVerifier = { verify: async () => ({ email: nextEmail }) };
  const product = await startBrowserProduct({ port: 0, publicOrigin: origin, publicAccess: true, workspaceRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tapp-agent-ws-")), accessVerifier });
  const signIn = async () => {
    const res = await fetch(`${product.origin}/auth/cloudflare`, { redirect: "manual", headers: { "cf-access-jwt-assertion": "x" } });
    const cookie = res.headers.get("set-cookie").split(";")[0];
    const { csrfToken } = await (await fetch(`${product.origin}/api/session`, { headers: { cookie } })).json();
    return { cookie, csrfToken };
  };
  try {
    const owner = await signIn();
    const asOwner = (p, init = {}) => fetch(`${product.origin}${p}`, { ...init, headers: { cookie: owner.cookie, origin, "x-tapp-csrf": owner.csrfToken, "content-type": "application/json", ...(init.headers || {}) } });

    const issued = await (await asOwner("/api/tokens", { method: "POST", body: JSON.stringify({ label: "Claude Code" }) })).json();
    assert.match(issued.token, /^tapp_/);
    assert.deepEqual((await (await asOwner("/api/tokens")).json()).tokens.map((t) => t.label), ["Claude Code"]);

    // The agent uses the token with no cookie and no CSRF header — a bearer token is never
    // sent ambiently by a browser, so the CSRF check neither applies nor blocks it.
    const asAgent = (p, init = {}) => fetch(`${product.origin}${p}`, { ...init, headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json", ...(init.headers || {}) } });
    const session = await (await asAgent("/api/session")).json();
    assert.equal(session.access, "account");
    assert.equal(session.email, "owner@example.test");
    assert.equal(session.viaToken, true, "the Studio knows this is an agent");
    assert.equal((await asAgent("/api/journeys")).status, 200, "the agent can read its owner's journeys");
    assert.equal((await asAgent("/api/actors")).status, 200);
    assert.equal((await asAgent("/api/operations/explore", { method: "POST", body: JSON.stringify({ url: "http://127.0.0.1:9/" }) })).status, 202, "and start work without a CSRF token");

    // An agent is not a person: it cannot mint or revoke tokens, so a leaked token cannot
    // outlive the revocation of itself.
    assert.equal((await asAgent("/api/tokens", { method: "POST", body: JSON.stringify({ label: "second" }) })).status, 403);
    assert.equal((await asAgent(`/api/tokens/${issued.id}`, { method: "DELETE" })).status, 403);
    // This machine stays the operator's whoever is asking.
    assert.equal((await asAgent("/api/project")).status, 401);

    // Another account's token is another account: it sees its own (empty) world, not this one.
    nextEmail = "someone@else.test";
    const stranger = await signIn();
    const strangerToken = await (await fetch(`${product.origin}/api/tokens`, { method: "POST", headers: { cookie: stranger.cookie, origin, "x-tapp-csrf": stranger.csrfToken, "content-type": "application/json" }, body: "{}" })).json();
    const strangerSession = await (await fetch(`${product.origin}/api/session`, { headers: { authorization: `Bearer ${strangerToken.token}` } })).json();
    assert.equal(strangerSession.email, "someone@else.test");
    assert.deepEqual((await (await fetch(`${product.origin}/api/tokens`, { headers: { cookie: stranger.cookie } })).json()).tokens.map((t) => t.label), ["coding agent"], "one account never lists another's tokens");

    // Revoking it stops it dead.
    assert.equal((await asOwner(`/api/tokens/${issued.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await (await asAgent("/api/session")).json()).access, "anonymous", "a revoked token is a stranger");
    assert.equal((await asAgent("/api/journeys")).status, 401);
  } finally { await product.close(); if (previous === undefined) delete process.env.TAPP_HOME; else process.env.TAPP_HOME = previous; }
});

test("a journey you already have can be put on the Studio, and only one it can actually replay", async () => {
  // A repository's committed Flow becomes a journey this account owns and tapp checks daily.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-import-home-"));
  const previous = process.env.TAPP_HOME; process.env.TAPP_HOME = home;
  const origin = "https://app.runtapp.com";
  const accessVerifier = { verify: async () => ({ email: "owner@example.test" }) };
  const product = await startBrowserProduct({ port: 0, publicOrigin: origin, publicAccess: true, workspaceRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tapp-import-ws-")), accessVerifier });
  try {
    const signedIn = await fetch(`${product.origin}/auth/cloudflare`, { redirect: "manual", headers: { "cf-access-jwt-assertion": "x" } });
    const cookie = signedIn.headers.get("set-cookie").split(";")[0];
    const { csrfToken } = await (await fetch(`${product.origin}/api/session`, { headers: { cookie } })).json();
    const post = (body) => fetch(`${product.origin}/api/journeys`, { method: "POST", headers: { cookie, origin, "x-tapp-csrf": csrfToken, "content-type": "application/json" }, body: JSON.stringify(body) });

    const yaml = [
      "# The homepage paints the coach grid — a comment the owner wrote.",
      'name: web-home-coach-grid',
      "platform: web",
      "url: https://example.test/index.html",
      "steps:",
      "- wait_for: Find the right coach.",
      "- wait_for: Top Rated Coaches",
    ].join("\n");
    const kept = await (await post({ yaml })).json();
    assert.equal(kept.slug, "web-home-coach-grid");
    assert.equal(kept.steps, 2);
    const stored = fs.readFileSync(path.join(home, "accounts", "journeys", fs.readdirSync(path.join(home, "accounts", "journeys"))[0], "web-home-coach-grid.yml"), "utf8");
    assert.match(stored, /a comment the owner wrote/, "the file is kept verbatim — comments and vars are the journey");

    const [listed] = (await (await fetch(`${product.origin}/api/journeys`, { headers: { cookie } })).json()).journeys;
    assert.equal(listed.name, "web-home-coach-grid");
    assert.equal(listed.status, null, "imported, not yet checked");
    assert.equal((await post({ yaml })).status, 409, "a name is not overwritten by accident");
    assert.equal((await post({ yaml, replace: true })).status, 200);

    // What this Studio cannot replay, it refuses at import with the reason — not mid-replay.
    const refusals = [
      [{ yaml: "" }, /Send the journey/],
      [{ yaml: "name: x\nplatform: web\nsteps:\n- wait_for: Home\n" }, /needs a `url:`/],
      [{ yaml: "name: y\nplatform: web\nurl: http://localhost:5173/\nsteps:\n- wait_for: Home\n" }, /only opens public addresses/],
      [{ yaml: "name: z\nplatform: ios\napp: com.example.app\nsteps:\n- tap: Home\n" }, /runs where that device is/],
      [{ yaml: "name: w\nplatform: web\nurl: https://example.test/\nsteps:\n- fly_to: Home\n" }, /cannot replay/],
    ];
    for (const [body, expected] of refusals) {
      const response = await post(body);
      assert.equal(response.status >= 400 && response.status < 500, true, `${JSON.stringify(body).slice(0, 40)} is refused`);
      assert.match((await response.json()).error, expected);
    }
  } finally { await product.close(); if (previous === undefined) delete process.env.TAPP_HOME; else process.env.TAPP_HOME = previous; }
});

test("“Continue with Google” signs in on our own page, and a callback cannot be replayed into someone else's browser", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-oauth-home-"));
  const previous = { home: process.env.TAPP_HOME, id: process.env.TAPP_OAUTH_GOOGLE_CLIENT_ID, secret: process.env.TAPP_OAUTH_GOOGLE_CLIENT_SECRET };
  process.env.TAPP_HOME = home;
  process.env.TAPP_OAUTH_GOOGLE_CLIENT_ID = "google-id";
  process.env.TAPP_OAUTH_GOOGLE_CLIENT_SECRET = "google-secret";
  const origin = "https://app.runtapp.com";
  // The provider is Google's job; here it is a stand-in that accepts exactly one code.
  const oauthExchange = async ({ provider, code }) => {
    if (provider !== "google" || code !== "good-code") throw new Error("Google refused the sign-in");
    return "Owner@Example.test";
  };
  const product = await startBrowserProduct({ port: 0, publicOrigin: origin, publicAccess: true, workspaceRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tapp-oauth-ws-")), oauthExchange });
  try {
    // The Studio offers the button only because a client id is configured.
    const session = await (await fetch(`${product.origin}/api/session`)).json();
    assert.equal(session.signInProvider, "oauth");
    assert.deepEqual(session.signInOptions.map((o) => o.kind), ["google", "email"], "a provider button, with the emailed link underneath");

    // Leg one: off to Google, with a one-time state kept in a cookie scoped to /auth.
    const start = await fetch(`${product.origin}/auth/google`, { redirect: "manual" });
    assert.equal(start.status, 303);
    const authorize = new URL(start.headers.get("location"));
    assert.equal(authorize.host, "accounts.google.com");
    assert.equal(authorize.searchParams.get("redirect_uri"), "https://app.runtapp.com/auth/google/callback");
    const stateCookie = start.headers.get("set-cookie");
    assert.match(stateCookie, /tapp_oauth_state=/);
    assert.match(stateCookie, /HttpOnly/);
    assert.match(stateCookie, /Path=\/auth/);
    const state = authorize.searchParams.get("state");
    assert.equal(stateCookie.includes(state), true, "the state in the link is the state in the cookie");

    // A callback with no cookie — the shape of a link sent to someone else — signs nobody in.
    const replayed = await fetch(`${product.origin}/auth/google/callback?code=good-code&state=${state}`, { redirect: "manual" });
    assert.equal(replayed.headers.get("location"), "/?signin=failed");
    assert.doesNotMatch(String(replayed.headers.get("set-cookie")), /tapp_account=/, "no session without the browser that started it");

    const cookie = `tapp_oauth_state=${state}`;
    // A callback whose state does not match the cookie is refused too.
    const tampered = await fetch(`${product.origin}/auth/google/callback?code=good-code&state=somethingelse`, { redirect: "manual", headers: { cookie } });
    assert.equal(tampered.headers.get("location"), "/?signin=failed");

    // A code the provider rejects fails closed, and says so without leaking why to the URL.
    const refused = await fetch(`${product.origin}/auth/google/callback?code=wrong-code&state=${state}`, { redirect: "manual", headers: { cookie } });
    assert.equal(refused.headers.get("location"), "/?signin=failed");

    // The real thing: signed in, as an account, on our own origin.
    const done = await fetch(`${product.origin}/auth/google/callback?code=good-code&state=${state}`, { redirect: "manual", headers: { cookie } });
    assert.equal(done.status, 303);
    assert.equal(done.headers.get("location"), "/?signin=done");
    const account = (done.headers.getSetCookie?.() || []).find((value) => value.startsWith("tapp_account="));
    assert.ok(account, "a session cookie was set");
    const me = await (await fetch(`${product.origin}/api/session`, { headers: { cookie: account.split(";")[0] } })).json();
    assert.equal(me.access, "account");
    assert.equal(me.email, "owner@example.test", "the address is normalised into one account");

    // An unknown provider is not a sign-in route at all — not a redirect to one.
    const unknown = await fetch(`${product.origin}/auth/facebook`, { redirect: "manual" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.headers.get("location"), null);
  } finally {
    await product.close();
    for (const [key, value] of [["TAPP_HOME", previous.home], ["TAPP_OAUTH_GOOGLE_CLIENT_ID", previous.id], ["TAPP_OAUTH_GOOGLE_CLIENT_SECRET", previous.secret]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("the chat drives the person's own Claude Code, on their plan, with tapp's tools and no shell (ADR-0012)", async () => {
  // A machine with a stub `claude`: `auth status` answers like the real one, and a prompt run
  // prints the event stream — echoing its own arguments, so the test can see what it was given.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-agent-home-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "o@example.test", subscriptionType: "max" })); process.exit(0); }
const resumed = a.includes("--resume") ? a[a.indexOf("--resume") + 1] : "";
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: resumed || "sess-1" }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ARGS " + JSON.stringify(a) }, { type: "tool_use", name: "mcp__tapp__tapp_look", input: { url: "http://127.0.0.1:1/" } }] } }));
console.log(JSON.stringify({ type: "result", subtype: "success", session_id: resumed || "sess-1", result: resumed ? "Still fine." : "All good.", num_turns: 2, total_cost_usd: 0.01, is_error: false }));
`, { mode: 0o755 });
  const previous = { home: process.env.TAPP_HOME, path: process.env.PATH };
  process.env.TAPP_HOME = home;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH || ""}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-agent-proj-"));
  fs.writeFileSync(path.join(root, "index.html"), "<h1>x</h1>");
  const product = await startBrowserProduct({ projectDir: root, port: 0, launch: false });
  try {
    assert.equal((await fetch(`${product.origin}/api/engines`)).status, 401, "a stranger is not told what is installed here");
    const cookie = cookieFrom(await fetch(product.launchUrl, { redirect: "manual" }));
    const session = await (await fetch(`${product.origin}/api/session`, { headers: { cookie } })).json();
    const call = (pathname, init = {}) => fetch(`${product.origin}${pathname}`, { ...init, headers: { cookie, origin: product.origin, "x-tapp-csrf": session.csrfToken, "content-type": "application/json", ...(init.headers || {}) } });

    const engines = await (await call("/api/engines")).json();
    assert.equal(engines.selected, "claude");
    const claude = engines.engines.find((e) => e.id === "claude");
    assert.equal(claude.state, "ok");
    assert.equal(claude.detail, "Claude Max plan · o@example.test");
    // Codex and Gemini are reported from the real machine (a well-known install dir, not only
    // PATH), so their state here depends on the machine; only the shape is asserted.
    assert.ok(["ok", "warning", "missing"].includes(engines.engines.find((e) => e.id === "codex").state));

    const wait = async (id) => { for (;;) { const job = await (await call(`/api/jobs/${id}`)).json(); if (job.status !== "running") return job; await new Promise((r) => setTimeout(r, 50)); } };
    const started = await call("/api/operations/agent", { method: "POST", body: JSON.stringify({ prompt: "Check the sign-in", thread: "studio" }) });
    assert.equal(started.status, 202);
    const job = await wait((await started.json()).job.id);
    assert.equal(job.status, "completed", JSON.stringify(job.error));
    const texts = job.progress.map((p) => p.text);
    assert.ok(texts.includes("Claude Code is on it."));
    assert.ok(texts.some((t) => t === "tapp_look — url: http://127.0.0.1:1/"), "the tool it reached for, in tapp's words");
    const args = JSON.parse(texts.find((t) => t.startsWith("ARGS ")).slice(5));
    assert.deepEqual(args.slice(0, 2), ["-p", "Check the sign-in"]);
    assert.equal(args[args.indexOf("--disallowedTools") + 1].includes("Bash"), true, "no shell");
    assert.equal(args[args.indexOf("--allowedTools") + 1].startsWith("mcp__tapp"), true, "tapp's tools");
    assert.match(args[args.indexOf("--mcp-config") + 1], /bin\/tapp\.js/, "the MCP server is this package");
    assert.match(fs.readFileSync(args[args.indexOf("--append-system-prompt-file") + 1], "utf8"), /# Tapp[\s\S]*You are in the tapp Studio/, "the skill plus the Studio's own note");
    assert.equal(args.includes("--resume"), false, "a new thread");
    assert.equal(job.result.sessionId, "sess-1");
    assert.equal(job.result.text, "All good.");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "agent", "threads.json"), "utf8")), { studio: "sess-1" });

    // The same thread continues the same session.
    const again = await wait((await (await call("/api/operations/agent", { method: "POST", body: JSON.stringify({ prompt: "And the checkout?" }) })).json()).job.id);
    const argsAgain = JSON.parse(again.progress.map((p) => p.text).find((t) => t.startsWith("ARGS ")).slice(5));
    assert.equal(argsAgain[argsAgain.indexOf("--resume") + 1], "sess-1");
    assert.equal(again.result.text, "Still fine.");

    // Nothing running: stop is a no-op, said plainly. An engine that cannot drive is refused with the reason.
    assert.deepEqual(await (await call("/api/operations/agent-stop", { method: "POST", body: "{}" })).json(), { ok: true, stopped: false });
    assert.equal((await call("/api/engines", { method: "POST", body: JSON.stringify({ engine: "codex" }) })).status, 200);
    const refused = await call("/api/operations/agent", { method: "POST", body: JSON.stringify({ prompt: "x" }) });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /Codex/, "the reason names the engine: not installed, not signed in, or not driving yet");
    assert.equal((await call("/api/engines", { method: "POST", body: JSON.stringify({ engine: "toaster" }) })).status, 400);
    await call("/api/engines", { method: "POST", body: JSON.stringify({ engine: "claude" }) });
    assert.equal((await call("/api/operations/agent", { method: "POST", body: JSON.stringify({ prompt: "" }) })).status, 400, "an empty ask is refused");
  } finally {
    await product.close();
    process.env.PATH = previous.path;
    if (previous.home === undefined) delete process.env.TAPP_HOME; else process.env.TAPP_HOME = previous.home;
  }
});

test("setting this machine up: the runtime, the agent (plan, key, or a Codex device sign-in), what each target needs, the account (ADR-0012)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-setup-home-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  // Claude Code installed but signed out; Codex installed, signed out, offering a device sign-in.
  fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: false })); process.exit(0); }
console.log(JSON.stringify({ type: "result", subtype: "success", session_id: "k1", result: "ran on the key", num_turns: 1, is_error: false }));
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "codex"), `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === "login" && a[1] === "status") { console.log("Not logged in"); process.exit(0); }
if (a[0] === "login" && a[1] === "--device-auth") {
  process.stdout.write("\\u001b[90mFollow these steps to sign in with ChatGPT using device code authorization:\\u001b[0m\\n1. Open this link in your browser and sign in to your account\\n   \\u001b[94mhttps://auth.openai.com/codex/device\\u001b[0m\\n2. Enter this one-time code (expires in 15 minutes)\\n   \\u001b[94mQ7MX-H2KPL\\u001b[0m\\n");
  process.on("SIGINT", () => process.exit(130));
  setTimeout(() => {}, 60000);
}
`, { mode: 0o755 });
  const previous = { home: process.env.TAPP_HOME, path: process.env.PATH, key: process.env.ANTHROPIC_API_KEY };
  process.env.TAPP_HOME = home;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH || ""}`;
  delete process.env.ANTHROPIC_API_KEY;
  const report = { version: "0.35.8", node: { ok: true, version: "22.0.0" }, python3: { ok: true, version: "Python 3.12.1" }, pyyaml: { ok: true }, disk: { level: "ok", message: "40 GiB free" },
    platforms: { ios: { available: true, xcode: "Xcode 26.4", bootedSimulator: "" }, macos: { available: false, accessibility: false }, android: { adb: false, devicesConnected: 0 }, web: { available: true } } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-setup-proj-"));
  fs.writeFileSync(path.join(root, "index.html"), "<h1>x</h1>");
  const product = await startBrowserProduct({ projectDir: root, port: 0, launch: false, doctor: async () => report, apiKeyVerifier: async (key) => key.endsWith("GOOD") });
  try {
    assert.equal((await fetch(`${product.origin}/api/setup`)).status, 401);
    const cookie = cookieFrom(await fetch(product.launchUrl, { redirect: "manual" }));
    const session = await (await fetch(`${product.origin}/api/session`, { headers: { cookie } })).json();
    const call = (pathname, init = {}) => fetch(`${product.origin}${pathname}`, { ...init, headers: { cookie, origin: product.origin, "x-tapp-csrf": session.csrfToken, "content-type": "application/json", ...(init.headers || {}) } });

    let setup = await (await call("/api/setup")).json();
    assert.equal(setup.runtime.version, "0.35.8");
    assert.equal(setup.runtime.node, "22.0.0");
    assert.deepEqual(setup.targets.map((t) => t.id), ["web", "ios", "android", "macos", "windows"]);
    assert.equal(setup.targets[0].ready, true, "web needs nothing the person has to do");
    const android = setup.targets.find((t) => t.id === "android");
    assert.equal(android.ready, false);
    assert.match(android.items[0].fix, /Android Studio/);
    const ios = setup.targets.find((t) => t.id === "ios");
    if (process.platform === "darwin") {
      assert.equal(ios.items[0].ok, true, "Xcode is there");
      assert.equal(ios.items[0].text, "Xcode 26.4");
      assert.equal(ios.items[1].ok, false);
      assert.match(ios.items[1].fix, /boots one when a run needs it/);
    } else {
      assert.match(ios.items[0].text, /runs on a Mac/);
    }
    const claude = setup.engines.find((e) => e.id === "claude");
    assert.equal(claude.usable, false, "signed out, no key: nothing drives the chat yet");
    assert.equal(setup.apiKey.set, false);
    assert.equal(setup.deviceAuth, null);
    assert.equal(setup.link, null);

    // An API key is the fallback brain: checked with Anthropic, kept on this machine, shown by its tail.
    assert.equal((await call("/api/engines/api-key", { method: "POST", body: JSON.stringify({ key: "nope" }) })).status, 400);
    assert.equal((await call("/api/engines/api-key", { method: "POST", body: JSON.stringify({ key: "sk-ant-" + "x".repeat(30) + "BAD" }) })).status, 400, "Anthropic refused it");
    const saved = await call("/api/engines/api-key", { method: "POST", body: JSON.stringify({ key: "sk-ant-" + "x".repeat(30) + "GOOD" }) });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).apiKey, { set: true, hint: "…GOOD" });
    assert.equal((fs.statSync(path.join(home, "agent", "anthropic-api-key")).mode & 0o777), 0o600);
    assert.equal(process.env.ANTHROPIC_API_KEY, "sk-ant-" + "x".repeat(30) + "GOOD", "tapp's own model features see it");
    setup = await (await call("/api/setup")).json();
    const onKey = setup.engines.find((e) => e.id === "claude");
    assert.equal(onKey.usable, true);
    assert.equal(onKey.billing, "api-key");
    assert.match(onKey.detail, /bills per use/);
    // And the chat runs Claude Code on that key.
    const started = await (await call("/api/operations/agent", { method: "POST", body: JSON.stringify({ prompt: "hi" }) })).json();
    let job; for (;;) { job = await (await call(`/api/jobs/${started.job.id}`)).json(); if (job.status !== "running") break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(job.result?.text, "ran on the key", JSON.stringify(job.error));
    assert.equal((await call("/api/engines/api-key", { method: "DELETE" })).status, 200);
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    assert.equal((await (await call("/api/setup")).json()).apiKey.set, false);

    // Codex: a device sign-in shows the link and the code, waits, and can be cancelled.
    const device = await (await call("/api/engines/codex/sign-in", { method: "POST", body: "{}" })).json();
    assert.deepEqual({ url: device.url, code: device.code }, { url: "https://auth.openai.com/codex/device", code: "Q7MX-H2KPL" }, JSON.stringify(device));
    setup = await (await call("/api/setup")).json();
    assert.equal(setup.deviceAuth.code, "Q7MX-H2KPL");
    assert.equal((await call("/api/engines/codex/sign-in", { method: "DELETE" })).status, 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await (await call("/api/setup")).json()).deviceAuth, null);
  } finally {
    await product.close();
    process.env.PATH = previous.path;
    if (previous.home === undefined) delete process.env.TAPP_HOME; else process.env.TAPP_HOME = previous.home;
    if (previous.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous.key;
  }
});

test("a hosted page drives the runtime on the person's machine: one origin, a bearer, the secret on images, nothing else (ADR-0011 §4)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-connect-home-"));
  const previousHome = process.env.TAPP_HOME;
  process.env.TAPP_HOME = home;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-connect-proj-"));
  fs.writeFileSync(path.join(root, "index.html"), "<h1>x</h1>");
  const studio = "https://app.runtapp.com";
  const product = await startBrowserProduct({ projectDir: root, port: 0, launch: false, connectOrigin: studio });
  try {
    const token = new URL(product.launchUrl).searchParams.get("token");
    assert.equal(product.connectUrl, `${studio}/#connect=${encodeURIComponent(product.origin)}&token=${encodeURIComponent(token)}`, "the secret travels in the fragment, which a browser never sends");

    // The browser asks first; the answer names the one origin and allows the local-network hop.
    const preflight = await fetch(`${product.origin}/api/session`, { method: "OPTIONS", headers: { origin: studio, "access-control-request-method": "GET" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), studio);
    assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
    assert.match(preflight.headers.get("access-control-allow-headers"), /authorization/);
    const other = await fetch(`${product.origin}/api/session`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    assert.equal(other.headers.get("access-control-allow-origin"), null, "any other origin is told nothing");

    // The launch secret as a bearer is the operator; without it the page is a stranger.
    assert.equal((await fetch(`${product.origin}/api/session`, { headers: { origin: studio } })).status, 401);
    const session = await fetch(`${product.origin}/api/session`, { headers: { origin: studio, authorization: `Bearer ${token}` } });
    assert.equal(session.status, 200);
    assert.equal(session.headers.get("access-control-allow-origin"), studio);
    const body = await session.json();
    assert.equal(body.mode, "local");
    assert.equal(body.connectOrigin, studio);
    assert.equal((await fetch(`${product.origin}/api/session`, { headers: { origin: studio, authorization: "Bearer " + "x".repeat(43) } })).status, 401);

    // A mutation from the hosted page still needs the CSRF token it was given.
    const post = (headers) => fetch(`${product.origin}/api/engines`, { method: "POST", headers: { origin: studio, authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify({ engine: "claude" }) });
    assert.equal((await post({})).status, 403);
    assert.notEqual((await post({ "x-tapp-csrf": body.csrfToken })).status, 403);

    // An image cannot send a header: the secret rides on the query, for GET only, and the
    // bootstrap redirect no longer swallows it on any path but "/".
    fs.mkdirSync(path.join(home, "captures", "web-audit-planted"), { recursive: true });
    fs.writeFileSync(path.join(home, "captures", "web-audit-planted", "report.html"), "<h1>evidence</h1>");
    const image = await fetch(`${product.origin}/evidence/captures/web-audit-planted/report.html?token=${encodeURIComponent(token)}`, { redirect: "manual" });
    assert.equal(image.status, 200);
    assert.equal((await fetch(`${product.origin}/evidence/captures/web-audit-planted/report.html`, { redirect: "manual" })).status, 401);
    assert.equal((await fetch(`${product.origin}/?token=${encodeURIComponent(token)}`, { redirect: "manual" })).status, 303, "the page bootstrap still sets its cookie");
    // A local Studio's own page never allows loopback fetches from elsewhere.
    const csp = (await fetch(product.launchUrl, { redirect: "manual" })).headers.get("content-security-policy");
    assert.doesNotMatch(csp, /127\.0\.0\.1/);
  } finally {
    await product.close();
    if (previousHome === undefined) delete process.env.TAPP_HOME; else process.env.TAPP_HOME = previousHome;
  }

  // Without --connect, a bearer is not an operator and no origin gets CORS: the surface is closed.
  const plain = await startBrowserProduct({ projectDir: root, port: 0, launch: false });
  try {
    const token = new URL(plain.launchUrl).searchParams.get("token");
    assert.equal(plain.connectUrl, "");
    assert.equal((await fetch(`${plain.origin}/api/session`, { headers: { origin: studio, authorization: `Bearer ${token}` } })).status, 401);
    assert.equal((await fetch(`${plain.origin}/api/session`, { method: "OPTIONS", headers: { origin: studio } })).headers.get("access-control-allow-origin"), null);
  } finally { await plain.close(); }
});

test("the hosted page may reach a runtime on the viewer's machine, and a visitor may leave an address for the cloud", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-cloud-home-"));
  const previousHome = process.env.TAPP_HOME;
  process.env.TAPP_HOME = home;
  const product = await startBrowserProduct({ port: 0, publicOrigin: "https://app.runtapp.com", publicAccess: true, workspaceRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tapp-cloud-ws-")) });
  try {
    const page = await fetch(`${product.origin}/`);
    const csp = page.headers.get("content-security-policy");
    assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*/);
    assert.match(csp, /img-src 'self' data: blob: http:\/\/127\.0\.0\.1:\*/);
    const cookie = page.headers.get("set-cookie").split(";")[0];
    const session = await (await fetch(`${product.origin}/api/session`, { headers: { cookie } })).json();
    const ask = (email) => fetch(`${product.origin}/api/cloud/interest`, { method: "POST", headers: { cookie, origin: "https://app.runtapp.com", "x-tapp-csrf": session.csrfToken, "content-type": "application/json" }, body: JSON.stringify({ email }) });
    assert.equal((await ask("not an address")).status, 400);
    assert.equal((await ask("Owner@Example.test")).status, 200);
    const lines = fs.readFileSync(path.join(home, "cloud-interest.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].email, "owner@example.test");
    assert.equal(lines[0].visitor, undefined, "an address and a date; nothing that identifies the browser");
  } finally {
    await product.close();
    if (previousHome === undefined) delete process.env.TAPP_HOME; else process.env.TAPP_HOME = previousHome;
  }
});

test("a self-hosted Studio links to an account on a hosted one with a token, and says whose (ADR-0011 §4)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-link-home-"));
  const previousHome = process.env.TAPP_HOME;
  process.env.TAPP_HOME = home;
  const accessVerifier = { verify: async () => ({ email: "owner@example.test" }) };
  const cloud = await startBrowserProduct({ port: 0, publicOrigin: "https://app.runtapp.com", publicAccess: true, workspaceRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tapp-link-cloud-")), accessVerifier });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-link-local-"));
  fs.writeFileSync(path.join(root, "index.html"), "<h1>local</h1>");
  const local = await startBrowserProduct({ projectDir: root, port: 0, launch: false });
  try {
    // The owner creates a token on the hosted Studio, signed in.
    const cloudCookie = (await fetch(`${cloud.origin}/auth/cloudflare`, { redirect: "manual", headers: { "cf-access-jwt-assertion": "x" } })).headers.get("set-cookie").split(";")[0];
    const cloudCsrf = (await (await fetch(`${cloud.origin}/api/session`, { headers: { cookie: cloudCookie } })).json()).csrfToken;
    const issued = await (await fetch(`${cloud.origin}/api/tokens`, { method: "POST", headers: { cookie: cloudCookie, origin: "https://app.runtapp.com", "x-tapp-csrf": cloudCsrf, "content-type": "application/json" }, body: JSON.stringify({ label: "my mac" }) })).json();
    assert.match(issued.token, /^tapp_/);

    // The local Studio, as its operator.
    const cookie = cookieFrom(await fetch(local.launchUrl, { redirect: "manual" }));
    const session = await (await fetch(`${local.origin}/api/session`, { headers: { cookie } })).json();
    assert.equal(session.studioLink, null, "nothing is linked until the owner says so");
    const post = (body) => fetch(`${local.origin}/api/studio-link`, { method: "POST", headers: { cookie, origin: local.origin, "x-tapp-csrf": session.csrfToken, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ origin: cloud.origin, token: "not-a-token" })).status, 400, "a value that is not a tapp token is refused before anything is sent");
    assert.equal((await post({ origin: cloud.origin, token: "tapp_" + "0".repeat(40) })).status, 400, "a token the Studio does not know is refused");
    const linked = await post({ origin: cloud.origin, token: issued.token });
    assert.equal(linked.status, 200);
    const { link } = await linked.json();
    assert.equal(link.email, "owner@example.test", "the link says whose account it reports to");
    assert.equal(link.origin, cloud.origin);
    assert.equal(link.token, undefined, "the token is never read back");
    assert.equal((await (await fetch(`${local.origin}/api/session`, { headers: { cookie } })).json()).studioLink.email, "owner@example.test");
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, "studio-link.json"), "utf8"));
    assert.equal(onDisk.token, issued.token);
    assert.equal((fs.statSync(path.join(home, "studio-link.json")).mode & 0o777), 0o600);
    // Not for strangers, and not for a hosted Studio.
    assert.equal((await fetch(`${local.origin}/api/studio-link`)).status, 401);
    assert.equal((await fetch(`${cloud.origin}/api/studio-link`, { headers: { cookie: cloudCookie } })).status, 401, "a hosted Studio has nothing to link to but itself");
    const unlinked = await fetch(`${local.origin}/api/studio-link`, { method: "DELETE", headers: { cookie, origin: local.origin, "x-tapp-csrf": session.csrfToken } });
    assert.equal(unlinked.status, 200);
    assert.equal(fs.existsSync(path.join(home, "studio-link.json")), false);
  } finally {
    await local.close();
    await cloud.close();
    if (previousHome === undefined) delete process.env.TAPP_HOME; else process.env.TAPP_HOME = previousHome;
  }
});

test("the owner sees how their deployment is being used; nobody else sees that it exists", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-admin-home-"));
  const previous = { home: process.env.TAPP_HOME, admins: process.env.TAPP_ADMIN_EMAILS };
  process.env.TAPP_HOME = home;
  process.env.TAPP_ADMIN_EMAILS = " Owner@Example.test , second@example.test ";
  const origin = "https://app.runtapp.com";
  let who = "owner@example.test";
  const accessVerifier = { verify: async () => ({ email: who }) };
  const product = await startBrowserProduct({ port: 0, publicOrigin: origin, publicAccess: true, workspaceRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tapp-admin-ws-")), accessVerifier });
  const signIn = async () => {
    const res = await fetch(`${product.origin}/auth/cloudflare`, { redirect: "manual", headers: { "cf-access-jwt-assertion": "x" } });
    return res.headers.get("set-cookie").split(";")[0];
  };
  try {
    const ownerCookie = await signIn();
    const session = await (await fetch(`${product.origin}/api/session`, { headers: { cookie: ownerCookie } })).json();
    assert.equal(session.admin, true, "the address on the list is the owner, however it was capitalised");

    const overview = await (await fetch(`${product.origin}/api/admin/overview`, { headers: { cookie: ownerCookie } })).json();
    assert.equal(overview.accounts.length, 1);
    assert.equal(overview.accounts[0].email, "owner@example.test");
    assert.equal(overview.accounts[0].journeys, 0);
    assert.equal(overview.accounts[0].testAccounts, 0);
    assert.equal(overview.signInProvider, "cloudflare");
    assert.ok(overview.usage, "it says how the deployment is being used");
    assert.equal(typeof overview.journeyCheckHours, "number");
    // Counts, never contents: an overview that could show a password would be a way to read one.
    const asText = JSON.stringify(overview);
    assert.doesNotMatch(asText, /password|secret|credential|tapp_[A-Za-z0-9_-]{20}/i, "no credential, no token, ever");

    // Somebody else's account is an ordinary account: no admin, and the route does not exist for them.
    who = "stranger@example.test";
    const strangerCookie = await signIn();
    const theirs = await (await fetch(`${product.origin}/api/session`, { headers: { cookie: strangerCookie } })).json();
    assert.equal(theirs.admin, false);
    // Not 401 but 404: to an ordinary account the owner's page is not a door they are refused at,
    // it is a door that is not there.
    assert.equal((await fetch(`${product.origin}/api/admin/overview`, { headers: { cookie: strangerCookie } })).status, 404);
    // And a signed-out visitor certainly cannot.
    assert.equal((await fetch(`${product.origin}/api/admin/overview`)).status, 401);

    // Now that a stranger exists, the owner sees both — that is the point of the page.
    const after = await (await fetch(`${product.origin}/api/admin/overview`, { headers: { cookie: ownerCookie } })).json();
    assert.deepEqual(after.accounts.map((a) => a.email).sort(), ["owner@example.test", "stranger@example.test"]);

    // Each account's plan is on the page, and the owner's word changes it (ADR-0011 §3).
    const stranger = after.accounts.find((a) => a.email === "stranger@example.test");
    assert.equal(stranger.plan.kind, "trial");
    assert.equal(after.accounts.find((a) => a.email === "owner@example.test").plan.kind, "owner", "the owner is never gated");
    const ownerCsrf = (await (await fetch(`${product.origin}/api/session`, { headers: { cookie: ownerCookie } })).json()).csrfToken;
    const setPlan = (body, cookie, csrf) => fetch(`${product.origin}/api/admin/plan`, {
      method: "POST", headers: { cookie, origin, "x-tapp-csrf": csrf, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const extended = await setPlan({ accountId: stranger.id, kind: "trial", days: 30 }, ownerCookie, ownerCsrf);
    assert.equal(extended.status, 200);
    assert.equal((await extended.json()).plan.daysLeft, 30);
    const paid = await setPlan({ accountId: stranger.id, kind: "paid" }, ownerCookie, ownerCsrf);
    assert.equal((await paid.json()).plan.kind, "paid");
    assert.equal((await setPlan({ accountId: stranger.id, kind: "gold" }, ownerCookie, ownerCsrf)).status, 400);
    // The stranger cannot promote themselves, and the refusal names no accounts.
    const strangerCsrf = (await (await fetch(`${product.origin}/api/session`, { headers: { cookie: strangerCookie } })).json()).csrfToken;
    const refused = await setPlan({ accountId: stranger.id, kind: "paid" }, strangerCookie, strangerCsrf);
    assert.equal(refused.status, 403);
    assert.doesNotMatch(await refused.text(), /owner@example\.test/);
  } finally {
    await product.close();
    for (const [key, value] of [["TAPP_HOME", previous.home], ["TAPP_ADMIN_EMAILS", previous.admins]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("the owner's page answers “what has been happening?” across restarts", async () => {
  // "3 visitors" is not an answer. The counters live in memory and start again at zero on every
  // deploy, so activity is also written to a file the Studio can read back.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-activity-home-"));
  const previous = { home: process.env.TAPP_HOME, admins: process.env.TAPP_ADMIN_EMAILS };
  process.env.TAPP_HOME = home;
  process.env.TAPP_ADMIN_EMAILS = "owner@example.test";
  const origin = "https://app.runtapp.com";
  const accessVerifier = { verify: async () => ({ email: "owner@example.test" }) };
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-activity-ws-"));
  const open = () => startBrowserProduct({ port: 0, publicOrigin: origin, publicAccess: true, workspaceRoot, accessVerifier });

  let product = await open();
  try {
    // A visitor arrives and is refused something private; both are recorded.
    await fetch(`${product.origin}/`);
    await fetch(`${product.origin}/api/project`);
    const signedIn = await fetch(`${product.origin}/auth/cloudflare`, { redirect: "manual", headers: { "cf-access-jwt-assertion": "x" } });
    const cookie = signedIn.headers.get("set-cookie").split(";")[0];
    assert.ok(fs.existsSync(path.join(home, "usage.jsonl")), "activity is written somewhere it survives a restart");
  } finally { await product.close(); }

  // The deploy that loses the counters must not lose the history.
  product = await open();
  try {
    const signedIn = await fetch(`${product.origin}/auth/cloudflare`, { redirect: "manual", headers: { "cf-access-jwt-assertion": "x" } });
    const cookie = signedIn.headers.get("set-cookie").split(";")[0];
    const overview = await (await fetch(`${product.origin}/api/admin/overview`, { headers: { cookie } })).json();

    assert.ok(overview.activity.logged > 0, "the log from before the restart is still there");
    assert.ok(overview.activity.recent.length > 0, "and can be read back");
    assert.equal(overview.activity.recent[0].at >= overview.activity.recent.at(-1).at, true, "newest first");
    assert.ok(overview.activity.today["signin.done"] >= 1, "today is counted from the log, not from memory");

    // Who was here: a visitor the owner can tell apart from the next one, and never an IP.
    const visitor = overview.activity.people.find((person) => person.kind === "visitor");
    assert.ok(visitor, "an anonymous visitor appears as a person, not just a number");
    assert.match(visitor.id, /^visitor:[a-f0-9]{8}$/, "eight characters of their cookie, no more");
    assert.ok(visitor.events["visitor.new"] >= 1, "with what they did");
    const asText = JSON.stringify(overview);
    assert.doesNotMatch(asText, /\b\d{1,3}(\.\d{1,3}){3}\b/, "no IP address is ever kept");
    assert.doesNotMatch(asText, /password|secret|tapp_[A-Za-z0-9_-]{20}/i, "and no credential");
  } finally {
    await product.close();
    for (const [key, value] of [["TAPP_HOME", previous.home], ["TAPP_ADMIN_EMAILS", previous.admins]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("an account is told where to be told, and tapp proves it can post before promising to", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-alertapi-home-"));
  const previous = process.env.TAPP_HOME; process.env.TAPP_HOME = home;
  const origin = "https://app.runtapp.com";
  const accessVerifier = { verify: async () => ({ email: "owner@example.test" }) };
  const posted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    // Only the webhook is stubbed; the test's own calls to the Studio go through.
    if (target.startsWith("https://hooks.example.test/")) { posted.push(JSON.parse(options.body)); return new Response("ok", { status: 200 }); }
    if (target.startsWith("https://broken.example.test/")) return new Response("nope", { status: 500 });
    return realFetch(url, options);
  };
  const product = await startBrowserProduct({ port: 0, publicOrigin: origin, publicAccess: true, workspaceRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tapp-alertapi-ws-")), accessVerifier });
  try {
    const signedIn = await fetch(`${product.origin}/auth/cloudflare`, { redirect: "manual", headers: { "cf-access-jwt-assertion": "x" } });
    const cookie = signedIn.headers.get("set-cookie").split(";")[0];
    const { csrfToken } = await (await fetch(`${product.origin}/api/session`, { headers: { cookie } })).json();
    const call = (p, init = {}) => fetch(`${product.origin}${p}`, { ...init, headers: { cookie, origin, "x-tapp-csrf": csrfToken, "content-type": "application/json", ...(init.headers || {}) } });

    assert.equal((await (await call("/api/alerts")).json()).configured, false);

    // A webhook that cannot be posted to is not saved — the promise is kept at the moment it is made.
    const bad = await call("/api/alerts", { method: "POST", body: JSON.stringify({ webhook: "https://broken.example.test/hook" }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /could not post there/);
    assert.equal((await (await call("/api/alerts")).json()).configured, false, "nothing was saved");

    // A good one is saved, and proves itself by posting there and then.
    const saved = await (await call("/api/alerts", { method: "POST", body: JSON.stringify({ webhook: "https://hooks.example.test/T/B/secret" }) })).json();
    assert.equal(saved.configured, true);
    assert.equal(saved.host, "hooks.example.test");
    assert.doesNotMatch(JSON.stringify(saved), /secret/, "the URL is never handed back");
    assert.equal(posted.length, 1, "saving posts a message so you know it works before anything breaks");

    assert.equal((await call("/api/alerts/test", { method: "POST", body: "{}" })).status, 200);
    assert.equal(posted.length, 2);
    assert.match(posted[1].text, /stopped working/);

    // And it can be turned off.
    assert.equal((await (await call("/api/alerts", { method: "POST", body: JSON.stringify({ webhook: "" }) })).json()).configured, false);
  } finally {
    globalThis.fetch = realFetch;
    await product.close();
    if (previous === undefined) delete process.env.TAPP_HOME; else process.env.TAPP_HOME = previous;
  }
});

test("a hosted Studio tells a visitor what tapp drives, and where the rest runs", async () => {
  // The hosted Studio used to delete every mention of iOS, Android and local folders from the
  // page, so the product read as a website checker. It can still only START web runs; what
  // changed is that it now says so instead of pretending the rest does not exist (ADR-0010).
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-platforms-public-"));
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
    assert.equal((await call("/")).status, 200);

    // A stranger may read the matrix: it is the answer to "does this do iOS?".
    const listed = await (await call("/api/platforms")).json();
    assert.equal(listed.hosted, true);
    assert.deepEqual(listed.platforms.map((entry) => entry.id), ["web", "ios", "android", "macos", "windows"]);
    const byId = Object.fromEntries(listed.platforms.map((entry) => [entry.id, entry]));
    assert.equal(byId.web.state, "ready");
    assert.equal(byId.windows.state, "pilot");
    assert.equal(byId.windows.command, "", "no command would make a missing driver work");

    // The session carries the same matrix, so the first screen can show it without a second call.
    const session = await (await call("/api/session")).json();
    assert.deepEqual(session.accepts, ["url"], "what can START here is unchanged");
    assert.deepEqual(session.platforms.map((entry) => entry.id), listed.platforms.map((entry) => entry.id));

    // Saying "I would use this for Android" needs no account; it is the only demand signal a
    // visitor can give, and it is worth most exactly when the answer was "not from here".
    const csrf = session.csrfToken;
    const interested = await call("/api/platforms/interest", {
      method: "POST", headers: { "content-type": "application/json", "x-tapp-csrf": csrf, origin: "https://app.runtapp.com" },
      body: JSON.stringify({ platform: "android" }),
    });
    assert.equal(interested.status, 200);
    const refused = await call("/api/platforms/interest", {
      method: "POST", headers: { "content-type": "application/json", "x-tapp-csrf": csrf, origin: "https://app.runtapp.com" },
      body: JSON.stringify({ platform: "toaster" }),
    });
    assert.equal(refused.status, 400);

    // A build is answered with where it runs, never with a bare failure.
    const build = await call("/api/operations/explore-build", {
      method: "POST", headers: { "content-type": "application/json", "x-tapp-csrf": csrf, origin: "https://app.runtapp.com" },
      body: JSON.stringify({ input: "com.company.app" }),
    });
    assert.equal(build.status, 200);
    const answer = await build.json();
    assert.equal(answer.kind, "self-host");
    assert.equal(answer.platform, "ios");
    assert.match(answer.command, /npx -y @aarwitz\/tapp@latest app/);
  } finally { await product.close(); }
});

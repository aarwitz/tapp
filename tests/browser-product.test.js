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
    assert.match(await page.text(), /Bring the product/);

    const sessionResponse = await fetch(`${product.origin}/api/session`, { headers: { cookie } });
    const session = await sessionResponse.json();
    assert.equal(session.root, fs.realpathSync(root));
    assert.deepEqual(session.contract.targetPlatforms, ["ios", "android", "web"]);
    assert.deepEqual(session.contract.repositorySources, ["local-folder", "github"]);
    assert.equal(session.contract.views.some((view) => view.id === "runs"), true);
    assert.equal(session.contract.views.some((view) => view.id === "findings"), true);
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
    assert.equal(fs.existsSync(path.join(root, ".autotap", "application-model.json")), true);
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

test("browser repository onboarding stages folder uploads and GitHub selections without accepting filesystem paths", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-browser-workspaces-test-"));
  const githubProvider = {
    async list() {
      return [{ nameWithOwner:"acme/mobile", name:"mobile", url:"https://github.com/acme/mobile", defaultBranch:"main", private:true, permission:"ADMIN" }];
    },
    async clone(nameWithOwner, destination) {
      assert.equal(nameWithOwner, "acme/mobile");
      fs.mkdirSync(destination, { recursive:true });
      fs.writeFileSync(path.join(destination, "index.html"), "<h1>GitHub product</h1>");
      fs.writeFileSync(path.join(destination, "package.json"), JSON.stringify({ name:"github-product" }));
    },
  };
  const product = await startBrowserProduct({ workspaceRoot, githubProvider, launch:false });
  try {
    const bootstrap = await fetch(product.launchUrl, { redirect:"manual" });
    const cookie = cookieFrom(bootstrap);
    const session = await fetch(`${product.origin}/api/session`, { headers:{ cookie } }).then((response) => response.json());
    assert.equal(session.root, null);
    assert.equal((await fetch(`${product.origin}/api/project`, { headers:{ cookie } }).then((response) => response.json())).connected, false);

    const mutationHeaders = { cookie, origin:product.origin, "x-tapp-csrf":session.csrfToken, "content-type":"application/json" };
    const upload = await fetch(`${product.origin}/api/repositories/uploads`, {
      method:"POST", headers:mutationHeaders, body:JSON.stringify({ name:"Uploaded App", expectedFiles:3, expectedBytes:96 }),
    }).then((response) => response.json());
    const uploadFile = async (relativePath, contents) => fetch(`${product.origin}/api/repositories/uploads/${upload.id}/files`, {
      method:"PUT",
      headers:{ cookie, origin:product.origin, "x-tapp-csrf":session.csrfToken, "content-type":"application/octet-stream", "x-tapp-relative-path":encodeURIComponent(relativePath) },
      body:Buffer.from(contents),
    });
    assert.equal((await uploadFile("../outside.txt", "no")).ok, false);
    assert.equal((await uploadFile(".DS_Store", "junk")).ok, false);
    assert.equal((await uploadFile("index.html", "<h1>Uploaded product</h1>")).status, 200);
    assert.equal((await uploadFile("package.json", JSON.stringify({ name:"uploaded-product" }))).status, 200);
    assert.equal((await uploadFile(".autotap/project.json", JSON.stringify({ kind:"tapp-product-project" }))).status, 200);
    const completed = await fetch(`${product.origin}/api/repositories/uploads/${upload.id}/complete`, { method:"POST", headers:mutationHeaders, body:"{}" }).then((response) => response.json());
    assert.equal(completed.repository.source.kind, "local-folder-upload");
    const stagedRoot = path.join(workspaceRoot, upload.id, "repository");
    assert.equal(fs.existsSync(path.join(stagedRoot, "outside.txt")), false);
    assert.equal(fs.existsSync(path.join(stagedRoot, ".DS_Store")), false);
    assert.equal(fs.existsSync(path.join(stagedRoot, ".autotap", "project.json")), true, "hidden .autotap config must survive the staged upload");
    assert.equal(completed.repository.fileCount, 3);

    const github = await fetch(`${product.origin}/api/repositories/github`, { headers:{ cookie } }).then((response) => response.json());
    assert.deepEqual(github.repositories.map((repository) => repository.nameWithOwner), ["acme/mobile"]);
    const connectedResponse = await fetch(`${product.origin}/api/operations/connect-github`, { method:"POST", headers:mutationHeaders, body:JSON.stringify({ repository:"acme/mobile", filesystemPath:"/tmp/not-trusted" }) });
    assert.equal(connectedResponse.status, 202);
    const connected = await connectedResponse.json();
    let job;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      job = await fetch(`${product.origin}/api/jobs/${connected.job.id}`, { headers:{ cookie } }).then((response) => response.json());
      if (job.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(job.status, "completed", job.error?.message);
    assert.equal(job.result.source.nameWithOwner, "acme/mobile");
    assert.equal(job.result.root.startsWith(fs.realpathSync(workspaceRoot) + path.sep), true);
    assert.equal(job.result.root.includes("not-trusted"), false);
  } finally {
    await product.close();
    fs.rmSync(workspaceRoot, { recursive:true, force:true });
  }
});

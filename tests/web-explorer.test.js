import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureElementEvidence, inspectWebPage, normalizeWebSeedRoutes, normalizeWebSeedTargets, parseWebViewport, shouldReportWebRequestFailure, submitWebLogin, webActionScreen, webAnchorStillMissing, webBrowserLaunchOptions, webContextOptions, webControlHadEffect, webControlLabel, webErrorSurfaceText, webNavigationAction, webPageAppearsBlank, webPlaceholderLinkFindings, webScreenRole, webScreenTitle, webTransitionOrigin, webUnavailableShellPhrase } from "../mcp-server/src/web-explorer.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-web-explorer-unit-"));

test("focused web inspection rejects non-http targets before launching a browser", async () => {
  await assert.rejects(inspectWebPage({ url: "file:///private/app.html" }), /valid http\(s\) URL/);
});

test("web context options: device profiles, viewport overrides, and the desktop default", () => {
  const devices = {
    "iPhone 13": { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, defaultBrowserType: "webkit", userAgent: "iphone-ua" },
  };
  assert.deepEqual(webContextOptions({}), { viewport: { width: 1280, height: 900 } });
  const phone = webContextOptions({ device: "iPhone 13", devices });
  assert.deepEqual(phone.viewport, { width: 390, height: 844 });
  assert.equal(phone.isMobile, true);
  assert.equal("defaultBrowserType" in phone, false, "newContext rejects defaultBrowserType — it must be stripped");
  // An explicit viewport wins over the device profile's.
  assert.deepEqual(webContextOptions({ device: "iPhone 13", viewport: "500x600", devices }).viewport, { width: 500, height: 600 });
  assert.throws(() => webContextOptions({ device: "iPhone 99", devices }), /Unknown Playwright device 'iPhone 99'.*iPhone 13/);
  assert.throws(() => parseWebViewport("phone-sized"), /expected WIDTHxHEIGHT/);
  assert.deepEqual(parseWebViewport("390X844"), { width: 390, height: 844 });
});

test("the unavailable-shell heuristic matches only unmistakable outage copy", () => {
  assert.match(webUnavailableShellPhrase("<title>Facebook</title>This content isn't available right now"), /content isn'?t available/i);
  assert.match(webUnavailableShellPhrase("Sorry, this page isn't available."), /page isn'?t available/i);
  assert.equal(webUnavailableShellPhrase("<h1>Pricing</h1>We keep your content available worldwide."), null);
  assert.equal(webUnavailableShellPhrase(""), null);
});

test("help copy about possible failures is not treated as a visible error surface", () => {
  assert.equal(webErrorSurfaceText({
    alertText: "",
    candidateTexts: ["If something went wrong, retry the setup or contact support."],
  }), "");
  assert.match(webErrorSurfaceText({
    alertText: "",
    candidateTexts: ["Something went wrong. Try again."],
  }), /Something went wrong/);
  assert.match(webErrorSurfaceText({
    alertText: "We failed to load your profile",
    candidateTexts: [],
  }), /failed to load/i);
});

test("web controls retain a semantic label when their visible text is empty", () => {
  assert.equal(webControlLabel({ text: "", value: "", ariaLabel: "Choose location", title: "", id: "location" }), "Choose location");
  assert.equal(webControlLabel({ text: "", value: "", ariaLabel: "", title: "Open menu", id: "menu" }), "Open menu");
  assert.equal(webControlLabel({ text: "", value: "", ariaLabel: "", title: "", id: "menu" }), "menu");
});

test("placeholder links are findings unless they advertise real JavaScript control semantics", () => {
  assert.deepEqual(webPlaceholderLinkFindings([
    { rawHref: "#", label: "Download on the App Store", handlerHint: false, fingerprint: "app-store" },
    { rawHref: "", label: "Contact us", handlerHint: false, fingerprint: "contact" },
    { rawHref: "#", label: "", handlerHint: false, fingerprint: "instagram-path" },
    { rawHref: "", label: "Open help", handlerHint: true, fingerprint: "help" },
    { rawHref: "#", label: "Join waitlist", handlerHint: true, fingerprint: "waitlist" },
    { rawHref: "#pricing", label: "Pricing", handlerHint: false, fingerprint: "pricing" },
  ]), [
    {
      type: "placeholder_link",
      severity: "medium",
      title: 'Link "Download on the App Store" has no destination (href="#")',
      target: "Download on the App Store",
    },
    {
      type: "placeholder_link",
      severity: "medium",
      title: 'Link "Contact us" has no destination (href="")',
      target: "Contact us",
    },
    {
      type: "placeholder_link",
      severity: "low",
      title: 'Unlabeled link has no destination (href="#")',
      target: "unlabeled:instagram-path",
    },
  ]);
});

test("an anchor target that mounts async within the recheck window is not a false positive", async () => {
  const responses = ["missing", "missing", "present"];
  const page = {
    evaluate: async () => responses.shift() === "present" ? false : true,
    waitForTimeout: async () => {},
  };
  assert.equal(await webAnchorStillMissing(page, "#tour-widget", { timeoutMs: 1_000, intervalMs: 1 }), false);
});

test("an anchor target that never mounts is reported only after the recheck window elapses", async () => {
  let polls = 0;
  const page = {
    evaluate: async () => { polls += 1; return true; },
    waitForTimeout: async () => {},
  };
  assert.equal(await webAnchorStillMissing(page, "#nowhere", { timeoutMs: 30, intervalMs: 10 }), true);
  assert.ok(polls >= 2, "polled more than once across the recheck window");
});

test("an anchor href with no id (bare '#') is reported without polling — there is nothing to look up", async () => {
  let called = false;
  const page = { evaluate: async () => { called = true; return true; } };
  assert.equal(await webAnchorStillMissing(page, "#", {}), true);
  assert.equal(called, false);
});

test("element evidence is captured only after scrolling the real element into view", async () => {
  const calls = [];
  const element = {
    count: async () => 1,
    scrollIntoViewIfNeeded: async () => calls.push("scroll"),
    screenshot: async ({ path: p }) => { calls.push("shot"); fs.writeFileSync(p, "fake-png"); },
  };
  const locator = { first: () => element };
  const page = { waitForTimeout: async () => {}, screenshot: async () => { throw new Error("should not fall back"); } };
  const name = await captureElementEvidence(page, locator, tmpDir, "evidence.png");
  assert.equal(name, "evidence.png");
  assert.deepEqual(calls, ["scroll", "shot"]);
  assert.equal(fs.readFileSync(path.join(tmpDir, "evidence.png"), "utf8"), "fake-png");
});

test("element evidence falls back to a viewport shot when the element itself can't be screenshotted", async () => {
  const element = {
    count: async () => 1,
    scrollIntoViewIfNeeded: async () => {},
    screenshot: async () => { throw new Error("zero-size element"); },
  };
  const locator = { first: () => element };
  const page = { waitForTimeout: async () => {}, screenshot: async ({ path: p }) => fs.writeFileSync(p, "fallback-png") };
  const name = await captureElementEvidence(page, locator, tmpDir, "fallback.png");
  assert.equal(name, "fallback.png");
  assert.equal(fs.readFileSync(path.join(tmpDir, "fallback.png"), "utf8"), "fallback-png");
});

test("element evidence is skipped, not thrown, when the flagged element cannot be relocated", async () => {
  const locator = { first: () => ({ count: async () => 0 }) };
  assert.equal(await captureElementEvidence({}, locator, tmpDir, "unused.png"), null);
});

test("dead-control judgment ignores unrelated DOM churn and honors durable wiring or semantic change", () => {
  const stable = { url: "https://example.test/", heading: "Home", dialogs: "", local: "same" };
  assert.equal(webControlHadEffect({ wired: false, before: stable, after: stable }), false);
  assert.equal(webControlHadEffect({ wired: true, before: stable, after: stable }), true);
  assert.equal(webControlHadEffect({ wired: false, before: stable, after: { ...stable, local: "expanded" } }), true);
  assert.equal(webControlHadEffect({ wired: false, before: stable, after: { ...stable, dialogs: "location" } }), true);
});

test("web request failures exclude navigation-aborted resources but retain real transport failures", () => {
  assert.equal(shouldReportWebRequestFailure("net::ERR_ABORTED"), false);
  assert.equal(shouldReportWebRequestFailure("net::ERR_CONNECTION_REFUSED"), true);
  assert.equal(shouldReportWebRequestFailure("net::ERR_NAME_NOT_RESOLVED"), true);
});

test("a terse or visual web page is not mislabeled as blank", () => {
  assert.equal(webPageAppearsBlank({ textLen: 8, controlCount: 1, visualContentCount: 0 }), false);
  assert.equal(webPageAppearsBlank({ textLen: 0, controlCount: 0, visualContentCount: 1 }), false);
  assert.equal(webPageAppearsBlank({ textLen: 0, controlCount: 1, visualContentCount: 0 }), false);
  assert.equal(webPageAppearsBlank({ textLen: 0, controlCount: 0, visualContentCount: 0 }), true);
});

test("web login submits a semantic SPA button even when it is outside a form", async () => {
  let clicked = false;
  let previewed = false;
  const hidden = { first() { return this; }, async isVisible() { return false; } };
  const semantic = {
    first() { return this; },
    async isVisible() { return true; },
    async click() { clicked = true; },
  };
  const page = {
    locator() { return hidden; },
    getByRole(role, options) {
      assert.equal(role, "button");
      assert.match("Sign in", options.name);
      return semantic;
    },
  };
  assert.equal(await submitWebLogin(page, async (locator) => {
    assert.equal(locator, semantic);
    previewed = true;
  }), true);
  assert.equal(previewed, true);
  assert.equal(clicked, true);
});

test("SPA screen identity prefers the visible h1 over a static document title", () => {
  assert.equal(webScreenTitle({ heading: "Messages", title: "Acme" }, "/"), "Messages");
  assert.equal(webScreenTitle({ heading: "", title: "Acme" }, "/"), "Acme");
});

test("actions after a same-URL SPA transition are attributed to the latest observation", () => {
  let active = { screen: "Sign in" };
  active = { screen: "Feed" };
  assert.equal(webActionScreen(active, "Sign in"), "Feed");
  active = { screen: "Messages" };
  assert.equal(webActionScreen(active, "Feed"), "Messages");
});

test("BFS navigation attributes transitions to the link label, never a stale button action", () => {
  assert.equal(webNavigationAction("Features", "/features.html"), "Features");
  assert.equal(webNavigationAction("", "/features.html"), "/features.html");
});

test("BFS navigation owns an edge by the screen where the link was observed", () => {
  assert.equal(webTransitionOrigin({ fromScreen: "WebDemo" }, "Features"), "WebDemo");
  assert.equal(webTransitionOrigin(null, "Features"), "Features");
});

test("web map roles are derived from observed semantics", () => {
  assert.equal(webScreenRole("Sign in", [{ label: "Password", secure: true }]), "login");
  assert.equal(webScreenRole("Messages"), "messaging");
  assert.equal(webScreenRole("Profile", [{ label: "Name", secure: false }]), "form");
});

test("hosted web exploration fails closed without its public-egress proxy", () => {
  assert.throws(
    () => webBrowserLaunchOptions({ TAPP_ENFORCE_PUBLIC_EGRESS: "1" }),
    /public egress policy proxy is required/,
  );
  const options = webBrowserLaunchOptions({
    TAPP_ENFORCE_PUBLIC_EGRESS: "1",
    TAPP_BROWSER_PROXY_SERVER: "http://127.0.0.1:43210",
  });
  assert.equal(options.proxy.server, "http://127.0.0.1:43210");
  assert.ok(options.args.includes("--disable-quic"));
  assert.ok(options.args.some((argument) => argument.includes("disable_non_proxied_udp")));
});

test("web watch mode changes only the controlled browser presentation", () => {
  assert.deepEqual(webBrowserLaunchOptions({}), { headless: true, args: [] });
  assert.deepEqual(webBrowserLaunchOptions({}, { watch: true }), {
    headless: false,
    slowMo: 200,
    args: [],
  });
});

test("PR seed routes are same-origin, bounded, deduplicated, and exclude the start page", () => {
  assert.deepEqual(normalizeWebSeedRoutes("https://example.test/app?mode=qa", [
    "/pricing.html",
    "https://example.test/pricing.html",
    "https://other.test/private",
    "/app?mode=qa",
    "/status.html#details",
    "/ignored.html",
  ], 2), ["/pricing.html", "/status.html"]);
  assert.deepEqual(normalizeWebSeedRoutes("https://example.test/", ["/pricing.html"], 0), []);
});

test("web PR targets accept only bounded route or deterministic UI Map path plans", () => {
  const pathTarget = {
    id: "dynamic", platform: "web", status: "planned", node: { id: "messages", name: "Messages" },
    navigation: { status: "replayable", mode: "ui-map-path", steps: [{ action: { type: "tap", target: "Messages" } }] },
  };
  assert.deepEqual(normalizeWebSeedTargets([
    pathTarget,
    pathTarget,
    { id: "route", platform: "web", status: "planned", node: { id: "pricing", name: "Pricing" }, navigation: { status: "replayable", mode: "route", route: "/pricing" } },
    { id: "bad", platform: "web", status: "planned", navigation: { status: "replayable", mode: "ui-map-path", steps: [{ action: { type: "type", target: "secret" } }] } },
  ]), [pathTarget, {
    id: "route", platform: "web", status: "planned", node: { id: "pricing", name: "Pricing" }, navigation: { status: "replayable", mode: "route", route: "/pricing" },
  }]);
});

test("control labels read like a screen reader: nested and shadow-DOM text, space-separated", { skip: process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1", timeout: 60_000 }, async (t) => {
  let chromium; try { ({ chromium } = await import("playwright")); } catch { t.skip("playwright not installed"); return; }
  if (!chromium) { t.skip("playwright not installed"); return; }
  const http = await import("node:http");
  const html = `<!doctype html><title>Buy</title><body>
    <button class="tier"><div><strong>20 Sessions</strong><span>$2,000</span></div></button>
    <div id="host"></div>
    <script>
      const root = document.getElementById("host").attachShadow({ mode: "open" });
      root.innerHTML = '<button id="shadow-tier"><b>5 Sessions</b><i>$600</i></button>';
    </script>
  </body>`;
  const server = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(html); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { inspectWebPage } = await import("../mcp-server/src/web-explorer.js");
    const snap = await inspectWebPage({ url: `http://127.0.0.1:${server.address().port}/`, screenshot: false });
    const labels = snap.elements.map((e) => e.label);
    // Field issue #19: nested pieces run together / shadow content invisible meant
    // `assert_exists: "$2,000"` had nothing to match in the tree.
    assert.ok(labels.includes("20 Sessions $2,000"), `nested text is space-separated; got ${JSON.stringify(labels)}`);
  } finally {
    server.close();
  }
});

test("the read-only audit finds structurally dead controls without clicking anything", { skip: process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1", timeout: 60_000 }, async (t) => {
  let chromium; try { ({ chromium } = await import("playwright")); } catch { t.skip("playwright not installed"); return; }
  if (!chromium) { t.skip("playwright not installed"); return; }
  const http = await import("node:http");
  // Field issue #24: these are controls that were never alive, so no Flow covers them —
  // nobody writes a test for a button they believe does nothing.
  const html = `<!doctype html><title>Coach</title><body>
    <a href="#availability-section">View Availability</a>
    <a href="#bio">Bio</a><div id="bio">Bio</div>
    <a href="#">Placeholder</a>
    <button id="dead-btn">Dead Button</button>
    <button id="live-btn">Live Button</button>
    <button aria-controls="missing-panel">Toggle</button>
    <form><button type="submit">Submit</button></form>
    <script>document.getElementById('live-btn').addEventListener('click', () => {});</script>
  </body>`;
  const server = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(html); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { auditWebPage } = await import("../mcp-server/src/web-explorer.js");
    const result = await auditWebPage({ url: `http://127.0.0.1:${server.address().port}/` });
    const titles = result.findings.map((f) => f.title).join(" | ");
    assert.match(titles, /View Availability.*availability-section/, "a fragment target absent from the DOM");
    assert.match(titles, /Placeholder.*no destination/, "href=\"#\"");
    assert.match(titles, /Dead Button.*no click handler/, "a button with nothing behind it");
    assert.match(titles, /Toggle.*aria-controls/, "aria-controls pointing at nothing");
    // Working controls must never be accused: a real anchor, a wired button, a form submit.
    assert.doesNotMatch(titles, /Live Button|Submit|“Bio”/);
    assert.equal(result.findings.length, 4, titles);
  } finally {
    server.close();
  }
});

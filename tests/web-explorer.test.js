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
  const html = `<!doctype html><title>Coach</title><meta name="viewport" content="width=device-width"><body>
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

test("the audit does not accuse a control that is wired in CSS rather than JavaScript", { skip: process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1", timeout: 60_000 }, async (t) => {
  let chromium; try { ({ chromium } = await import("playwright")); } catch { t.skip("playwright not installed"); return; }
  if (!chromium) { t.skip("playwright not installed"); return; }
  const http = await import("node:http");
  // A menu that opens while its trigger is hovered or focused has no listener to
  // find. Reported from the field: a live nav dropdown was called dead, which is
  // the kind of wrong answer that makes people stop reading the findings.
  const html = `<!doctype html><title>Nav</title><meta name="viewport" content="width=device-width"><style>
    .menu { display: none }
    .group:hover .menu { display: block }
    .group:focus-within .menu { display: block }
    button:hover { background: #eee }
  </style><body>
    <div class="group"><button id="css-trigger">Menu</button><div class="menu"><a href="/a">One</a></div></div>
    <button id="dead-btn">Dead Button</button>
  </body>`;
  const server = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(html); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { auditWebPage } = await import("../mcp-server/src/web-explorer.js");
    const result = await auditWebPage({ url: `http://127.0.0.1:${server.address().port}/` });
    const titles = result.findings.map((f) => f.title).join(" | ");
    assert.doesNotMatch(titles, /Menu/, "a hover/focus-driven trigger is wired, just not in JavaScript");
    // And the exemption stays narrow: `button:hover { background }` restyles only
    // itself, so it must not excuse every unwired button on the page.
    assert.match(titles, /Dead Button.*no click handler/);
    assert.equal(result.findings.length, 1, titles);
  } finally {
    server.close();
  }
});

test("the audit does not accuse jQuery-delegated controls, wired placeholder links, or icon-only links it can name", { skip: process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1", timeout: 60_000 }, async (t) => {
  let chromium; try { ({ chromium } = await import("playwright")); } catch { t.skip("playwright not installed"); return; }
  if (!chromium) { t.skip("playwright not installed"); return; }
  const http = await import("node:http");
  // Precision pass 2026-10-12 on 25 real small-business sites: 47% of findings were href="#"
  // links that had click handlers, and 104 "dead buttons" on one WordPress site were Elementor
  // accordion headers wired through jQuery's delegation registry. Neither is a defect.
  const html = `<!doctype html><title>WP</title><meta name="viewport" content="width=device-width"><body>
    <script>
      // a minimal jQuery-shaped registry: $(document).on("click", ".elementor-tab-title", fn)
      window.jQuery = { _data: (node, key) => (node === document && key === "events") ? { click: [{ selector: ".elementor-tab-title", handler: () => {} }] } : undefined };
    </script>
    <div class="elementor-tab-title" role="button" tabindex="0">Do you provide free estimates?</div>
    <a href="#" id="menu-toggle">Menu</a>
    <a href="#" id="really-dead-link">Dead placeholder</a>
    <a href="#" id="icon-only"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" alt="Open cart"></a>
    <button id="dead-btn">Dead Button</button>
    <script>document.getElementById('menu-toggle').addEventListener('click', () => {});</script>
  </body>`;
  const server = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(html); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { auditWebPage } = await import("../mcp-server/src/web-explorer.js");
    const result = await auditWebPage({ url: `http://127.0.0.1:${server.address().port}/` });
    const titles = result.findings.map((f) => f.title).join(" | ");
    assert.doesNotMatch(titles, /free estimates/, "a jQuery-delegated accordion header is wired");
    assert.doesNotMatch(titles, /“Menu”/, "an href=\"#\" link with a click handler is a control, not a dead link");
    assert.match(titles, /Dead placeholder.*no destination/, "an href=\"#\" link with nothing behind it still is");
    assert.match(titles, /“Open cart”.*no destination/, "an icon-only link is named by its image, not by a selector");
    assert.match(titles, /Dead Button.*no click handler/);
    assert.doesNotMatch(titles, /data-tapp-audit/, "evidence selectors never leak into titles");
    assert.equal(result.findings.length, 3, titles);
  } finally {
    server.close();
  }
});

test("the audit declares the wiring check unverifiable, rather than accusing, on deferred-script and hydration-less pages", { skip: process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1", timeout: 60_000 }, async (t) => {
  let chromium; try { ({ chromium } = await import("playwright")); } catch { t.skip("playwright not installed"); return; }
  if (!chromium) { t.skip("playwright not installed"); return; }
  const http = await import("node:http");
  // Precision pass 2026-10-12: a Perfmatters site (every script type="pmdelayedscript" until a
  // user interacts) produced 104 "dead buttons"; a Wix site attached no handler at all at audit
  // time; a Squarespace site wires every button from one listener on <body>. None is a defect.
  const pages = {
    "/deferred": `<!doctype html><title>D</title><meta name="viewport" content="width=device-width"><body>
      <script type="pmdelayedscript">document.getElementById('m').addEventListener('click', () => {});</script>
      <button id="m">Menu</button><a href="#" id="p">Placeholder</a>
      <button aria-controls="nope">Toggle</button></body>`,
    "/nohandlers": `<!doctype html><title>W</title><meta name="viewport" content="width=device-width"><body>
      <script src="/bundle.js" defer></script>
      <div role="button" aria-label="Open navigation menu"></div><button>Previous</button><button>Next</button></body>`,
    "/bodydelegate": `<!doctype html><title>S</title><meta name="viewport" content="width=device-width"><body>
      <button>Sign Up</button><button>Menu</button><button>Search</button>
      <script>document.body.addEventListener('click', function (e) { route(e.target); });</script></body>`,
    "/live": `<!doctype html><title>L</title><meta name="viewport" content="width=device-width"><body>
      <button id="ok">Works</button><button id="dead">Dead Button</button>
      <script>document.getElementById('ok').addEventListener('click', () => {}); document.addEventListener('click', (e) => { track(e); });</script></body>`,
  };
  const server = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(pages[new URL(q.url, "http://x").pathname] || ""); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { auditWebSite } = await import("../mcp-server/src/web-explorer.js");
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = async (p) => (await auditWebSite({ url: base + p, pages: 1 })).pages[0];
    const deferred = await page("/deferred");
    assert.match(deferred.wiringUnverifiable, /defers its scripts/);
    assert.deepEqual(deferred.findings.map((f) => f.type), ["dangling_aria_controls"], "only the check that needs no wiring survives");
    const wix = await page("/nohandlers");
    assert.match(wix.wiringUnverifiable, /no click handler at all/);
    assert.equal(wix.findings.length, 0);
    const sqs = await page("/bodydelegate");
    assert.match(sqs.wiringUnverifiable, /site-wide click handler/);
    assert.equal(sqs.findings.length, 0);
    // An opaque global handler plus ONE dead control is still a dead control: the rule needs three.
    const live = await page("/live");
    assert.equal(live.wiringUnverifiable, undefined);
    assert.match(live.findings.map((f) => f.title).join(" | "), /Dead Button/);
    const site = await auditWebSite({ url: base + "/deferred", pages: 1 });
    assert.match(site.notChecked.join("\n"), /defers its scripts/, "the scope says what was not checked");
  } finally {
    server.close();
  }
});

test("the audit does not accuse a control whose handler is delegated from the document", { skip: process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1", timeout: 60_000 }, async (t) => {
  let chromium; try { ({ chromium } = await import("playwright")); } catch { t.skip("playwright not installed"); return; }
  if (!chromium) { t.skip("playwright not installed"); return; }
  const http = await import("node:http");
  // Delegation puts the listener on document, not on the control, so an
  // element-only search reports every delegated button as dead. Reported from
  // the field: a help centre where all 26 controls are delegated came back as
  // 26 findings, which is enough wrong answers to retire the command.
  const html = `<!doctype html><title>Help</title><meta name="viewport" content="width=device-width"><body>
    <button data-topic="billing">Billing</button>
    <button data-article="refunds">Refunds</button>
    <button id="really-dead">Dead Button</button>
    <script>
      document.addEventListener('click', (e) => {
        if (e.target.closest('[data-topic]')) return;
        if (e.target.closest('[data-article]')) return;
      });
      // An outside-click closer claims no control and must not excuse the dead one.
      document.addEventListener('click', (e) => { if (!document.body.contains(e.target)) return; });
    <\/script>
  </body>`;
  const server = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(html); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { auditWebPage } = await import("../mcp-server/src/web-explorer.js");
    const result = await auditWebPage({ url: `http://127.0.0.1:${server.address().port}/` });
    const titles = result.findings.map((f) => f.title).join(" | ");
    assert.doesNotMatch(titles, /Billing|Refunds/, "a delegated handler claims these");
    assert.match(titles, /Dead Button.*no click handler/, "and the exemption must stay narrow");
    assert.equal(result.findings.length, 1, titles);
  } finally {
    server.close();
  }
});

// A screen used to be identified by its heading, else its title, else its URL. Modals, drawers,
// tabs and wizard steps rarely change the heading, so they were all "the same screen": the
// frontier gained nothing, exploration drained early, coverage undercounted, and the recording
// showed one near-identical frame for a whole run.
test("the state signature distinguishes what is on screen, and ignores what does not matter", async () => {
  const { webStateSignature } = await import("../mcp-server/src/web-explorer.js");
  const page = { controls: [{ kind: "button", label: "Open cart" }, { kind: "button", label: "Subscribe" }], inputs: [] };
  const withDrawer = { controls: [...page.controls, { kind: "button", label: "Close" }, { kind: "button", label: "Checkout" }], inputs: [] };
  const withModal = { controls: page.controls, inputs: [{ id: "sub-email", placeholder: "email" }] };

  assert.notEqual(webStateSignature(page), webStateSignature(withDrawer), "an opened drawer is a different state");
  assert.notEqual(webStateSignature(page), webStateSignature(withModal), "a modal with a field is a different state");
  assert.notEqual(webStateSignature(withDrawer), webStateSignature(withModal));

  // Stability: the same controls painted in a different order, or with text reflowed around
  // them, must not look like somewhere new — otherwise every run invents states.
  const reordered = { controls: [...page.controls].reverse(), inputs: [] };
  assert.equal(webStateSignature(page), webStateSignature(reordered), "order must not change identity");
  const spaced = { controls: [{ kind: "button", label: "  Open   cart " }, { kind: "button", label: "SUBSCRIBE" }], inputs: [] };
  assert.equal(webStateSignature(page), webStateSignature(spaced), "whitespace and case must not change identity");

  // Nothing actionable on screen is not a signature; it must fall back to the old identity.
  assert.equal(webStateSignature({ controls: [], inputs: [] }), "");
  assert.equal(webStateSignature(undefined), "");

  // Stable across runs and processes: a language runtime's own hash is not.
  assert.equal(webStateSignature(page), webStateSignature(structuredClone(page)));
  assert.match(webStateSignature(page), /^[a-z0-9]{1,12}$/);
});

test("one route cannot mint unlimited states", async () => {
  const { MAX_STATES_PER_ROUTE } = await import("../mcp-server/src/web-explorer.js");
  // A carousel, a live counter or a shuffling feed changes what is on screen forever. The cap is
  // what stops a single URL from becoming the entire exploration.
  assert.ok(Number.isInteger(MAX_STATES_PER_ROUTE) && MAX_STATES_PER_ROUTE > 1 && MAX_STATES_PER_ROUTE <= 20,
    `the per-route cap must be a small positive integer, got ${MAX_STATES_PER_ROUTE}`);
});

// Cookie banners and intake modals sit in front of a large share of real sites. On one real site
// a location-intake modal made every control on the home page unreachable, so the coach search,
// sign-in and booking flows were never discovered and the run reported seventeen controls it
// "could not click" — while the site looked, from the outside, like a six-page brochure.
test("an overlay is dismissed by its own way out, never by consenting", async () => {
  const { chooseOverlayDismissal } = await import("../mcp-server/src/web-explorer.js");

  // The real modal that prompted this.
  assert.equal(
    chooseOverlayDismissal(["Allow Device Location", "Enter Zip Code Instead", "Save", "Not now", "Don't ask again"]),
    "Not now",
  );

  // Consent: decline rather than accept, and never on someone's behalf.
  assert.equal(chooseOverlayDismissal(["Accept all", "Reject all", "Manage preferences"]), "Reject all");
  assert.equal(chooseOverlayDismissal(["Accept all cookies", "Necessary only"]), "Necessary only");

  // When the only way out would grant something, there is no way out: refuse rather than press it.
  assert.equal(chooseOverlayDismissal(["Accept all cookies", "Learn more"]), null);
  assert.equal(chooseOverlayDismissal(["Allow notifications", "Enable location"]), null);
  assert.equal(chooseOverlayDismissal(["Sign up", "Subscribe"]), null);
  assert.equal(chooseOverlayDismissal([]), null);

  // Ordinary dismissals.
  for (const [labels, expected] of [
    [["No thanks", "Allow"], "No thanks"],
    [["Maybe later"], "Maybe later"],
    [["Got it"], "Got it"],
    [["✕"], "✕"],
  ]) {
    assert.equal(chooseOverlayDismissal(labels), expected, `expected ${expected} from ${JSON.stringify(labels)}`);
  }
});

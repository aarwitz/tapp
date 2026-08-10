import test from "node:test";
import assert from "node:assert/strict";
import { inspectWebPage, normalizeWebSeedRoutes, normalizeWebSeedTargets, shouldReportWebRequestFailure, submitWebLogin, webActionScreen, webBrowserLaunchOptions, webControlHadEffect, webControlLabel, webErrorSurfaceText, webNavigationAction, webPageAppearsBlank, webPlaceholderLinkFindings, webScreenRole, webScreenTitle, webTransitionOrigin } from "../mcp-server/src/web-explorer.js";

test("focused web inspection rejects non-http targets before launching a browser", async () => {
  await assert.rejects(inspectWebPage({ url: "file:///private/app.html" }), /valid http\(s\) URL/);
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
    { rawHref: "#", label: "", handlerHint: false, fingerprint: "instagram-path" },
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
      severity: "low",
      title: 'Unlabeled link has no destination (href="#")',
      target: "unlabeled:instagram-path",
    },
  ]);
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
  assert.equal(await submitWebLogin(page), true);
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

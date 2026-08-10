import test from "node:test";
import assert from "node:assert/strict";
import { inspectWebPage, normalizeWebSeedRoutes, normalizeWebSeedTargets, submitWebLogin, webActionScreen, webBrowserLaunchOptions, webControlLabel, webErrorSurfaceText, webNavigationAction, webScreenRole, webScreenTitle, webTransitionOrigin } from "../mcp-server/src/web-explorer.js";

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

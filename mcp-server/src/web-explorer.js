// Web exploration driver (beta) — the second platform behind the OCQA marker protocol.
//
// Drives a real browser via Playwright and emits the SAME OCQA_* marker lines the iOS
// XCUITest harness emits, into the same captures/<id>/ocqa-markers.txt layout — so the
// entire judgment layer (report.js verdict/dedup/regression, the CI gate, baselines,
// capture tooling) works on web runs unchanged. This file is the platform seam made
// concrete: a driver's whole contract is "emit honest markers".
//
// Deterministic by design, like the iOS harness: BFS over same-origin pages, a bounded
// button pass per page, deterministic issue detectors (uncaught JS exceptions, failed/5xx
// same-origin requests, broken links, dead buttons, visible error surfaces, blank pages,
// load timeouts). No LLM anywhere in the loop.
//
// Playwright is deliberately NOT a required dependency of Tapp (it would bloat every npx
// install with a browser download). It's resolved dynamically; exploreWeb() throws a
// clear install hint when it's missing.

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { execFileSync } from "child_process";

const SETTLE_MS = 500;
const CLICK_SETTLE_MS = 700;
const NAV_TIMEOUT_MS = 15_000;
const BUTTONS_PER_PAGE = 4;
const ERROR_TEXT_RE = /\b(something went wrong|internal server error|an error occurred|failed to load|unhandled exception)\b/i;

// npx installs Tapp into its own cache, so a plain import("playwright") only resolves
// for repo-dev checkouts. Probe, in order: our own node_modules; the user's project
// (process.cwd()); the global npm root. ESM ignores NODE_PATH, so cwd/global need explicit
// resolution + import-by-absolute-path.
export async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {}
  const probes = [path.join(process.cwd(), "noop.js")];
  try {
    probes.push(path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "noop.js"));
  } catch {}
  for (const from of probes) {
    try {
      return await import(createRequire(from).resolve("playwright"));
    } catch {}
  }
  throw new Error(
    "Web exploration needs Playwright (not bundled, to keep Tapp installs small). " +
      "One-time setup, either works: `npm i playwright` in your project, or `npm i -g playwright` — " +
      "then `npx playwright install chromium`."
  );
}

export async function submitWebLogin(page) {
  const candidates = [
    page.locator("button[type=submit], input[type=submit], form button").first(),
    page.getByRole("button", { name: /sign ?in|log ?in|continue/i }).first(),
  ];
  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click({ timeout: 3000 });
      return true;
    }
  }
  return false;
}

export function webScreenTitle(info, fallback) {
  return String(info?.heading || info?.title || fallback || "").trim();
}

export function webActionScreen(activeObservation, fallback = "Unknown") {
  return activeObservation?.screen || fallback;
}

export function webNavigationAction(linkLabel, route) {
  return String(linkLabel || "").trim() || String(route || "transition");
}

export function webTransitionOrigin(pendingNavigation, currentScreen) {
  return pendingNavigation?.fromScreen || currentScreen || null;
}

export function webBrowserLaunchOptions(environment = process.env) {
  const browserProxy = String(environment.TAPP_BROWSER_PROXY_SERVER || "").trim();
  if (environment.TAPP_ENFORCE_PUBLIC_EGRESS === "1" && !/^http:\/\/127\.0\.0\.1:\d+$/.test(browserProxy)) {
    throw new Error("public egress policy proxy is required");
  }
  return {
    headless: true,
    ...(browserProxy ? { proxy: { server: browserProxy, bypass: "<-loopback>" } } : {}),
    args: browserProxy ? [
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--proxy-bypass-list=<-loopback>",
    ] : [],
  };
}

// Focused one-screen inspection for the agent-facing `tapp open <url>` and `tapp tree <url>`
// commands. This deliberately does no exploration or judgment; it opens exactly one page,
// captures the visible semantic controls, and optionally takes one screenshot.
export async function inspectWebPage({ url, timeoutMs = NAV_TIMEOUT_MS, screenshot = true }) {
  let target;
  try { target = new URL(url); }
  catch { throw new Error("Web inspection needs a valid http(s) URL"); }
  if (!/^https?:$/.test(target.protocol)) throw new Error("Web inspection needs a valid http(s) URL");

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch(webBrowserLaunchOptions());
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const boundedTimeout = Math.max(1000, Math.min(60_000, Number(timeoutMs) || NAV_TIMEOUT_MS));
    page.setDefaultTimeout(boundedTimeout);
    const response = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: boundedTimeout });
    if (response && response.status() >= 400) throw new Error(`Could not open ${target.href}: HTTP ${response.status()}`);
    await page.waitForTimeout(SETTLE_MS);
    const observed = await page.evaluate(() => {
      const visible = (element) => element.offsetParent !== null;
      const controls = [...document.querySelectorAll("button, a[href], input, textarea, select, [role=button], [role=tab], [role=checkbox], [role=switch]")]
        .filter((element) => element.type !== "hidden" && visible(element))
        .slice(0, 80)
        .map((element) => {
          const tag = element.tagName.toLowerCase();
          const field = ["input", "textarea", "select"].includes(tag);
          const secure = element.type === "password";
          const role = element.getAttribute("role") || (tag === "a" ? "link" : tag === "button" ? "button" : "");
          const label = (element.labels?.[0]?.textContent || element.getAttribute("aria-label") || element.textContent || element.placeholder || element.name || element.id || "").trim().slice(0, 120);
          return {
            type: field ? (secure ? "SecureTextField" : "TextField") : "Button",
            role,
            label,
            identifier: element.id || element.getAttribute("data-testid") || element.getAttribute("aria-label") || "",
            isEnabled: !element.disabled && element.getAttribute("aria-disabled") !== "true",
            hittable: true,
            secure,
          };
        })
        .filter((control) => control.label || control.identifier);
      return {
        heading: document.querySelector("h1")?.textContent?.trim() || "",
        title: document.title.trim(),
        controls,
      };
    });
    const image = screenshot ? await page.screenshot({ type: "png" }) : null;
    return {
      url: page.url(),
      screenTitle: webScreenTitle(observed, target.pathname || target.href),
      elements: observed.controls,
      image,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

export function normalizeWebSeedRoutes(url, routes, limit = 5) {
  const origin = new URL(url);
  const boundedLimit = Math.max(0, Math.min(10, Number(limit) || 0));
  if (boundedLimit === 0) return [];
  const startKey = origin.pathname.replace(/\/+$/, "") + origin.search || "/";
  const normalized = [];
  for (const raw of routes || []) {
    const value = typeof raw === "string" ? raw : raw?.path;
    if (!value) continue;
    let route;
    try { route = new URL(value, origin); } catch { continue; }
    if (route.origin !== origin.origin || !/^https?:$/.test(route.protocol)) continue;
    const key = route.pathname.replace(/\/+$/, "") + route.search || "/";
    if (!normalized.includes(key) && key !== startKey) normalized.push(key);
    if (normalized.length >= boundedLimit) break;
  }
  return normalized;
}

export function webScreenRole(screen, inputs = []) {
  const name = String(screen || "").toLowerCase();
  if (inputs.some((input) => input.secure) || /sign ?in|log ?in/.test(name)) return "login";
  if (/checkout|payment|purchase/.test(name)) return "checkout";
  if (/message|chat|conversation/.test(name)) return "messaging";
  if (/settings|preference/.test(name)) return "settings";
  if (/feed|list|catalog|search|home/.test(name)) return "list";
  if (inputs.length) return "form";
  return "screen";
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";
}

export function normalizeWebSeedTargets(seedTargets = [], limit = 5) {
  const maximum = Math.max(0, Math.min(5, Number(limit) || 0));
  if (!maximum || !Array.isArray(seedTargets)) return [];
  const result = [];
  const ids = new Set();
  for (const target of seedTargets) {
    if (target?.platform !== "web" || target?.status !== "planned" || target?.navigation?.status !== "replayable" || typeof target.id !== "string" || !target.id || ids.has(target.id)) continue;
    const navigation = target.navigation;
    if (navigation.mode === "route") {
      if (typeof navigation.route !== "string" || !navigation.route.startsWith("/")) continue;
    } else if (navigation.mode === "ui-map-path") {
      if (!Array.isArray(navigation.steps) || navigation.steps.length > 8 || navigation.steps.some((step) =>
        !["tap", "back"].includes(step?.action?.type) || typeof step?.action?.target !== "string" || !step.action.target)) continue;
    } else continue;
    ids.add(target.id);
    result.push(structuredClone(target));
    if (result.length >= maximum) break;
  }
  return result;
}

export async function exploreWeb({ url, maxActions = 40, timeoutSec = 300, outDir, testEmail = "", testPassword = "", seedRoutes = [], seedTargets = [], onProgress }) {
  const start = new URL(url);
  if (!/^https?:$/.test(start.protocol)) throw new Error("url must be http(s)");
  fs.mkdirSync(outDir, { recursive: true });
  const markersPath = path.join(outDir, "ocqa-markers.txt");
  const markersFd = fs.openSync(markersPath, "w");
  const emit = (kind, payload) => fs.writeSync(markersFd, `OCQA_${kind}:${JSON.stringify(payload)}\n`);

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch(webBrowserLaunchOptions());
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  const deadline = Date.now() + timeoutSec * 1000;
  const issues = []; // emitted immediately; kept for counting only
  const issue = (type, severity, title, screen, target) => {
    issues.push(type);
    emit("ISSUE", { type, severity, title, screen, ...(target ? { target } : {}) });
  };

  // Request counter: cheap "did that click cause network activity" signal for the
  // dead-button check (a button that fires a request is not dead).
  let requestCount = 0;

  // Async defect listeners: attribute to whatever screen is current when they fire.
  let currentScreen = start.pathname;
  let lastActionTarget = "";
  page.on("request", () => { requestCount += 1; });
  page.on("pageerror", (err) => issue("js_exception", "high", `Uncaught JS exception: ${String(err.message || err).slice(0, 120)}`, currentScreen));
  page.on("response", (res) => {
    try {
      const u = new URL(res.url());
      if (u.origin !== start.origin) return;
      if (res.status() >= 500) issue("network_error", "high", `${res.status()} from ${u.pathname.slice(0, 80)}`, currentScreen);
      else if (res.status() === 404 && res.request().resourceType() !== "document") {
        issue("missing_asset", "medium", `404 asset: ${u.pathname.slice(0, 80)}`, currentScreen);
      }
    } catch {}
  });
  page.on("requestfailed", (req) => {
    try {
      const u = new URL(req.url());
      if (u.origin !== start.origin) return;
      issue("network_error", "medium", `Request failed: ${u.pathname.slice(0, 80)} (${req.failure()?.errorText || "?"})`, currentScreen);
    } catch {}
  });

  const visited = new Set(); // screen keys (pathname+search)
  const normalizedSeeds = normalizeWebSeedRoutes(url, seedRoutes);
  const normalizedTargets = normalizeWebSeedTargets(seedTargets);
  const targetRoutes = new Set(normalizedTargets.filter((target) => target.navigation.mode === "route").map((target) => target.navigation.route));
  const frontier = [
    { target: start.pathname + start.search, action: start.pathname + start.search, fromScreen: null },
    ...normalizedTargets.map((target) => target.navigation.mode === "route"
      ? { target: target.navigation.route, action: `PR target ${target.navigation.route}`, fromScreen: null, prTarget: true, targetId: target.id }
      : { target: start.pathname + start.search, visitKey: `pr-path:${target.id}`, action: `PR target ${target.node.name}`, fromScreen: null, prTarget: true, targetId: target.id, pathTarget: target }),
    ...normalizedSeeds.filter((target) => !targetRoutes.has(target)).map((target) => ({ target, action: `PR target ${target}`, fromScreen: null, prTarget: true })),
  ];
  const screenshotFor = new Set();
  let actions = 0;
  let screenCount = 0;
  let lastScreen = null;
  let pendingNavigation = null;
  let loginTried = false;

  const screenKey = () => {
    const u = new URL(page.url());
    return u.pathname.replace(/\/+$/, "") + u.search || "/";
  };

  // Read the page's state and emit OCQA_STATE — the web analog of the a11y snapshot.
  async function observe() {
    const info = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll("input, textarea, select")]
        .filter((el) => el.type !== "hidden" && el.offsetParent !== null)
        .slice(0, 12)
        .map((el) => ({
          label: (el.labels?.[0]?.textContent || el.placeholder || el.name || el.id || "").trim().slice(0, 60),
          secure: el.type === "password",
        }))
        .filter((f) => f.label);
      const controls = [...document.querySelectorAll("button, a[href], input, textarea, select, [role=button], [role=tab], [role=checkbox], [role=switch]")]
        .filter((el) => el.type !== "hidden" && el.offsetParent !== null)
        .slice(0, 60)
        .map((el) => {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "button" ? "button" : "");
          const field = ["input", "textarea", "select"].includes(tag);
          const secure = el.type === "password";
          const label = (el.labels?.[0]?.textContent || el.getAttribute("aria-label") || el.textContent || el.placeholder || el.name || el.id || "").trim().slice(0, 120);
          return {
            kind: field ? (secure ? "secureField" : "field") : role || "control",
            role,
            label,
            id: el.id || "",
            cssId: el.id || "",
            testId: el.getAttribute("data-testid") || "",
            accessibilityId: el.getAttribute("aria-label") || "",
            secure,
            enabled: !el.disabled && el.getAttribute("aria-disabled") !== "true",
            hittable: true,
          };
        })
        .filter((control) => control.label || control.id || control.testId);
      return {
        heading: document.querySelector("h1")?.textContent?.trim() || "",
        title: document.title.trim(),
        controlCount: document.querySelectorAll("a[href], button, [role=button], input, select, textarea").length,
        textLen: (document.body?.innerText || "").trim().length,
        alertText: [...document.querySelectorAll("[role=alert], [class*=error i]")]
          .map((el) => el.textContent.trim()).filter(Boolean).join(" ").slice(0, 120),
        inputs,
        controls,
      };
    }).catch(() => null);
    if (!info) return null;

    const key = screenKey();
    const screen = webScreenTitle(info, key);
    const evidenceKey = `${key}::${screen}`;
    currentScreen = screen;
    emit("STATE", { screen, url: key, elements: info.controlCount, role: webScreenRole(screen, info.inputs), controls: info.controls, inputs: info.inputs, settled: true });
    const completedNavigation = pendingNavigation;
    const transitionFrom = webTransitionOrigin(completedNavigation, lastScreen);
    const transitionAction = completedNavigation?.action || lastActionTarget;
    if (transitionFrom && transitionFrom !== screen) emit("TRANSITION", { from: transitionFrom, to: screen, ...(transitionAction ? { action: transitionAction } : {}) });
    pendingNavigation = null;
    if (lastScreen !== screen) lastActionTarget = "";
    lastScreen = screen;
    if (completedNavigation?.prTarget) emit("PR_TARGET", { ...(completedNavigation.targetId ? { targetId: completedNavigation.targetId } : {}), route: completedNavigation.target, status: "observed", screen });

    if (!screenshotFor.has(evidenceKey)) {
      screenshotFor.add(evidenceKey);
      screenCount = screenshotFor.size;
      await page.screenshot({ path: path.join(outDir, `state_${screenCount}_${slug(screen)}.png`) }).catch(() => {});
      // Deterministic per-page detectors run once per distinct screen.
      if (info.textLen < 10) issue("blank_screen", "high", "Page rendered no visible text", screen);
      else if (info.alertText && ERROR_TEXT_RE.test(info.alertText)) issue("error_surface", "high", `Error shown: ${info.alertText.slice(0, 80)}`, screen);
      else if (ERROR_TEXT_RE.test(await page.evaluate(() => (document.body?.innerText || "").slice(0, 4000)).catch(() => ""))) {
        issue("error_surface", "high", "Error text visible on page", screen);
      }
    }
    return { key, screen, info };
  }

  // Login preamble parity with iOS: if creds were given and a password field is present,
  // fill + submit once, and flag auth_failed if we clearly bounced.
  async function tryLogin(screen) {
    if (loginTried || !testPassword) return null;
    const pw = page.locator("input[type=password]").first();
    if (!(await pw.isVisible().catch(() => false))) return null;
    loginTried = true;
    const emailSel = "input[type=email], input[name*=mail i], input[name*=user i], input[id*=mail i], input[id*=user i]";
    if (testEmail) await page.locator(emailSel).first().fill(testEmail).catch(() => {});
    await pw.fill(testPassword).catch(() => {});
    lastActionTarget = "Sign in";
    emit("ACTION", { type: "login", target: "Sign in", screen, narrative: "Filled and submitted the sign-in form with the provided test credentials" });
    actions += 1;
    await submitWebLogin(page).catch(() => false);
    await page.waitForTimeout(CLICK_SETTLE_MS * 2);
    // Still on the login form after a submit = the sign-in failed — full stop. (A quiet
    // credential rejection often shows NO other symptom, so this must not be coupled to
    // whether some other detector happened to fire during the attempt.)
    const stillLogin = await page.locator("input[type=password]").first().isVisible().catch(() => false);
    if (stillLogin) {
      const errText = await page
        .locator("[role=alert], .error, [class*=error i]")
        .first()
        .textContent({ timeout: 500 })
        .catch(() => "");
      issue(
        "auth_failed",
        "high",
        `Sign-in attempt did not leave the login form${errText ? ` — “${errText.trim().slice(0, 80)}”` : ""}`,
        currentScreen,
        "login form"
      );
    } else {
      // SPAs commonly replace the login view without changing URL. Capture the
      // authenticated state immediately so coverage does not remain stuck at 1.
      return await observe();
    }
    return null;
  }

  const progress = () => {
    emit("PROGRESS", { action: actions, max: maxActions, states: screenCount });
    if (onProgress) try { onProgress({ action: actions, max: maxActions, states: screenCount }); } catch {}
  };

  try {
    while (frontier.length && actions < maxActions && Date.now() < deadline) {
      const entry = frontier.shift();
      const target = entry.target;
      const visitKey = entry.visitKey || target;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);

      actions += 1;
      lastActionTarget = webNavigationAction(entry.action, target);
      pendingNavigation = entry.pathTarget ? { ...entry, prTarget: false } : entry;
      emit("ACTION", { type: "open", target, via: lastActionTarget, narrative: `Opened ${target}` });
      // Attribute load-time events (pageerror, 404s) to the page being loaded, not the one
      // we just left; observe() refines this to the page title once it settles.
      currentScreen = target;
      const nav = await page.goto(start.origin + target, { waitUntil: "domcontentloaded" }).catch((err) => ({ navError: String(err.message || err) }));
      await page.waitForTimeout(SETTLE_MS);
      if (nav && nav.navError) {
        if (entry.prTarget) emit("PR_TARGET", { ...(entry.targetId ? { targetId: entry.targetId } : {}), ...(entry.pathTarget ? {} : { route: target }), status: "failed", error: nav.navError.slice(0, 160) });
        pendingNavigation = null;
        issue(/Timeout/i.test(nav.navError) ? "performance_timeout" : "network_error", "high", `Could not load ${target}: ${nav.navError.slice(0, 80)}`, target);
        progress();
        continue;
      }
      if (nav && typeof nav.status === "function" && nav.status() === 404) {
        issue("broken_link", "medium", `Broken link: ${target} → 404`, target);
      }

      let ob = await observe();
      if (!ob) { progress(); continue; }
      ob = await tryLogin(ob.screen) || ob;

      if (entry.pathTarget) {
        let pathError = "";
        for (const step of entry.pathTarget.navigation.steps) {
          if (actions >= maxActions || Date.now() >= deadline) { pathError = "Target path exceeded the exploration budget"; break; }
          const action = step.action;
          const beforeScreen = ob.screen;
          actions += 1;
          lastActionTarget = action.target;
          emit("ACTION", { type: action.type, target: action.target, screen: beforeScreen, reason: "pr_ui_map_path", narrative: `Following observed UI Map path: ${action.type} ${action.target}` });
          let acted = false;
          if (action.type === "back") {
            await page.goBack({ waitUntil: "domcontentloaded", timeout: step.wait?.timeoutMs || NAV_TIMEOUT_MS }).catch(() => {});
            acted = true;
          } else {
            const selectors = [...(action.selectors || []), { kind: "label", value: action.target }];
            for (const selector of selectors) {
              let locator;
              if (selector.kind === "testId") locator = page.locator(`[data-testid=${JSON.stringify(selector.value)}]`).first();
              else if (selector.kind === "cssId") locator = page.locator(`[id=${JSON.stringify(selector.value)}]`).first();
              else if (selector.kind === "accessibilityId") locator = page.locator(`[aria-label=${JSON.stringify(selector.value)}]`).first();
              else if (selector.kind === "label") locator = page.getByText(selector.value, { exact: true }).first();
              else continue;
              if (await locator.isVisible().catch(() => false)) {
                await locator.click({ timeout: Math.min(step.wait?.timeoutMs || NAV_TIMEOUT_MS, NAV_TIMEOUT_MS) }).catch(() => {});
                acted = true;
                break;
              }
            }
          }
          if (!acted) { pathError = `Observed control was not found: ${action.target}`; break; }
          pendingNavigation = { action: action.target, fromScreen: beforeScreen };
          await page.waitForTimeout(CLICK_SETTLE_MS);
          ob = await observe() || ob;
          progress();
        }
        const expected = String(entry.pathTarget.node.semanticKey || "").toLowerCase();
        const actual = slug(ob.screen);
        if (!pathError && expected && actual !== expected) pathError = `Reached ${ob.screen}, expected ${entry.pathTarget.node.name}`;
        if (pathError) {
          emit("PR_TARGET", { targetId: entry.targetId, status: "failed", screen: ob.screen, error: pathError.slice(0, 160) });
          issue("pr_target_unreachable", "high", pathError, ob.screen);
          progress();
          continue;
        }
        emit("PR_TARGET", { targetId: entry.targetId, status: "observed", screen: ob.screen });
      }

      // Enqueue unvisited same-origin links (BFS keeps exploration order deterministic).
      const links = await page.$$eval("a[href]", (as) => as.map((a) => ({
        href: a.href,
        label: (a.getAttribute("aria-label") || a.textContent || "").trim(),
      }))).catch(() => []);
      for (const link of links) {
        try {
          const u = new URL(link.href);
          if (u.origin !== start.origin || !/^https?:$/.test(u.protocol)) continue;
          const key = u.pathname.replace(/\/+$/, "") + u.search || "/";
          if (!visited.has(key) && !frontier.some((item) => item.target === key)) {
            frontier.push({ target: key, action: webNavigationAction(link.label, key), fromScreen: ob.screen });
          }
        } catch {}
      }

      // Bounded button pass: click, watch for effect, flag dead controls (the web analog
      // of the iOS dead-button detector). Navigations are undone so BFS order holds.
      const buttons = page.locator("button:visible, [role=button]:visible, input[type=submit]:visible");
      const n = Math.min(await buttons.count().catch(() => 0), BUTTONS_PER_PAGE);
      for (let i = 0; i < n && actions < maxActions && Date.now() < deadline; i++) {
        const b = buttons.nth(i);
        const label = ((await b.textContent().catch(() => "")) || (await b.getAttribute("value").catch(() => "")) || "button").trim().slice(0, 40) || "button";
        if (/log ?out|sign ?out|delete|remove/i.test(label)) continue; // don't destroy test state
        const beforeUrl = page.url();
        // Dead-button detection watches four real effect channels — DOM mutations, dialogs,
        // network activity, and navigation — instead of the fragile innerHTML-length proxy
        // (same length ≠ same page; unrelated tickers ≠ this button worked).
        await page
          .evaluate(() => {
            window.__tappMut = 0;
            if (window.__tappMo) window.__tappMo.disconnect();
            window.__tappMo = new MutationObserver((muts) => { window.__tappMut += muts.length; });
            window.__tappMo.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
          })
          .catch(() => {});
        const dialogsBefore = await page.locator("dialog[open], [role=dialog], [aria-modal=true]").count().catch(() => 0);
        const reqBefore = requestCount;
        actions += 1;
        lastActionTarget = label;
        emit("ACTION", { type: "tap", target: label, screen: webActionScreen(ob), narrative: `Tapped "${label}"` });
        await b.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(CLICK_SETTLE_MS);
        if (page.url() !== beforeUrl) {
          await observe();
          await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
          await page.waitForTimeout(SETTLE_MS);
        } else {
          const mutations = await page.evaluate(() => window.__tappMut || 0).catch(() => 0);
          const dialogsAfter = await page.locator("dialog[open], [role=dialog], [aria-modal=true]").count().catch(() => 0);
          const hadEffect = mutations > 0 || dialogsAfter !== dialogsBefore || requestCount > reqBefore;
          if (!hadEffect) {
            issue("unresponsive_element", "medium", `Button "${label}" does nothing`, ob.screen, label);
          } else {
            // Same-URL SPA transitions are real screens too; URL-only observation
            // under-counted coverage and made healthy applications inconclusive.
            ob = await observe() || ob;
          }
        }
        progress();
      }
      progress();
    }
  } finally {
    emit("COMPLETE", { actions, screens: screenCount });
    fs.closeSync(markersFd);
    await browser.close().catch(() => {});
  }
  return { markersPath, outDir, actions, screens: screenCount, seedRoutes: normalizedSeeds, seedTargets: normalizedTargets };
}

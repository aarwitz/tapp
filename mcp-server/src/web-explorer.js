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

const CLICK_SETTLE_MS = 700;
const NAV_TIMEOUT_MS = 15_000;
const BUTTONS_PER_PAGE = 4;
const ERROR_TEXT_RE = /\b(something went wrong|internal server error|an error occurred|failed to load|unhandled exception)\b/i;
const STANDALONE_ERROR_TEXT_RE = /^(something went wrong|internal server error|an error occurred|failed to load|unhandled exception)(?:[.!:]|\s|$)/i;

export function webErrorSurfaceText({ alertText = "", candidateTexts = [] } = {}) {
  const alert = String(alertText || "").trim();
  if (alert && ERROR_TEXT_RE.test(alert)) return alert;
  return (candidateTexts || [])
    .map((text) => String(text || "").trim())
    .find((text) => STANDALONE_ERROR_TEXT_RE.test(text)) || "";
}

export function webControlLabel({ text = "", value = "", ariaLabel = "", title = "", id = "" } = {}) {
  return [text, value, ariaLabel, title, id]
    .map((part) => String(part || "").trim())
    .find(Boolean) || "button";
}

export function webPlaceholderLinkFindings(links = []) {
  const findings = [];
  const seen = new Set();
  for (const link of links || []) {
    const rawHref = String(link?.rawHref || "").trim().toLowerCase();
    const placeholder = rawHref === "" || rawHref === "#" || /^javascript:(?:void\(0\);?|;?)$/.test(rawHref);
    if (!placeholder || link?.handlerHint) continue;
    const label = String(link?.label || "").replace(/\s+/g, " ").trim().slice(0, 100);
    const fingerprint = String(link?.fingerprint || "link").replace(/\s+/g, " ").trim().slice(0, 100) || "link";
    const target = label || `unlabeled:${fingerprint}`;
    if (seen.has(target)) continue;
    seen.add(target);
    findings.push({
      type: "placeholder_link",
      severity: label ? "medium" : "low",
      title: label
        ? `Link "${label}" has no destination (${rawHref === "#" ? 'href="#"' : `href="${rawHref}"`})`
        : `Unlabeled link has no destination (${rawHref === "#" ? 'href="#"' : `href="${rawHref}"`})`,
      target,
    });
  }
  return findings;
}

export function webControlHadEffect({ wired = false, before = {}, after = {} } = {}) {
  if (wired) return true;
  return ["url", "title", "heading", "dialogs", "local"]
    .some((key) => String(before?.[key] ?? "") !== String(after?.[key] ?? ""));
}

export function shouldReportWebRequestFailure(errorText = "") {
  // Chromium emits ERR_ABORTED when Tapp deliberately leaves a page while images/video are
  // still loading. That is navigation lifecycle noise, not evidence that the resource is broken.
  return !/\bnet::ERR_ABORTED\b/i.test(String(errorText));
}

export function webPageAppearsBlank({ textLen = 0, controlCount = 0, visualContentCount = 0 } = {}) {
  return Number(textLen) === 0 && Number(controlCount) === 0 && Number(visualContentCount) === 0;
}

async function installWebListenerTracking(context) {
  await context.addInitScript(() => {
    const key = Symbol.for("tapp.clickListeners");
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function tappTrackedAdd(type, listener, options) {
      if (type === "click" && this instanceof Element && listener) {
        if (!this[key]) Object.defineProperty(this, key, { value: new Set(), configurable: true });
        this[key].add(listener);
      }
      return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function tappTrackedRemove(type, listener, options) {
      if (type === "click" && this instanceof Element && this[key]) this[key].delete(listener);
      return remove.call(this, type, listener, options);
    };
  });
}

async function captureWebControlState(page, locator) {
  const global = await page.evaluate(() => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none" && element.getClientRects().length > 0;
    };
    const dialogs = [...document.querySelectorAll("dialog[open], [role=dialog], [aria-modal=true]")]
      .filter(visible)
      .map((element) => (element.getAttribute("aria-label") || element.textContent || "dialog").replace(/\s+/g, " ").trim().slice(0, 160))
      .sort();
    return {
      title: document.title,
      heading: document.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim() || "",
      dialogs: JSON.stringify(dialogs),
    };
  }).catch(() => ({ title: "", heading: "", dialogs: "" }));

  const local = await locator.evaluate((element) => {
    const key = Symbol.for("tapp.clickListeners");
    const visible = (candidate) => {
      const style = window.getComputedStyle(candidate);
      return style.visibility !== "hidden" && style.display !== "none" && candidate.getClientRects().length > 0;
    };
    let wired = false;
    for (let candidate = element; candidate && candidate !== document.body; candidate = candidate.parentElement) {
      if ((candidate[key] && candidate[key].size > 0) || typeof candidate.onclick === "function" || candidate.hasAttribute("onclick")) {
        wired = true;
        break;
      }
    }
    if (!wired && element.matches("button[type=submit], input[type=submit]") && element.closest("form")) wired = true;
    const describe = (root) => ({
      tag: root.tagName,
      className: typeof root.className === "string" ? root.className : "",
      hidden: root.hidden,
      open: root.hasAttribute("open"),
      ariaExpanded: root.getAttribute("aria-expanded"),
      ariaPressed: root.getAttribute("aria-pressed"),
      ariaSelected: root.getAttribute("aria-selected"),
      text: (root.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
      controls: [...root.querySelectorAll("button, a[href], input, textarea, select, [role=button]")]
        .slice(0, 40)
        .map((control) => ({
          tag: control.tagName,
          visible: visible(control),
          disabled: !!control.disabled || control.getAttribute("aria-disabled") === "true",
          checked: "checked" in control ? !!control.checked : null,
          expanded: control.getAttribute("aria-expanded"),
          pressed: control.getAttribute("aria-pressed"),
          selected: control.getAttribute("aria-selected"),
          label: (control.getAttribute("aria-label") || control.textContent || control.getAttribute("value") || "").replace(/\s+/g, " ").trim().slice(0, 80),
        })),
    });
    const region = element.parentElement || element;
    const controlledId = element.getAttribute("aria-controls");
    const controlled = controlledId ? document.getElementById(controlledId) : null;
    return { wired, signature: JSON.stringify([describe(region), controlled ? describe(controlled) : null]) };
  }).catch(() => ({ wired: false, signature: "detached" }));

  return { url: page.url(), ...global, local: local.signature, wired: local.wired };
}

// Wait for a page to stop presenting an explicit loading state and for its semantic
// surface to remain unchanged across a couple of samples. This is intentionally bounded:
// live counters and animation-heavy pages still return evidence, marked unsettled.
export async function waitForWebStability(page, { timeoutMs = 5_000, intervalMs = 250, stableSamples = 3 } = {}) {
  const boundedTimeout = Math.max(250, Math.min(15_000, Number(timeoutMs) || 5_000));
  const boundedInterval = Math.max(100, Math.min(1_000, Number(intervalMs) || 250));
  const requiredSamples = Math.max(1, Math.min(5, Number(stableSamples) || 2));
  const started = Date.now();
  let previousSignature = "";
  let matchingSamples = 0;
  let latest = { busy: false, signature: "" };

  while (Date.now() - started < boundedTimeout) {
    latest = await page.evaluate(() => {
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        return style.visibility !== "hidden" && style.display !== "none" && element.getClientRects().length > 0;
      };
      const busySelector = "[aria-busy=true], [role=progressbar], .loading, .spinner, [class*=loading i], [class*=spinner i]";
      const busyElement = [...document.querySelectorAll(busySelector)].some(visible);
      const busyText = [...document.querySelectorAll("h1, h2, h3, p, [role=status]")]
        .filter(visible)
        .map((element) => (element.textContent || "").trim())
        .some((text) => /^(loading|fetching|please wait|preparing|connecting)(?:[.…!]*|\s.*)$/i.test(text));
      const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 2_000);
      const signature = JSON.stringify([
        location.href,
        document.querySelector("h1")?.textContent?.trim() || "",
        document.title,
        document.querySelectorAll("button, a[href], input, textarea, select, [role=button]").length,
        bodyText,
      ]);
      return { busy: busyElement || busyText, signature };
    }).catch(() => latest);

    if (!latest.busy && latest.signature === previousSignature) matchingSamples += 1;
    else matchingSamples = !latest.busy ? 1 : 0;
    previousSignature = latest.signature;
    if (!latest.busy && matchingSamples >= requiredSamples) {
      return { settled: true, busy: false, elapsedMs: Date.now() - started };
    }
    await page.waitForTimeout(boundedInterval);
  }
  return { settled: false, busy: !!latest.busy, elapsedMs: Date.now() - started };
}

async function tapWebText(page, text, timeoutMs) {
  const requested = String(text || "").trim();
  if (!requested) return false;
  const candidates = [
    page.getByRole("button", { name: requested, exact: true }).first(),
    page.getByRole("link", { name: requested, exact: true }).first(),
    page.getByText(requested, { exact: true }).first(),
  ];
  for (const candidate of candidates) {
    if (!(await candidate.isVisible().catch(() => false))) continue;
    try {
      await candidate.click({ timeout: Math.min(timeoutMs, 5_000) });
      return true;
    } catch {}
  }
  throw new Error(`Could not tap visible text “${requested}”`);
}

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
export async function inspectWebPage({ url, timeoutMs = NAV_TIMEOUT_MS, screenshot = true, tapText = "", waitForText = "" }) {
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
    let stability = await waitForWebStability(page, { timeoutMs: Math.min(5_000, boundedTimeout) });
    if (tapText) {
      await tapWebText(page, tapText, boundedTimeout);
      stability = await waitForWebStability(page, { timeoutMs: Math.min(5_000, boundedTimeout) });
    }
    if (waitForText) {
      const requested = String(waitForText).trim();
      try {
        await page.getByText(requested, { exact: false }).first().waitFor({ state: "visible", timeout: boundedTimeout });
      } catch {
        throw new Error(`Timed out waiting for visible text “${requested}”`);
      }
      stability = await waitForWebStability(page, { timeoutMs: Math.min(5_000, boundedTimeout) });
    }
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
      settled: stability.settled,
      busy: stability.busy,
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await installWebListenerTracking(context);
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  const deadline = Date.now() + timeoutSec * 1000;
  const issues = []; // emitted immediately; kept for counting only
  const issue = (type, severity, title, screen, target) => {
    issues.push(type);
    emit("ISSUE", { type, severity, title, screen, ...(target ? { target } : {}) });
  };

  // Async defect listeners: attribute to whatever screen is current when they fire.
  let currentScreen = start.pathname;
  let lastActionTarget = "";
  page.on("pageerror", (err) => issue("js_exception", "high", `Uncaught JS exception: ${String(err.message || err).slice(0, 120)}`, currentScreen));
  page.on("response", (res) => {
    try {
      const u = new URL(res.url());
      if (u.origin !== start.origin) return;
      if (res.status() >= 500) issue("network_error", "high", `${res.status()} from ${u.pathname.slice(0, 80)}`, currentScreen);
      else if (res.status() === 404 && res.request().resourceType() !== "document") {
        issue("missing_asset", "medium", `404 asset: ${u.pathname.slice(0, 80)}`, currentScreen, u.pathname);
      }
    } catch {}
  });
  page.on("requestfailed", (req) => {
    try {
      const u = new URL(req.url());
      if (u.origin !== start.origin) return;
      const errorText = req.failure()?.errorText || "?";
      if (!shouldReportWebRequestFailure(errorText)) return;
      issue("network_error", "medium", `Request failed: ${u.pathname.slice(0, 80)} (${errorText})`, currentScreen, u.pathname);
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
  const screenshotFor = new Map();
  const placeholderLinksSeen = new Set();
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
        visualContentCount: [...document.querySelectorAll("img, picture, video, canvas, svg, iframe, object, embed")]
          .filter((el) => {
            const style = window.getComputedStyle(el);
            return style.visibility !== "hidden" && style.display !== "none" && el.getClientRects().length > 0;
          }).length,
        alertText: [...document.querySelectorAll("[role=alert], [aria-live=assertive]")]
          .map((el) => el.textContent.trim()).filter(Boolean).join(" ").slice(0, 120),
        errorCandidateTexts: [...document.querySelectorAll("h1, h2, h3, p, [data-error], [data-testid*=error i]")]
          .filter((el) => el.offsetParent !== null)
          .map((el) => (el.textContent || "").trim().slice(0, 240))
          .filter(Boolean)
          .slice(0, 40),
        busy: [...document.querySelectorAll("[aria-busy=true], [role=progressbar], .loading, .spinner, [class*=loading i], [class*=spinner i]")]
          .some((el) => {
            const style = window.getComputedStyle(el);
            return style.visibility !== "hidden" && style.display !== "none" && el.getClientRects().length > 0;
          }) || [...document.querySelectorAll("h1, h2, h3, p, [role=status]")]
          .filter((el) => el.offsetParent !== null)
          .map((el) => (el.textContent || "").trim())
          .some((text) => /^(loading|fetching|please wait|preparing|connecting)(?:[.…!]*|\s.*)$/i.test(text)),
        placeholderLinks: [...document.querySelectorAll("a[href]")]
          .filter((el) => el.offsetParent !== null)
          .map((el, index) => {
            const listenerKey = Symbol.for("tapp.clickListeners");
            const dataHandler = [...el.attributes]
              .some((attribute) => /^data-(action|toggle|target|modal|waitlist)(?:-|$)/i.test(attribute.name));
            const svgPath = el.querySelector("svg path")?.getAttribute("d") || "";
            return {
              rawHref: el.getAttribute("href") || "",
              label: (el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100),
              handlerHint: el.getAttribute("role") === "button"
                || el.hasAttribute("onclick")
                || typeof el.onclick === "function"
                || !!el[listenerKey]?.size
                || el.hasAttribute("aria-controls")
                || dataHandler,
              fingerprint: el.id || el.getAttribute("data-testid") || svgPath.slice(0, 80) || `link-${index + 1}`,
            };
          }),
        inputs,
        controls,
      };
    }).catch(() => null);
    if (!info) return null;

    const key = screenKey();
    const screen = webScreenTitle(info, key);
    const evidenceKey = `${key}::${screen}`;
    currentScreen = screen;
    emit("STATE", { screen, url: key, elements: info.controlCount, role: webScreenRole(screen, info.inputs), controls: info.controls, inputs: info.inputs, settled: !info.busy });
    const completedNavigation = pendingNavigation;
    const transitionFrom = webTransitionOrigin(completedNavigation, lastScreen);
    const transitionAction = completedNavigation?.action || lastActionTarget;
    if (transitionFrom && transitionFrom !== screen) emit("TRANSITION", { from: transitionFrom, to: screen, ...(transitionAction ? { action: transitionAction } : {}) });
    pendingNavigation = null;
    if (lastScreen !== screen) lastActionTarget = "";
    lastScreen = screen;
    if (completedNavigation?.prTarget) emit("PR_TARGET", { ...(completedNavigation.targetId ? { targetId: completedNavigation.targetId } : {}), route: completedNavigation.target, status: "observed", screen });

    const busyRouteEntry = !info.busy
      ? [...screenshotFor.entries()].find(([, value]) => value.route === key && value.busy)
      : null;
    const existingKey = screenshotFor.has(evidenceKey) ? evidenceKey : busyRouteEntry?.[0];
    const existingScreenshot = existingKey ? screenshotFor.get(existingKey) : null;
    const shouldCapture = !existingScreenshot || (existingScreenshot.busy && !info.busy);
    if (shouldCapture) {
      const screenshotPath = existingScreenshot?.path || path.join(outDir, `state_${screenshotFor.size + 1}_${slug(screen)}.png`);
      if (existingKey && existingKey !== evidenceKey) screenshotFor.delete(existingKey);
      screenshotFor.set(evidenceKey, { path: screenshotPath, busy: info.busy, route: key });
      screenCount = screenshotFor.size;
      await page.screenshot({ path: screenshotPath }).catch(() => {});
      // Deterministic per-page detectors run once per distinct screen.
      if (webPageAppearsBlank(info)) issue("blank_screen", "high", "Page rendered no visible content", screen);
      else {
        const errorText = webErrorSurfaceText({ alertText: info.alertText, candidateTexts: info.errorCandidateTexts });
        if (errorText) issue("error_surface", "high", `Error shown: ${errorText.slice(0, 80)}`, screen);
      }
      for (const finding of webPlaceholderLinkFindings(info.placeholderLinks)) {
        if (placeholderLinksSeen.has(finding.target)) continue;
        placeholderLinksSeen.add(finding.target);
        issue(finding.type, finding.severity, finding.title, screen, finding.target);
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
    await waitForWebStability(page, { timeoutMs: Math.min(5_000, CLICK_SETTLE_MS * 6) });
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
      if (nav && nav.navError) {
        if (entry.prTarget) emit("PR_TARGET", { ...(entry.targetId ? { targetId: entry.targetId } : {}), ...(entry.pathTarget ? {} : { route: target }), status: "failed", error: nav.navError.slice(0, 160) });
        pendingNavigation = null;
        issue(/Timeout/i.test(nav.navError) ? "performance_timeout" : "network_error", "high", `Could not load ${target}: ${nav.navError.slice(0, 80)}`, target);
        progress();
        continue;
      }
      await waitForWebStability(page);
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
                try {
                  await locator.click({ timeout: Math.min(step.wait?.timeoutMs || NAV_TIMEOUT_MS, NAV_TIMEOUT_MS) });
                  acted = true;
                  break;
                } catch {}
              }
            }
          }
          if (!acted) { pathError = `Observed control was not found: ${action.target}`; break; }
          pendingNavigation = { action: action.target, fromScreen: beforeScreen };
          await waitForWebStability(page);
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
        const label = webControlLabel({
          text: await b.textContent().catch(() => ""),
          value: await b.getAttribute("value").catch(() => ""),
          ariaLabel: await b.getAttribute("aria-label").catch(() => ""),
          title: await b.getAttribute("title").catch(() => ""),
          id: await b.getAttribute("id").catch(() => ""),
        }).slice(0, 40);
        if (/log ?out|sign ?out|delete|remove/i.test(label)) continue; // don't destroy test state
        // Capture only durable, user-visible semantics around this control. A global
        // MutationObserver is intentionally avoided: carousels, chat launchers, and live
        // counters can mutate while an unrelated dead button is clicked, creating verdict jitter.
        const beforeState = await captureWebControlState(page, b);
        actions += 1;
        lastActionTarget = label;
        emit("ACTION", { type: "tap", target: label, screen: webActionScreen(ob), narrative: `Tapped "${label}"` });
        let clickSucceeded = false;
        try {
          await b.click({ timeout: 3000 });
          clickSucceeded = true;
        } catch {}
        if (!clickSucceeded) {
          progress();
          continue;
        }
        await waitForWebStability(page);
        if (page.url() !== beforeState.url) {
          await observe();
          await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
          await waitForWebStability(page);
        } else {
          const afterState = await captureWebControlState(page, b);
          const hadEffect = webControlHadEffect({ wired: beforeState.wired, before: beforeState, after: afterState });
          if (!hadEffect) {
            issue("unresponsive_element", "medium", `Button "${label}" has no wiring or observable effect`, ob.screen, label);
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

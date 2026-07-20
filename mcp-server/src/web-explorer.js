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
// Playwright is deliberately NOT a dependency of tapp-mcp (it would bloat every npx
// install with a browser download). It's resolved dynamically; exploreWeb() throws a
// clear install hint when it's missing.

import fs from "fs";
import path from "path";

const SETTLE_MS = 500;
const CLICK_SETTLE_MS = 700;
const NAV_TIMEOUT_MS = 15_000;
const BUTTONS_PER_PAGE = 4;
const ERROR_TEXT_RE = /\b(something went wrong|internal server error|an error occurred|failed to load|unhandled exception)\b/i;

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error(
      "Web exploration needs Playwright (not bundled, to keep tapp-mcp installs small). " +
        "One-time setup: `npm i -g playwright && npx playwright install chromium` " +
        "(or `npm i playwright` next to tapp-mcp)."
    );
  }
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";
}

export async function exploreWeb({ url, maxActions = 40, timeoutSec = 300, outDir, testEmail = "", testPassword = "", onProgress }) {
  const start = new URL(url);
  if (!/^https?:$/.test(start.protocol)) throw new Error("url must be http(s)");
  fs.mkdirSync(outDir, { recursive: true });
  const markersPath = path.join(outDir, "ocqa-markers.txt");
  const markersFd = fs.openSync(markersPath, "w");
  const emit = (kind, payload) => fs.writeSync(markersFd, `OCQA_${kind}:${JSON.stringify(payload)}\n`);

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  const deadline = Date.now() + timeoutSec * 1000;
  const issues = []; // emitted immediately; kept only for the auth check
  const issue = (type, severity, title, screen) => {
    issues.push(type);
    emit("ISSUE", { type, severity, title, screen });
  };

  // Async defect listeners: attribute to whatever screen is current when they fire.
  let currentScreen = start.pathname;
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
  const frontier = [start.pathname + start.search];
  const screenshotFor = new Set();
  let actions = 0;
  let screenCount = 0;
  let lastScreen = null;
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
      return {
        title: document.title.trim(),
        controls: document.querySelectorAll("a[href], button, [role=button], input, select, textarea").length,
        textLen: (document.body?.innerText || "").trim().length,
        alertText: [...document.querySelectorAll("[role=alert], [class*=error i]")]
          .map((el) => el.textContent.trim()).filter(Boolean).join(" ").slice(0, 120),
        inputs,
      };
    }).catch(() => null);
    if (!info) return null;

    const key = screenKey();
    const screen = info.title || key;
    currentScreen = screen;
    emit("STATE", { screen, url: key, controls: info.controls, inputs: info.inputs, settled: true });
    if (lastScreen && lastScreen !== screen) emit("TRANSITION", { from: lastScreen, to: screen });
    lastScreen = screen;

    if (!screenshotFor.has(key)) {
      screenshotFor.add(key);
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
    if (loginTried || !testPassword) return;
    const pw = page.locator("input[type=password]").first();
    if (!(await pw.isVisible().catch(() => false))) return;
    loginTried = true;
    const emailSel = "input[type=email], input[name*=mail i], input[name*=user i], input[id*=mail i], input[id*=user i]";
    if (testEmail) await page.locator(emailSel).first().fill(testEmail).catch(() => {});
    await pw.fill(testPassword).catch(() => {});
    emit("ACTION", { type: "type", target: "login form", screen, narrative: "Filled the sign-in form with the provided test credentials" });
    actions += 1;
    const before = issues.length;
    await page.locator("button[type=submit], input[type=submit], form button").first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(CLICK_SETTLE_MS * 2);
    const stillLogin = await page.locator("input[type=password]").first().isVisible().catch(() => false);
    if (stillLogin && issues.length > before) issue("auth_failed", "high", "Sign-in attempt did not leave the login form", currentScreen);
  }

  const progress = () => {
    emit("PROGRESS", { action: actions, max: maxActions, states: screenCount });
    if (onProgress) try { onProgress({ action: actions, max: maxActions, states: screenCount }); } catch {}
  };

  try {
    while (frontier.length && actions < maxActions && Date.now() < deadline) {
      const target = frontier.shift();
      if (visited.has(target)) continue;
      visited.add(target);

      actions += 1;
      emit("ACTION", { type: "open", target, narrative: `Opened ${target}` });
      // Attribute load-time events (pageerror, 404s) to the page being loaded, not the one
      // we just left; observe() refines this to the page title once it settles.
      currentScreen = target;
      const nav = await page.goto(start.origin + target, { waitUntil: "domcontentloaded" }).catch((err) => ({ navError: String(err.message || err) }));
      await page.waitForTimeout(SETTLE_MS);
      if (nav && nav.navError) {
        issue(/Timeout/i.test(nav.navError) ? "performance_timeout" : "network_error", "high", `Could not load ${target}: ${nav.navError.slice(0, 80)}`, target);
        progress();
        continue;
      }
      if (nav && typeof nav.status === "function" && nav.status() === 404) {
        issue("broken_link", "medium", `Broken link: ${target} → 404`, target);
      }

      const ob = await observe();
      if (!ob) { progress(); continue; }
      await tryLogin(ob.screen);

      // Enqueue unvisited same-origin links (BFS keeps exploration order deterministic).
      const links = await page.$$eval("a[href]", (as) => as.map((a) => a.href)).catch(() => []);
      for (const href of links) {
        try {
          const u = new URL(href);
          if (u.origin !== start.origin || !/^https?:$/.test(u.protocol)) continue;
          const key = u.pathname.replace(/\/+$/, "") + u.search || "/";
          if (!visited.has(key) && !frontier.includes(key)) frontier.push(key);
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
        const beforeDom = await page.evaluate(() => document.body.innerHTML.length).catch(() => 0);
        actions += 1;
        emit("ACTION", { type: "tap", target: label, screen: ob.screen, narrative: `Tapped "${label}"` });
        await b.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(CLICK_SETTLE_MS);
        const afterDom = await page.evaluate(() => document.body.innerHTML.length).catch(() => 0);
        if (page.url() !== beforeUrl) {
          await observe();
          await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
          await page.waitForTimeout(SETTLE_MS);
        } else if (afterDom === beforeDom) {
          issue("unresponsive_element", "medium", `Button "${label}" does nothing`, ob.screen);
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
  return { markersPath, outDir, actions, screens: screenCount };
}

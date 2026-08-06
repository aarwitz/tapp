// Deterministic committed Flow replay for browser apps. Playwright is only the
// driver; Tapp owns the shared Flow semantics and OCQA evidence protocol.
import fs from "node:fs";
import path from "node:path";
import { FlowLog, flowVariables, normalizeFlowStep, substituteFlowValue } from "./flow-runtime.js";
import { loadPlaywright } from "./web-explorer.js";

const DEFAULT_TIMEOUT = 6000;

async function firstVisible(candidates) {
  for (const locator of candidates) {
    try {
      const first = locator.first();
      if ((await first.count()) > 0 && (await first.isVisible())) return first;
    } catch { /* try the next semantic locator */ }
  }
  return null;
}

function cssId(value) {
  return "#" + String(value).replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

export async function locateWebElement(page, target) {
  const exact = { exact: true };
  const candidates = [
    page.getByTestId(target),
    page.locator(cssId(target)),
    page.getByLabel(target, exact),
    page.getByRole("button", { name: target, exact: true }),
    page.getByRole("link", { name: target, exact: true }),
    page.getByText(target, exact),
    page.getByLabel(target),
    page.getByText(target),
  ];
  return firstVisible(candidates);
}

async function screenCandidates(page) {
  const values = [];
  try { values.push(await page.title()); } catch {}
  try {
    const h1 = page.getByRole("heading", { level: 1 }).first();
    if ((await h1.count()) > 0 && (await h1.isVisible())) values.push(await h1.innerText());
  } catch {}
  try {
    const url = new URL(page.url());
    values.push(url.pathname, url.pathname.split("/").filter(Boolean).at(-1) || "Home");
  } catch {}
  return values.map((v) => String(v || "").trim()).filter(Boolean);
}

async function waitForScreen(page, target, timeout) {
  const deadline = Date.now() + timeout;
  const wanted = target.toLowerCase();
  while (Date.now() < deadline) {
    if ((await screenCandidates(page)).some((v) => v.toLowerCase() === wanted)) return true;
    const el = await locateWebElement(page, target);
    if (el) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

async function waitForExactScreen(page, target, timeout) {
  const deadline = Date.now() + timeout;
  const wanted = target.toLowerCase();
  while (Date.now() < deadline) {
    if ((await screenCandidates(page)).some((v) => v.toLowerCase() === wanted)) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

async function waitForElement(page, target, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const element = await locateWebElement(page, target);
    if (element) return element;
    await page.waitForTimeout(150);
  }
  return null;
}

async function settle(page) {
  try { await page.waitForLoadState("domcontentloaded", { timeout: 3000 }); } catch {}
  await page.waitForTimeout(150);
}

function substituteStructure(value, vars) {
  if (typeof value === "string") return substituteFlowValue(value, vars);
  if (Array.isArray(value)) return value.map((item) => substituteStructure(item, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteStructure(item, vars)]));
  }
  return value;
}

export async function runWebRequestStep({ step, startUrl, vars = {}, timeout = DEFAULT_TIMEOUT }) {
  const request = step?.request;
  if (!request || typeof request !== "object") throw new Error("request lifecycle step is invalid");
  const targetUrl = new URL(substituteFlowValue(request.path, vars), startUrl);
  const origin = new URL(startUrl).origin;
  if (targetUrl.origin !== origin) throw new Error(`request must stay on the target origin (${origin})`);
  const method = String(request.method || "POST").toUpperCase();
  const headers = substituteStructure(request.headers || {}, vars);
  const init = { method, headers, signal: AbortSignal.timeout(Number(request.timeoutMs) || timeout) };
  if (request.body !== undefined) {
    init.body = JSON.stringify(substituteStructure(request.body, vars));
    if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  }
  const response = await fetch(targetUrl, init);
  const expected = Number(request.status ?? 200);
  if (response.status !== expected) throw new Error(`${method} ${targetUrl.pathname} returned ${response.status}; expected ${expected}`);
  return { action: "request", target: `${method} ${targetUrl.pathname}`, status: "pass", detail: "" };
}

export async function executeWebFlowStep({ page, step, vars = {}, defaultTimeout = DEFAULT_TIMEOUT }) {
  const raw = normalizeFlowStep(step);
  const action = raw.action;
  const target = substituteFlowValue(raw.target, vars);
  const value = substituteFlowValue(raw.value, vars);
  const timeout = Number(raw.params.timeoutMs) || defaultTimeout;
  let status = "pass";
  let detail = "";
  try {
    if (action === "tap") {
      const el = await locateWebElement(page, target);
      if (!el) throw new Error(`could not find ‘${target}’`);
      await el.click();
    } else if (action === "type") {
      const el = await locateWebElement(page, target);
      if (!el) throw new Error(`no field ‘${target}’ to type into`);
      await el.fill(value);
    } else if (action === "swipe") {
      const dy = target.toLowerCase() === "down" ? -600 : 600;
      await page.evaluate((y) => window.scrollBy({ top: y, behavior: "instant" }), dy);
    } else if (action === "back") {
      await page.goBack({ waitUntil: "domcontentloaded" });
    } else if (action === "wait_for") {
      if (!await waitForScreen(page, target, timeout)) throw new Error(`‘${target}’ never appeared within ${timeout}ms`);
    } else if (action === "wait") {
      await page.waitForTimeout(timeout);
    } else if (action === "assert_screen") {
      const wanted = value || target;
      if (!await waitForExactScreen(page, wanted, timeout)) {
        const candidates = await screenCandidates(page);
        throw new Error(`expected screen ‘${wanted}’, saw ‘${candidates[0] || page.url()}’`);
      }
    } else if (action === "assert_exists") {
      if (!await waitForElement(page, target, timeout)) throw new Error(`‘${target}’ not found`);
    } else if (action === "assert_absent") {
      if (await locateWebElement(page, target)) throw new Error(`‘${target}’ was present but should be absent`);
    } else if (action === "assert_text") {
      const of = substituteFlowValue(raw.params.of || target, vars);
      const needle = substituteFlowValue(raw.params.contains || value, vars);
      const deadline = Date.now() + timeout;
      let matched = false;
      while (Date.now() < deadline && !matched) {
        const el = await locateWebElement(page, of);
        matched = !!el && (await el.innerText()).toLowerCase().includes(needle.toLowerCase());
        if (!matched) await page.waitForTimeout(150);
      }
      if (!matched) throw new Error(`‘${of}’ did not contain ‘${needle}’`);
    } else if (action === "assert_ai") {
      status = "skip";
      detail = "AI assertions are advisory and are not part of deterministic browser replay";
    } else {
      throw new Error(`unknown action ‘${action}’`);
    }
    await settle(page);
  } catch (error) {
    status = "fail";
    detail = error.message || String(error);
  }
  return { action, target: target || value, status, detail, task: raw.task };
}

export async function runWebFlow({ flow, url, logPath, screenshotDir, playwright }) {
  const startUrl = url || flow.url || (/^https?:\/\//i.test(flow.app || "") ? flow.app : "");
  if (!startUrl) throw new Error("Web Flow needs `url:` (or an http(s) `app:` value)");
  if (logPath) fs.rmSync(logPath, { force: true });
  const setup = flow.setup || [];
  const teardown = flow.teardown || [];
  const loggedFlow = { ...flow, steps: [...setup, ...flow.steps, ...teardown] };
  const log = new FlowLog({ logPath, flow: loggedFlow });
  const pw = playwright || await loadPlaywright();
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const timeout = Number(flow.timeoutMs) || DEFAULT_TIMEOUT;
  page.setDefaultTimeout(timeout);
  const vars = flowVariables(flow);
  let index = 0;
  let failed = false;

  const emit = (outcome) => {
    index += 1;
    log.step({ index, ...outcome });
    if (outcome.status === "fail") failed = true;
  };

  const requestPhase = async (steps) => {
    for (const step of steps) {
      try {
        emit(await runWebRequestStep({ step, startUrl, vars, timeout }));
      } catch (error) {
        emit({ action: "request", target: String(step?.request?.path || "request"), status: "fail", detail: error.message || String(error) });
        break;
      }
    }
  };

  try {
    await requestPhase(setup);
    if (!failed) {
      await page.goto(startUrl, { waitUntil: "domcontentloaded" });
      await settle(page);
      for (const step of flow.steps) {
        const outcome = await executeWebFlowStep({ page, step, vars, defaultTimeout: timeout });
        emit(outcome);
        if (outcome.status === "fail" && screenshotDir) {
          fs.mkdirSync(screenshotDir, { recursive: true });
          await page.screenshot({ path: path.join(screenshotDir, `flow-failure-${index}.png`), fullPage: true }).catch(() => {});
        }
        if (outcome.status === "fail" && !flow.continueOnFailure) break;
      }
    }
    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
      await page.screenshot({ path: path.join(screenshotDir, "flow-final.png"), fullPage: true }).catch(() => {});
    }
  } finally {
    await requestPhase(teardown);
    await browser.close().catch(() => {});
  }
  return log.finish();
}

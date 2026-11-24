// Deterministic committed Flow replay for browser apps. Playwright is only the
// driver; Tapp owns the shared Flow semantics and OCQA evidence protocol.
import fs from "node:fs";
import path from "node:path";
import { FlowLog, flowVariables, normalizeFlowStep, substituteFlowValue, isOptionalStep } from "./flow-runtime.js";
import { loadPlaywright, webContextOptions } from "./web-explorer.js";
import { findSignInSubmit } from "./sign-in.js";

const DEFAULT_TIMEOUT = 6000;

// What WAS visible when a wait missed — points a failure report at the fix (renamed label,
// error state, wrong page) without a separate `tapp tree` run (field issue #20).
async function visibleLabelsHint(page, limit = 8) {
  const collect = async (scope) => {
    try { return String(await scope.locator("body").innerText({ timeout: 1000 })); } catch { return ""; }
  };
  try {
    // Include same-origin frames: the text a reader can see may live inside an embedded modal.
    const texts = [await collect(page), ...(await Promise.all(sameOriginFrames(page).map(collect)))];
    const labels = [...new Set(texts.join("\n").split(/\n+/).map((l) => l.trim()).filter((l) => l.length >= 2 && l.length <= 60))].slice(0, limit);
    return labels.length ? ` — visible: ${labels.join(" · ")}` : "";
  } catch { return ""; }
}

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

// A frame whose content the page's own origin may script. An `about:blank`/`srcdoc` frame
// inherits its parent's origin. Cross-origin frames (third-party widgets) stay out of scope:
// a Flow should not assert on content the page itself cannot read.
function sameOriginFrames(page) {
  if (typeof page.frames !== "function") return []; // non-Playwright page (tests, fakes)
  let origin;
  try { origin = new URL(page.url()).origin; } catch { return []; }
  const main = typeof page.mainFrame === "function" ? page.mainFrame() : null;
  return page.frames().filter((frame) => {
    if (frame === main) return false;
    const url = frame.url() || "";
    if (!url || url === "about:blank" || url.startsWith("about:srcdoc")) return true;
    try { return new URL(url).origin === origin; } catch { return false; }
  });
}

function targetCandidates(scope, target) {
  const exact = { exact: true };
  return [
    scope.getByTestId(target),
    scope.locator(cssId(target)),
    scope.getByLabel(target, exact),
    scope.getByRole("button", { name: target, exact: true }),
    scope.getByRole("link", { name: target, exact: true }),
    scope.getByText(target, exact),
    scope.getByLabel(target),
    scope.getByText(target),
  ];
}

// TM-1077: a file input for `upload:`. Visibility-agnostic on purpose — a file
// picker is routinely a real <input type=file> hidden behind a styled label or
// button (opacity/position, never display:none, which browsers refuse to let
// choose a file at all), and Playwright's setInputFiles works on it either way.
// locateWebElement's firstVisible() would skip it, so this never calls it.
async function locateFileInput(page, target) {
  const candidates = [
    page.getByTestId(target),
    page.locator(cssId(target)),
    page.getByLabel(target, { exact: true }),
    page.getByLabel(target),
  ];
  for (const locator of candidates) {
    try {
      const first = locator.first();
      if ((await first.count()) === 0) continue;
      const tag = await first.evaluate((el) => el.tagName).catch(() => "");
      if (tag === "INPUT") {
        const type = (await first.getAttribute("type").catch(() => "")) || "";
        if (!type || type.toLowerCase() === "file") return first;
        continue;
      }
      // A styled label/button that wraps the real input rather than being it.
      const inner = first.locator("input[type=file]").first();
      if ((await inner.count()) > 0) return inner;
    } catch { /* try the next candidate */ }
  }
  // Last resort: the page's one file input, when the target names it (id, name,
  // aria-label, nearby text) in a way none of the semantic locators matched.
  const only = page.locator("input[type=file]");
  if ((await only.count().catch(() => 0)) === 1) return only.first();
  return null;
}

export async function locateWebElement(page, target) {
  const top = await firstVisible(targetCandidates(page, target));
  if (top) return top;
  // A modal rendered into a same-origin <iframe> is visibly on screen but invisible to a
  // top-document-only search, so `wait_for` timed out on text the screenshot plainly showed
  // (field issue #14). Top document first, then each same-origin frame in document order.
  for (const frame of sameOriginFrames(page)) {
    try {
      const inFrame = await firstVisible(targetCandidates(frame, target));
      if (inFrame) return inFrame;
    } catch { /* a frame can detach mid-search — keep looking */ }
  }
  return null;
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
  return values.map(normalizeScreenName).filter(Boolean);
}

// Compare screen names with their whitespace collapsed on both sides: a journey kept before
// tapp normalized headings holds "Find the right coach.\n        Any goal." where the browser
// now reports "Find the right coach. Any goal." Those are the same screen.
export function normalizeScreenName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function waitForScreen(page, target, timeout) {
  const deadline = Date.now() + timeout;
  const wanted = normalizeScreenName(target).toLowerCase();
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
  const wanted = normalizeScreenName(target).toLowerCase();
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
  if (process.env.TAPP_ENFORCE_PUBLIC_EGRESS === "1") {
    const { publicRequest } = await import("./public-network.js");
    const response = await publicRequest(targetUrl, {method,headers,body:init.body,timeout:Number(request.timeoutMs) || timeout});
    if (response.status !== Number(request.status ?? 200)) throw new Error(`${method} ${targetUrl.pathname} did not return the expected status`);
    return { action:"request",target:`${method} ${targetUrl.pathname}`,status:"pass",detail:"" };
  }
  const response = await fetch(targetUrl, init);
  const expected = Number(request.status ?? 200);
  if (response.status !== expected) throw new Error(`${method} ${targetUrl.pathname} returned ${response.status}; expected ${expected}`);
  return { action: "request", target: `${method} ${targetUrl.pathname}`, status: "pass", detail: "" };
}

// Playwright (and its install prompt) wrap guidance in box-drawing art spanning many lines.
// Consumers that keep ONE line of an error — a scoreboard row, a CI table — kept the box's
// bottom border `╚═══╝` and threw the cause away (field issue #23). Put the cause first and
// carry any actionable instruction with it, so the first AND last line are both useful.
export function distillErrorMessage(message) {
  const lines = String(message || "").split("\n")
    .map((line) => line.replace(/[╔╗╚╝═║│┌┐└┘─]/g, " ").trim())
    .filter(Boolean);
  if (!lines.length) return String(message || "").trim();
  const headline = lines[0];
  // A boxed Playwright prompt carries the fix as a bare command line inside the art.
  const fix = lines.slice(1).find((line) => /^(npx|npm|pip3?|python3|yarn|pnpm) /.test(line));
  return fix && !headline.includes(fix) ? `${headline} — fix: ${fix}` : headline;
}

// Playwright's timeout errors bury the actual cause ("<div id=…> intercepts pointer events",
// "element is not visible") in a multi-line retry log; single-line consumers kept only
// "Timeout 6000ms exceeded" and the report read like the element did not exist (field issue
// #17). Keep the first line AND name the diagnosable cause on it.
export function distillPlaywrightFailure(message) {
  const text = String(message || "");
  const firstLine = text.split("\n", 1)[0].trim();
  const cause = text.match(/(<[^>\n]{1,120}>[^\n]{0,80}intercepts pointer events)/)
    || text.match(/element is (?:not visible|outside of the viewport|not enabled|not stable)[^\n]*/)
    || text.match(/waiting for element to be visible, enabled and stable[^\n]*/);
  if (!cause || firstLine.includes(cause[0])) return firstLine;
  const reason = cause[0].includes("intercepts pointer events") ? `click intercepted by ${cause[0].replace(/\s*intercepts pointer events.*/, "").trim()}` : cause[0].trim();
  return `${firstLine} — ${reason}`;
}

export async function executeWebFlowStep({ page, step, vars = {}, defaultTimeout = DEFAULT_TIMEOUT, stepScreenshotDir = "", flowDir = "" }) {
  const raw = normalizeFlowStep(step);
  const action = raw.action;
  const target = substituteFlowValue(raw.target, vars);
  const value = substituteFlowValue(raw.value, vars);
  const timeout = Number(raw.params.timeoutMs ?? raw.params.timeout) || defaultTimeout;
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
    } else if (action === "login") {
      const emailValue = substituteFlowValue(raw.params.email || "$TEST_EMAIL", vars);
      const passwordValue = substituteFlowValue(raw.params.password || "$TEST_PASSWORD", vars);
      const email = await firstVisible([
        page.locator("input[type=email]"), page.locator("input[name*=mail i]"),
        page.locator("input[name*=user i]"), page.getByLabel(/email|user/i),
      ]);
      const password = await firstVisible([page.locator("input[type=password]"), page.getByLabel(/password|passcode/i)]);
      if (!email || !password) throw new Error("could not identify email and password fields");
      await email.fill(emailValue);
      await password.fill(passwordValue);
      const submit = await findSignInSubmit(page);
      if (!submit) throw new Error("could not identify a sign-in control");
      await submit.locator.click();
      await page.waitForTimeout(400);
      if (await password.isVisible().catch(() => false)) throw new Error("submit left the app on the login screen");
    } else if (action === "press") {
      // TM-593: a journey could not press a key, so anything a keyboard drives — a slider, a
      // shortcut, a combobox — was unreachable. `press: ArrowRight` or
      // `press: { key: ArrowRight, on: <target>, times: 5 }`.
      const key = String(raw.params.key ?? value ?? target ?? "").trim();
      if (!key) throw new Error("press needs a key, e.g. `press: ArrowRight`");
      // `on:` is unusable as a key here: YAML 1.1 reads a bare `on` as the boolean true, so
      // `on: price-max` arrives as {"true": "price-max"} and the target silently vanishes. Say so
      // rather than pressing into the void and passing, which is what this step did first.
      if (raw.params.true !== undefined) {
        throw new Error("press takes `target:`, not `on:` — YAML reads a bare `on` as true, so the target is lost");
      }
      // Only the object form can name a control to focus. In the string form — `press: ArrowRight`,
      // which is the form the story and the reporter both asked for — normalizeFlowStep puts the
      // key in `target` as well, so reading a focus target from there looked for a control called
      // "ArrowRight" and the step failed (Linux's check of 6d8d531). A bare key presses wherever
      // the focus already is, which is what a shortcut means.
      const onTarget = "key" in raw.params
        ? substituteFlowValue(String(raw.target || raw.params.onTarget || ""), vars)
        : "";
      const times = Math.max(1, Math.min(50, Number(raw.params.times) || 1));
      const el = onTarget ? await locateWebElement(page, onTarget) : null;
      if (onTarget && !el) throw new Error(`could not find ‘${onTarget}’ to press ${key} on`);
      if (el) await el.focus();
      for (let i = 0; i < times; i += 1) {
        if (el) await el.press(key);
        else await page.keyboard.press(key);
      }
    } else if (action === "drag") {
      // TM-593: `type` on a range input calls fill(), which sets the value without the handle
      // ever moving, so nothing the page listens for fires and the step proves nothing. A drag
      // moves it the way a person does. `drag: { from: <target>, by: [dx, dy] }` or `{ from, to }`.
      const from = substituteFlowValue(String(raw.params.from ?? target ?? ""), vars);
      if (!from) throw new Error("drag needs `from`, e.g. `drag: { from: price-min, by: [60, 0] }`");
      const handle = await locateWebElement(page, from);
      if (!handle) throw new Error(`could not find ‘${from}’ to drag`);
      // Playwright's own click() scrolls a control into view first; raw mouse moves do not, so a
      // handle below the fold would be "dragged" at coordinates pointing somewhere else entirely —
      // passing, and moving nothing.
      await handle.scrollIntoViewIfNeeded().catch(() => {});
      const start = await handle.boundingBox();
      if (!start) throw new Error(`‘${from}’ is not on screen, so it cannot be dragged`);
      const startX = start.x + start.width / 2;
      const startY = start.y + start.height / 2;
      let endX;
      let endY;
      const to = substituteFlowValue(String(raw.params.to ?? ""), vars);
      if (to) {
        const dest = await locateWebElement(page, to);
        if (dest) await dest.scrollIntoViewIfNeeded().catch(() => {});
        const box = dest && await dest.boundingBox();
        if (!box) throw new Error(`could not find ‘${to}’ to drag onto`);
        endX = box.x + box.width / 2;
        endY = box.y + box.height / 2;
      } else {
        const by = Array.isArray(raw.params.by) ? raw.params.by : [Number(raw.params.by) || 0, 0];
        endX = startX + (Number(by[0]) || 0);
        endY = startY + (Number(by[1]) || 0);
      }
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      // In steps, because a single jump is not a drag to a listener watching movement.
      const steps = 12;
      for (let i = 1; i <= steps; i += 1) {
        await page.mouse.move(startX + ((endX - startX) * i) / steps, startY + ((endY - startY) * i) / steps);
      }
      await page.mouse.up();
    } else if (action === "swipe") {
      // TM-593: this only ever scrolled the window, so content inside a drawer or modal could not
      // be brought into view and the step passed having moved nothing. With a target it scrolls
      // that container, and either way it fails when nothing actually moved.
      const dy = target.toLowerCase() === "down" ? -600 : 600;
      const within = substituteFlowValue(String(raw.params.within ?? raw.params.in ?? ""), vars);
      if (within) {
        const box = await locateWebElement(page, within);
        if (!box) throw new Error(`could not find ‘${within}’ to scroll`);
        const moved = await box.evaluate((node, y) => {
          const before = node.scrollTop;
          node.scrollBy({ top: y, behavior: "instant" });
          return { before, after: node.scrollTop, canScroll: node.scrollHeight > node.clientHeight };
        }, dy);
        if (!moved.canScroll) throw new Error(`‘${within}’ has nothing to scroll`);
        if (moved.before === moved.after) {
          throw new Error(`‘${within}’ did not move: it is already at the ${dy > 0 ? "bottom" : "top"}`);
        }
      } else {
        const moved = await page.evaluate((y) => {
          const before = window.scrollY;
          window.scrollBy({ top: y, behavior: "instant" });
          return { before, after: window.scrollY };
        }, dy);
        if (moved.before === moved.after) {
          throw new Error(`the page did not scroll: it is already at the ${dy > 0 ? "bottom" : "top"}`);
        }
      }
    } else if (action === "screenshot") {
      // TM-593: evidence was one full-page shot at the end, in which a fixed overlay cannot be
      // located at all — the reporter could not find an open drawer in a 1170x18972 capture. A
      // named shot at the moment that matters, viewport-sized, so it shows what a person sees.
      const name = String(raw.params.name ?? target ?? value ?? "").trim() || "step";
      const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60);
      if (stepScreenshotDir) {
        fs.mkdirSync(stepScreenshotDir, { recursive: true });
        await page.screenshot({ path: path.join(stepScreenshotDir, `flow-${safe}.png`) });
        detail = `saved flow-${safe}.png`;
      } else {
        // The step's promise is a picture. Passing green with nothing written is the same empty
        // success this story exists to remove, so say which it was (Linux's check of 6d8d531).
        status = "skip";
        detail = "not saved: this run has no evidence folder";
      }
    } else if (action === "back") {
      await page.goBack({ waitUntil: "domcontentloaded" });
    } else if (action === "open_url") {
      // A journey starting from an email link ("tap the sign-in link in your receipt") is just a
      // navigation on web — the one-time part of the link substitutes like any other target.
      await page.goto(target, { waitUntil: "domcontentloaded" });
    } else if (action === "upload") {
      // TM-1077: an admin "Import contacts" page (and certificate/newsletter uploads) starts
      // with choosing a local file — the only way to replay that journey as a committed Flow
      // from the start. The path is relative to the Flow file, not wherever `tapp run` happened
      // to be invoked from, so a Flow stays correct wherever it's checked out.
      const filePath = substituteFlowValue(String(raw.params.file ?? ""), vars);
      if (!filePath) throw new Error("upload needs {field, file}");
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(flowDir || process.cwd(), filePath);
      if (!fs.existsSync(resolved)) throw new Error(`upload file not found: ${resolved}`);
      const input = await locateFileInput(page, target);
      if (!input) throw new Error(`could not find a file picker for ‘${target}’`);
      await input.setInputFiles(resolved);
    } else if (action === "wait_for") {
      if (!await waitForScreen(page, target, timeout)) throw new Error(`‘${target}’ never appeared within ${timeout}ms${await visibleLabelsHint(page)}`);
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
    // A step the author marked optional reports what it did not find, and the run carries on.
    if (isOptionalStep(raw)) {
      status = "skip";
      detail = `optional — ${distillPlaywrightFailure(error.message || String(error))}`;
    } else {
      status = "fail";
      detail = distillPlaywrightFailure(error.message || String(error));
    }
  }
  return { action, target: action === "login" ? "sign-in form" : target || value, status, detail, task: raw.task };
}

// The gate targets ONE deployment; a Flow's `url:` names a PAGE of the app, not a deployment.
// Under a gate url, keep the Flow's path/query/hash but rebase a differing origin onto the
// gate's: committed Flows carry the origin they were recorded against (a dev port, the prod
// domain) while the gate may run an ephemeral server — and six flows replaying the gate
// homepage instead of their own pages was field issue #15.
export function resolveGateFlowUrl(declared, gateUrl) {
  if (!declared) return gateUrl || "";
  if (!gateUrl) return declared;
  try {
    const page = new URL(declared);
    const gate = new URL(gateUrl);
    if (page.origin === gate.origin) return declared;
    return new URL(page.pathname + page.search + page.hash, gate.origin).href;
  } catch {
    return declared;
  }
}

export async function runWebFlow({ flow, url, logPath, screenshotDir, recordVideoDir, variables = {}, strictOrigin = false, playwright, device = "", viewport = "", urlIsFallback = false, storageStatePath = "" }) {
  // urlIsFallback = the caller is a gate: the Flow's own page wins, rebased onto the gate's
  // deployment (see resolveGateFlowUrl). An explicit caller url (CLI positional) still overrides.
  const declaredUrl = flow.url || (/^https?:\/\//i.test(flow.app || "") ? flow.app : "");
  const startUrl = urlIsFallback ? resolveGateFlowUrl(declaredUrl, url) : (url || declaredUrl);
  if (!startUrl) throw new Error("Web Flow needs `url:` (or an http(s) `app:` value)");
  // TM-1077: an `upload:` step's file path is relative to the Flow file (stamped
  // on it by loadFlowFile), not the directory `tapp run` happened to be invoked from.
  const flowDir = flow.sourcePath ? path.dirname(flow.sourcePath) : process.cwd();
  if (logPath) fs.rmSync(logPath, { force: true });
  const setup = flow.setup || [];
  const teardown = flow.teardown || [];
  const loggedFlow = { ...flow, steps: [...setup, ...flow.steps, ...teardown] };
  const log = new FlowLog({ logPath, flow: loggedFlow });
  const pw = playwright || await loadPlaywright();
  const { webBrowserLaunchOptions, launchWebBrowser } = await import("./web-explorer.js");
  const browser = await launchWebBrowser(pw.chromium, webBrowserLaunchOptions());
  const contextOptions = webContextOptions({ device, viewport, devices: pw.devices });
  // Without an explicit size Playwright fits the recording into 800px, so a replay filmed at a
  // desktop viewport came out small and soft however large the window was. Film at the size the
  // run is actually rendered at, which is what exploration already does.
  const context = await browser.newContext({
    ...contextOptions,
    ...(recordVideoDir ? { recordVideo: { dir: recordVideoDir, ...(contextOptions.viewport ? { size: contextOptions.viewport } : {}) } } : {}),
    // A journey kept from a run that started signed in replays from the same saved session.
    ...(storageStatePath ? { storageState: storageStatePath } : {}),
  });
  const page = await context.newPage();
  const timeout = Number(flow.timeoutMs ?? flow.timeout) || DEFAULT_TIMEOUT;
  page.setDefaultTimeout(timeout);
  const vars = flowVariables(flow, variables);
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
        if (strictOrigin && new URL(page.url()).origin !== new URL(startUrl).origin) {
          emit({action:"origin",target:"connected app",status:"fail",detail:"The workflow left the connected app origin. Authorize a supported sign-in route before continuing."});
          break;
        }
        const outcome = await executeWebFlowStep({ page, step, vars, defaultTimeout: timeout, stepScreenshotDir: screenshotDir, flowDir });
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
      // Beside it, what the person actually sees: a fixed header, an open drawer or a toast is
      // placeable here and invisible in a full-page capture (TM-593).
      await page.screenshot({ path: path.join(screenshotDir, "flow-final-screen.png") }).catch(() => {});
    }
  } finally {
    await requestPhase(teardown);
    // Playwright only finalizes a recording when its context closes, and names the file by an
    // internal id. Capture the handle first, then give it the name the evidence page expects —
    // the same convention exploration already uses.
    const video = recordVideoDir && typeof page.video === "function" ? page.video() : null;
    // Test doubles for playwright may not model a context; a real one always closes.
    if (typeof context.close === "function") await context.close().catch(() => {});
    await browser.close().catch(() => {});
    if (video) {
      try {
        const produced = await video.path();
        if (produced && fs.existsSync(produced)) {
          const finalPath = path.join(recordVideoDir, "replay.webm");
          fs.renameSync(produced, finalPath);
          // VP9 is unopenable in QuickTime and Preview; ship an H.264 sibling beside it.
          const { writePlayableCopy } = await import("./capture-frames.js");
          await writePlayableCopy(finalPath).catch(() => {});
        }
      } catch { /* the replay result matters more than its recording */ }
    }
  }
  return log.finish({ url: startUrl });
}

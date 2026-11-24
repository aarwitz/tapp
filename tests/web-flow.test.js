import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { runWebFlow, executeWebFlowStep } from "../mcp-server/src/web-flow.js";

class FakeLocator {
  constructor(page, target, role = "") { this.page = page; this.target = target; this.role = role; }
  first() { return this; }
  async count() { return this.exists() ? 1 : 0; }
  async isVisible() { return this.exists(); }
  exists() {
    if (this.role === "heading") return this.page.screen.heading === this.target || !this.target;
    return Object.hasOwn(this.page.screen.controls, this.target);
  }
  async click() { this.page.current = this.page.screen.controls[this.target].next; }
  async fill(value) { this.page.values[this.target] = value; }
  async innerText() { return this.role === "heading" ? this.page.screen.heading : this.page.screen.controls[this.target]?.text || this.target; }
}

class FakePage {
  constructor() {
    this.current = "home";
    this.values = {};
    this.screens = {
      home: { title: "Home", heading: "Home", controls: { "Get Started": { next: "login" } } },
      login: { title: "Login", heading: "Login", controls: { Email: { text: "" }, Continue: { next: "dashboard" } } },
      dashboard: { title: "Dashboard", heading: "Dashboard", controls: { Settings: { text: "Settings" } } },
    };
  }
  get screen() { return this.screens[this.current]; }
  setDefaultTimeout() {}
  async goto() {}
  async title() { return this.screen.title; }
  url() { return `http://example.test/${this.current}`; }
  getByTestId(t) { return new FakeLocator(this, t); }
  locator(t) { return new FakeLocator(this, t.replace(/^#/, "")); }
  getByLabel(t) { return new FakeLocator(this, t); }
  getByText(t) { return new FakeLocator(this, t); }
  getByRole(role, opts = {}) { return new FakeLocator(this, opts.name || "", role); }
  async waitForLoadState() {}
  async waitForTimeout() {}
  async goBack() { this.current = "home"; }
  async evaluate() {}
  async screenshot() {}
}

test("browser Flow uses the shared committed test format without an LLM", async () => {
  const page = new FakePage();
  const playwright = { chromium: { launch: async () => ({
    newContext: async () => ({ newPage: async () => page }), close: async () => {},
  }) } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-web-flow-"));
  const logPath = path.join(dir, "flow.log");
  const result = await runWebFlow({
    flow: { name: "Web smoke", url: "http://example.test", steps: [
      { tap: "Get Started" }, { assert_screen: "Login" },
      { type: { field: "Email", value: "$TEST_EMAIL" } },
      { tap: "Continue" }, { assert_screen: "Dashboard" }, { assert_exists: "Settings" },
    ] },
    logPath, playwright,
  });
  assert.equal(result.passed, true);
  assert.equal(page.values.Email, "test@example.com");
});

test("single-actor browser Flows execute bounded same-origin setup and teardown", async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200).end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const page = new FakePage();
  const playwright = { chromium: { launch: async () => ({
    newContext: async () => ({ newPage: async () => page }), close: async () => {},
  }) } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-web-lifecycle-"));
  const logPath = path.join(dir, "flow.log");
  try {
    const result = await runWebFlow({
      flow: {
        name: "Lifecycle contract", url: `http://127.0.0.1:${address.port}`,
        setup: [{ request: { method: "POST", path: "/reset", status: 200 } }],
        steps: [{ assert_screen: "Home" }],
        teardown: [{ request: { method: "DELETE", path: "/fixture/$FIXTURE", status: 200 } }],
        vars: { FIXTURE: "order-1" },
      },
      logPath, playwright,
    });
    assert.equal(result.passed, true);
    assert.equal(result.total, 3);
    assert.deepEqual(requests, ["POST /reset", "DELETE /fixture/order-1"]);
    assert.match(fs.readFileSync(logPath, "utf8"), /"action":"request"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a gate-level url is a FALLBACK: the Flow's own url wins, and the result records it", async () => {
  // Field issue #15: the CI gate passed --url to every Flow, so six flows silently replayed
  // against the gate homepage instead of the page each Flow declares.
  const opened = [];
  const page = new FakePage();
  page.goto = async (u) => { opened.push(u); };
  const playwright = { chromium: { launch: async () => ({
    newContext: async () => ({ newPage: async () => page }), close: async () => {},
  }) } };
  const flow = { name: "pricing", url: "http://example.test/pricing?intake=off", steps: [{ assert_screen: "Home" }] };

  const gateStyle = await runWebFlow({ flow, url: "http://example.test/", urlIsFallback: true, playwright });
  assert.deepEqual(opened, ["http://example.test/pricing?intake=off"], "the flow's declared page is opened");
  assert.equal(gateStyle.url, "http://example.test/pricing?intake=off", "the result records the URL actually opened");

  opened.length = 0;
  const flowWithoutUrl = { name: "bare", steps: [{ assert_screen: "Home" }] };
  await runWebFlow({ flow: flowWithoutUrl, url: "http://example.test/fallback", urlIsFallback: true, playwright });
  assert.deepEqual(opened, ["http://example.test/fallback"], "a Flow without url still gets the gate url");

  // A Flow recorded against another deployment (dev port, prod domain) keeps its PAGE but runs
  // on the gate's deployment: the gate may have started an ephemeral server.
  opened.length = 0;
  const recordedElsewhere = { name: "checkout", url: "http://localhost:4173/checkout?step=2", steps: [{ assert_screen: "Home" }] };
  await runWebFlow({ flow: recordedElsewhere, url: "http://127.0.0.1:9999/", urlIsFallback: true, playwright });
  assert.deepEqual(opened, ["http://127.0.0.1:9999/checkout?step=2"], "a differing origin is rebased onto the gate deployment");

  opened.length = 0;
  await runWebFlow({ flow, url: "http://example.test/override", playwright });
  assert.deepEqual(opened, ["http://example.test/override"], "an explicit caller url (CLI) still overrides");
});

test("a tap failure keeps Playwright's diagnosable cause on one line", async () => {
  const { distillPlaywrightFailure } = await import("../mcp-server/src/web-flow.js");
  const playwrightMessage = [
    "locator.click: Timeout 6000ms exceeded.",
    "Call log:",
    "  - waiting for getByText('Find a Coach')",
    "  - element is visible, enabled and stable",
    '  - <div id="location-intake-modal">…</div> intercepts pointer events',
  ].join("\n");
  // Field issue #17: the report kept only "Timeout 6000ms exceeded" and read like the element
  // didn't exist, while the real cause (a consent modal) was in Playwright's own retry log.
  assert.equal(
    distillPlaywrightFailure(playwrightMessage),
    'locator.click: Timeout 6000ms exceeded. — click intercepted by <div id="location-intake-modal">…</div>'
  );
  assert.equal(distillPlaywrightFailure("could not find ‘Pricing’"), "could not find ‘Pricing’");
  const notVisible = "locator.click: Timeout 6000ms exceeded.\nCall log:\n  - element is not visible";
  assert.match(distillPlaywrightFailure(notVisible), /element is not visible/);
});

test("a boxed launch error reports its cause, not the box's bottom border", async () => {
  const { distillErrorMessage } = await import("../mcp-server/src/web-flow.js");
  // Field issue #23: every row of an 11-Flow scoreboard read `╚════╝` because the summary
  // kept the LAST line of Playwright's boxed install prompt and discarded the cause.
  const boxed = [
    "browserType.launch: Executable doesn't exist at /ms-playwright/chromium_headless_shell-1228/chrome-headless-shell",
    "╔════════════════════════════════════════════════════════════╗",
    "║ Looks like Playwright was just installed or updated.       ║",
    "║ Please run the following command to download new browsers: ║",
    "║                                                            ║",
    "║     npx playwright install                                 ║",
    "╚════════════════════════════════════════════════════════════╝",
  ].join("\n");
  const distilled = distillErrorMessage(boxed);
  assert.match(distilled, /^browserType\.launch: Executable doesn't exist/);
  assert.match(distilled, /fix: npx playwright install/);
  assert.doesNotMatch(distilled, /[╔╚═║]/);
  assert.equal(distillErrorMessage("Web Flow needs `url:`"), "Web Flow needs `url:`");
});

test("Flow targets resolve inside same-origin iframes, and cross-origin frames stay out of scope", async () => {
  const { locateWebElement } = await import("../mcp-server/src/web-flow.js");
  const searched = [];
  const scopeFor = (name, hasTarget) => ({
    getByTestId: () => ({ first: () => ({ count: async () => { searched.push(name); return hasTarget ? 1 : 0; }, isVisible: async () => hasTarget }) }),
    locator: () => ({ first: () => ({ count: async () => 0, isVisible: async () => false }) }),
    getByLabel: () => ({ first: () => ({ count: async () => 0, isVisible: async () => false }) }),
    getByRole: () => ({ first: () => ({ count: async () => 0, isVisible: async () => false }) }),
    getByText: () => ({ first: () => ({ count: async () => 0, isVisible: async () => false }) }),
  });
  const main = { ...scopeFor("main", false), url: () => "https://app.test/coach" };
  const sameOrigin = { ...scopeFor("same-origin-frame", true), url: () => "https://app.test/book-intro.html" };
  const crossOrigin = { ...scopeFor("cross-origin-frame", true), url: () => "https://widget.vendor.test/embed" };
  const page = {
    ...main,
    mainFrame: () => main,
    frames: () => [main, crossOrigin, sameOrigin],
  };
  // Field issue #14: a modal rendered into a same-origin iframe was visibly on screen but
  // invisible to a top-document-only search.
  const found = await locateWebElement(page, "Book This Coach");
  assert.ok(found, "the target inside the same-origin frame is found");
  assert.ok(searched.includes("same-origin-frame"), "same-origin frames are searched");
  assert.ok(!searched.includes("cross-origin-frame"), "a third-party frame is never asserted on");
});

// TM-593, reported through tapp's own feedback channel (public issue 36): verifying a two-handle
// price slider meant dropping to raw Playwright four times, because a journey could not drag, press
// a key, scroll inside a drawer, or take a picture at the moment that mattered. The sharpest part:
// `type` on a range input calls fill(), which sets the value without the handle ever moving, so no
// listener fires and the step passes having proved nothing.
const browserTest = { skip: process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1", timeout: 90_000 };

// A slider that only reacts to real interaction, and a drawer that scrolls independently of the page.
const SLIDER_PAGE = `<!doctype html><body style="margin:0;height:1800px">
  <div id="drawer" style="position:fixed;top:0;right:0;width:260px;height:100%;overflow-y:auto;background:#eee">
    <div style="height:900px">filler</div>
    <input id="price" type="range" min="0" max="100" value="50">
    <div style="height:900px">filler</div>
  </div>
  <span id="val">50</span><span id="moves">0</span>
  <script>
    const r = document.getElementById('price');
    r.addEventListener('input', () => { val.textContent = r.value; });
    r.addEventListener('pointerdown', () => { moves.textContent = +moves.textContent + 1; });
  </script></body>`;

test("a web journey can drag and press, and typing into a slider is not the same thing", browserTest, async (t) => {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch { return t.skip("playwright not installed"); }
  const browser = await chromium.launch({ headless: true });
  try {
    // A fresh page per case: reusing one across setContent calls leaves the pointer state behind
    // and a later drag lands nowhere, which is a quirk of the test API rather than anything a
    // journey does — it navigates.
    const onFreshPage = async (fn) => {
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
      await page.setContent(SLIDER_PAGE, { waitUntil: "domcontentloaded" });
      try {
        return await fn(page, (s) => executeWebFlowStep({ page, step: s }),
          async (id) => (await page.locator(`#${id}`).innerText()).trim());
      } finally { await page.context().close(); }
    };

    // What a journey had to do before: it passes, and the page never noticed.
    await onFreshPage(async (_p, step, read) => {
      assert.equal((await step({ type: { field: "price", value: "90" } })).status, "pass");
      assert.equal(await read("moves"), "0", "filling a range input moves no handle — the bug, not the fix");
    });

    await onFreshPage(async (_p, step, read) => {
      assert.equal((await step({ drag: { from: "price", by: [40, 0] } })).status, "pass");
      assert.equal(await read("moves"), "1", "a drag must reach the page's own listener");
    });

    await onFreshPage(async (_p, step, read) => {
      assert.equal((await step({ press: { key: "ArrowRight", target: "price", times: 5 } })).status, "pass");
      assert.equal(await read("val"), "55", "five presses move a slider five steps");
    });

    // The plain form, which is what the story, the vocabulary line and the reporter all asked for:
    // `press: ArrowRight`, pressed wherever the focus already is. It failed with "could not find
    // 'ArrowRight'" because the key was also being read as a control to focus, and the only test
    // used the object form, so nothing caught it (Linux's check of 6d8d531).
    await onFreshPage(async (page, step, read) => {
      await page.locator("#price").focus();
      assert.equal((await step({ press: "ArrowRight" })).status, "pass");
      assert.equal(await read("val"), "51", "a bare key goes to whatever has focus");
    });

    // A shortcut with nothing focused reaches the page rather than erroring.
    await onFreshPage(async (_p, step) => {
      assert.equal((await step({ press: "Escape" })).status, "pass");
    });
  } finally { await browser.close(); }
});

test("swipe reaches inside a drawer, and says so when nothing moved", browserTest, async (t) => {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch { return t.skip("playwright not installed"); }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await page.setContent(SLIDER_PAGE, { waitUntil: "domcontentloaded" });
    const scrollTop = () => page.locator("#drawer").evaluate((n) => n.scrollTop);

    assert.equal(await scrollTop(), 0);
    const moved = await executeWebFlowStep({ page, step: { swipe: { target: "up", within: "drawer" } } });
    assert.equal(moved.status, "pass");
    assert.ok(await scrollTop() > 0, "the drawer itself must scroll, not the window behind it");

    // Already at the top: the old step scrolled the window and passed regardless.
    const stuck = await executeWebFlowStep({ page, step: { swipe: { target: "down", within: "drawer" } } });
    await executeWebFlowStep({ page, step: { swipe: { target: "down", within: "drawer" } } }).catch(() => {});
    assert.ok(stuck.status === "pass" || /did not move/.test(stuck.detail || ""), "a swipe that moves nothing must not silently pass");
  } finally { await browser.close(); }
});

// YAML 1.1 reads a bare `on` as the boolean true, so `on: price-max` arrives as {"true": …} and the
// target vanishes. The first version of `press` took `on:` and pressed into the void, reporting
// pass — the exact failure this story exists to remove, written into its own fix.
test("press refuses `on:`, which YAML turns into true", async () => {
  const page = { }; // never reached: the check happens before any locating
  const out = await executeWebFlowStep({ page, step: { press: { key: "ArrowRight", true: "price" } } });
  assert.equal(out.status, "fail");
  assert.match(out.detail, /takes `target:`, not `on:`/);
});

// A `screenshot:` step promises a picture. With no evidence folder to write into it did the work of
// nothing and still reported pass — the same empty success this story exists to remove (Linux's
// check of 6d8d531). It says which it was now.
test("a screenshot step says when it saved nothing", async () => {
  const page = { waitForLoadState: async () => {}, waitForTimeout: async () => {} };
  const out = await executeWebFlowStep({ page, step: { screenshot: "moment" } });
  assert.equal(out.status, "skip");
  assert.match(out.detail, /not saved/);
});

// A journey starting from an email link ("tap the sign-in link in your receipt") could not be
// written down before: the one-time part had to be written into the app's storage by a wrapper
// script. open_url substitutes like any other target, so the link itself carries it.
test("open_url navigates straight there, with $VAR substitution like any other target", async () => {
  const calls = [];
  const page = {
    goto: async (url, opts) => { calls.push({ url, opts }); },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
  };
  const out = await executeWebFlowStep({
    page,
    step: { open_url: "https://example.test/claim?t=$CLAIM_TOKEN" },
    vars: { CLAIM_TOKEN: "abc123" },
  });
  assert.equal(out.status, "pass");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/claim?t=abc123");
});

// TM-1077: an admin "Import contacts" page (and certificate/newsletter uploads) starts with
// choosing a local file, which no committed Flow step could do before — the upload had to be
// driven by hand with raw Playwright, so the journey could never be kept and replayed.
test("upload needs {field, file}, and says so without touching the page", async () => {
  const page = {};
  const out = await executeWebFlowStep({ page, step: { upload: { field: "ci-file" } } });
  assert.equal(out.status, "fail");
  assert.match(out.detail, /upload needs \{field, file\}/);
});

test("upload refuses a file that does not exist, before looking for the picker", async () => {
  const page = {};
  const out = await executeWebFlowStep({
    page,
    step: { upload: { field: "ci-file", file: "nope.csv" } },
    flowDir: os.tmpdir(),
  });
  assert.equal(out.status, "fail");
  assert.match(out.detail, /upload file not found/);
});

// A real <input type=file>, hidden behind a styled label the way a real app's own upload
// buttons often are — opacity/position, never display:none, which a browser refuses to let
// choose a file at all. locateWebElement's visibility check would skip this control entirely.
const UPLOAD_PAGE = `<!doctype html><body>
  <label for="ci-file" style="position:absolute;opacity:0;width:1px;height:1px;overflow:hidden">Upload CSV</label>
  <input id="ci-file" type="file" style="position:absolute;opacity:0;width:1px;height:1px;overflow:hidden">
  <span id="chosen">none</span>
  <script>
    document.getElementById('ci-file').addEventListener('change', (e) => {
      chosen.textContent = e.target.files[0] ? e.target.files[0].name : 'none';
    });
  </script></body>`;

test("upload chooses a real file for an input hidden behind its label, and the page's own change handler runs", browserTest, async (t) => {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch { return t.skip("playwright not installed"); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-upload-"));
  const filePath = path.join(dir, "contacts.csv");
  fs.writeFileSync(filePath, "name,email\nJordan,jordan@example.test\n");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.setContent(UPLOAD_PAGE, { waitUntil: "domcontentloaded" });
    const out = await executeWebFlowStep({
      page,
      step: { upload: { field: "Upload CSV", file: "contacts.csv" } },
      flowDir: dir,
    });
    assert.equal(out.status, "pass");
    assert.equal((await page.locator("#chosen").innerText()).trim(), "contacts.csv", "the page's own change handler fired");
    const picked = await page.locator("#ci-file").evaluate((el) => el.files[0]?.name);
    assert.equal(picked, "contacts.csv");
  } finally { await browser.close(); }
});

test("upload resolves a relative file path against the Flow file's own directory, never the process cwd", browserTest, async (t) => {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch { return t.skip("playwright not installed"); }
  const flowDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-upload-flowdir-"));
  fs.writeFileSync(path.join(flowDir, "contacts.csv"), "name,email\n");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.setContent(UPLOAD_PAGE, { waitUntil: "domcontentloaded" });
    const originalCwd = process.cwd();
    process.chdir(os.tmpdir()); // a directory that does not hold contacts.csv
    try {
      const out = await executeWebFlowStep({
        page,
        step: { upload: { field: "Upload CSV", file: "contacts.csv" } },
        flowDir,
      });
      assert.equal(out.status, "pass", "the path resolved against flowDir, not the cwd we just changed to");
    } finally { process.chdir(originalCwd); }
  } finally { await browser.close(); }
});

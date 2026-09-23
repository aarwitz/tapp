import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { runWebFlow } from "../mcp-server/src/web-flow.js";

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

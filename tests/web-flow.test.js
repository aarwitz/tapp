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

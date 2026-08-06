import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWebScenario, validateScenario } from "../mcp-server/src/scenario-runtime.js";

class Locator {
  constructor(page, target, role = "") { this.page = page; this.target = target; this.role = role; }
  first() { return this; }
  async count() { return this.exists() ? 1 : 0; }
  async isVisible() { return this.exists(); }
  exists() { return this.role === "heading" || this.page.controls().includes(this.target); }
  async click() { this.page.click(this.target); }
  async fill(value) { this.page.values[this.target] = value; }
  async innerText() { return this.role === "heading" ? this.page.heading() : this.target; }
}

class ActorPage {
  constructor(shared) { this.shared = shared; this.values = {}; this.user = ""; }
  heading() { return this.user ? "Feed" : "Sign in"; }
  controls() {
    if (!this.user) return ["Email", "Password", "Sign in"];
    return ["Post text", "Publish", ...(this.shared.post ? [this.shared.post] : [])];
  }
  click(target) {
    if (target === "Sign in") this.user = this.values.Email;
    if (target === "Publish") this.shared.post = this.values["Post text"];
  }
  setDefaultTimeout() {}
  async goto() {}
  async title() { return this.heading(); }
  url() { return `http://example.test/${this.user ? "feed" : "login"}`; }
  getByTestId(t) { return new Locator(this, t); }
  locator(t) { return new Locator(this, t.replace(/^#/, "")); }
  getByLabel(t) { return new Locator(this, t); }
  getByText(t) { return new Locator(this, t); }
  getByRole(role, opts = {}) { return new Locator(this, opts.name || "", role); }
  async waitForLoadState() {}
  async waitForTimeout() {}
  async screenshot() {}
}

test("Scenario validation requires real isolated actors", () => {
  assert.deepEqual(validateScenario({ kind: "scenario", platform: "web", actors: { alice: {} }, steps: [{ actor: "alice", tap: "Go" }] }), [
    "actors must define at least two isolated actors",
  ]);
});

test("web Scenario interleaves isolated actor contexts over shared state without AI", async () => {
  const shared = { post: "" };
  const pages = [];
  const playwright = { chromium: { launch: async () => ({
    newContext: async () => {
      const page = new ActorPage(shared);
      pages.push(page);
      return { newPage: async () => page, close: async () => {} };
    },
    close: async () => {},
  }) } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-scenario-"));
  const logPath = path.join(dir, "scenario.log");
  const result = await runWebScenario({
    scenario: {
      name: "Alice publishes, Bob observes",
      kind: "scenario",
      platform: "web",
      url: "http://example.test",
      vars: { POST: "A deterministic post" },
      actors: {
        alice: { vars: { EMAIL: "alice@example.test", PASSWORD: "demo" } },
        bob: { vars: { EMAIL: "bob@example.test", PASSWORD: "demo" } },
      },
      steps: [
        { actor: "alice", type: { field: "Email", value: "$EMAIL" } },
        { actor: "alice", tap: "Sign in" },
        { actor: "alice", type: { field: "Post text", value: "$POST" } },
        { actor: "alice", tap: "Publish" },
        { actor: "bob", type: { field: "Email", value: "$EMAIL" } },
        { actor: "bob", tap: "Sign in" },
        { actor: "bob", assert_exists: "$POST" },
      ],
    },
    logPath,
    playwright,
  });
  assert.equal(result.passed, true);
  assert.equal(result.kind, "scenario");
  assert.equal(pages.length, 2);
  assert.equal(pages[0].values.Email, "alice@example.test");
  assert.equal(pages[1].values.Email, "bob@example.test");
  assert.match(fs.readFileSync(logPath, "utf8"), /"actor":"bob"/);
});

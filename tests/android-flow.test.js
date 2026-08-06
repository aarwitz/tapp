import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAndroidFlow } from "../mcp-server/src/android-flow.js";

class FakeAndroidDriver {
  constructor() { this.appId = ""; this.screen = "Get Started"; }
  async ensureDevice() {}
  async launch() { return this.snapshot(); }
  async snapshot() {
    return {
      activity: "com.tapp.demo/.MainActivity",
      screenTitle: this.screen,
      elements: this.screen === "Get Started"
        ? [{ id: "continue_button", label: "Continue", text: "Continue", hittable: true }]
        : [{ id: "settings_tab", label: "Settings", text: "Settings", hittable: true }],
    };
  }
  async tap(target) { if (target === "Continue") this.screen = "Dashboard"; return { status: "ok" }; }
  async settle() { return this.snapshot(); }
  async waitFor(target) { const s = await this.snapshot(); return s.screenTitle === target || s.elements.some((e) => e.label === target) ? s : null; }
  async screenshot() {}
}

test("Android Flow replays deterministically without a model", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-android-flow-"));
  const logPath = path.join(dir, "flow.log");
  const result = await runAndroidFlow({
    flow: { name: "Android smoke", app: "com.tapp.demo", steps: [{ tap: "Continue" }, { assert_screen: "Dashboard" }, { assert_exists: "Settings" }] },
    logPath,
    driver: new FakeAndroidDriver(),
  });
  assert.equal(result.passed, true);
  assert.match(fs.readFileSync(logPath, "utf8"), /"action":"assert_screen".*"status":"pass"/);
});

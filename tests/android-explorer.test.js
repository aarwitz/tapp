import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exploreAndroid, isAndroidAuthSubmit, isAndroidBlankSnapshot } from "../mcp-server/src/android-explorer.js";

class LoginDriver {
  constructor() { this.appId = "io.tapp.login"; this.screen = "Sign In"; this.filled = new Set(); }
  async ensureDevice() {}
  async launch() { return this.snapshot(); }
  async install() {}
  async screenshot() {}
  async snapshot() {
    const common = { package: this.appId, hittable: true, enabled: true, x: 0, y: 0, w: 100, h: 40 };
    const elements = this.screen === "Sign In" ? [
      { ...common, type: "android.widget.EditText", id: "email_field", label: "email_field", text: "Email", clickable: true },
      { ...common, type: "android.widget.EditText", id: "password_field", label: "password_field", text: "Password", secure: true, clickable: true },
      { ...common, type: "android.widget.Button", id: "sign_in_button", label: "Sign In", text: "Sign In", clickable: true },
    ] : [
      { ...common, type: "android.widget.Button", id: "profile_button", label: "Profile", text: "Profile", clickable: true },
    ];
    return { activity: `${this.appId}/.MainActivity`, screenTitle: this.screen, elements };
  }
  async type(target) { this.filled.add(target); return { status: "ok" }; }
  async tap(target) {
    if (target === "Sign In" && this.filled.has("email_field") && this.filled.has("password_field")) this.screen = "Home";
    return { status: "ok" };
  }
  async settle() { return this.snapshot(); }
  async back() { return { status: "ok" }; }
}

test("Android exploration fills each semantic field once before submitting", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-android-explorer-"));
  const result = await exploreAndroid({ appId: "io.tapp.login", maxActions: 4, timeoutSec: 30, outDir, driver: new LoginDriver() });
  const markers = fs.readFileSync(result.markersPath, "utf8");
  assert.match(markers, /"type":"type","target":"email_field"/);
  assert.match(markers, /"type":"type","target":"password_field"/);
  assert.match(markers, /"from":"Sign In","to":"Home","action":"Sign In"/);
  const firstState = markers.split(/\r?\n/).find((line) => line.startsWith("OCQA_STATE:{"));
  const state = JSON.parse(firstState.slice("OCQA_STATE:".length));
  assert.equal(state.controls.length, 3, "shared UI Map inventory includes fields and actions");
  assert.equal(state.controls.find((control) => control.id === "password_field").secure, true);
  assert.doesNotMatch(markers, /Control did not respond: email_field/);
  assert.match(markers, /OCQA_ACTION:.*"type":"login_submit"/);
  assert.doesNotMatch(markers, /auth_failed/);
});

class RejectedLoginDriver extends LoginDriver {
  async tap() { return { status: "ok" }; }
}

test("Android exploration reports a submitted sign-in that remains on the login surface", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-android-auth-failed-"));
  const result = await exploreAndroid({ appId: "io.tapp.login", maxActions: 3, timeoutSec: 30, outDir, driver: new RejectedLoginDriver() });
  const markers = fs.readFileSync(result.markersPath, "utf8");
  assert.match(markers, /OCQA_ISSUE:.*"type":"auth_failed".*"severity":"high"/);
  assert.doesNotMatch(markers, /Control did not respond/);
});

test("Android blank detection ignores meaningless framework containers", () => {
  assert.equal(isAndroidBlankSnapshot({ elements: [
    { package: "io.tapp.blank", type: "android.widget.FrameLayout", id: "", text: "", description: "", hittable: true, clickable: false },
    { package: "io.tapp.blank", type: "android.view.View", id: "android:id/content", text: "", description: "", hittable: true, clickable: false },
  ] }), true);
  assert.equal(isAndroidBlankSnapshot({ elements: [
    { package: "io.tapp.blank", type: "android.widget.TextView", text: "Welcome", description: "", hittable: true, clickable: false },
  ] }), false);
});

test("Android login-submit recognition handles accessibility identifiers", () => {
  assert.equal(isAndroidAuthSubmit({ description: "sign_in_button" }), true);
  assert.equal(isAndroidAuthSubmit({ id: "login-submit" }), true);
  assert.equal(isAndroidAuthSubmit({ text: "Save Profile" }), false);
});

class SystemBoundaryDriver {
  constructor() { this.appId = "io.tapp.demo"; this.inApp = true; }
  async ensureDevice() {}
  async launch() { return this.snapshot(); }
  async screenshot() {}
  async snapshot() {
    if (!this.inApp) return {
      activity: "com.google.android.apps.nexuslauncher/.NexusLauncherActivity",
      screenTitle: "Tue, Aug 4",
      elements: [{ package: "com.google.android.apps.nexuslauncher", type: "android.widget.TextView", text: "Tue, Aug 4", label: "Tue, Aug 4", hittable: true }],
    };
    return {
      activity: `${this.appId}/.MainActivity`, screenTitle: "Dashboard",
      elements: [{ package: this.appId, type: "android.widget.TextView", text: "Dashboard", label: "Dashboard", hittable: true }],
    };
  }
  async back() { this.inApp = false; return { status: "ok" }; }
  async settle() { return this.snapshot(); }
}

test("Android exploration never maps the launcher after Back leaves the app", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-android-boundary-"));
  const result = await exploreAndroid({ appId: "io.tapp.demo", maxActions: 2, timeoutSec: 30, outDir, driver: new SystemBoundaryDriver() });
  const markers = fs.readFileSync(result.markersPath, "utf8");
  assert.match(markers, /"screen":"Dashboard"/);
  assert.doesNotMatch(markers, /Tue, Aug 4|nexuslauncher/);
  assert.doesNotMatch(markers, /"to":"Tue, Aug 4"/);
  assert.match(markers, /OCQA_COMPLETE:.*"states":1/);
});

class CrashDriver {
  constructor() { this.appId = "io.tapp.crash"; this.crashed = false; }
  async ensureDevice() {}
  async launch() { return this.snapshot(); }
  async screenshot() {}
  async snapshot() {
    if (this.crashed) return {
      activity: "io.tapp.other/.MainActivity", screenTitle: "Other",
      elements: [{ package: "io.tapp.other", type: "android.widget.TextView", text: "Other", label: "Other", hittable: true }],
    };
    return {
      activity: `${this.appId}/.MainActivity`, screenTitle: "Home",
      elements: [{ package: this.appId, type: "android.widget.Button", text: "Crash", label: "Crash", clickable: true, hittable: true, enabled: true, x: 0, y: 0, w: 100, h: 40 }],
    };
  }
  async tap() { this.crashed = true; return { status: "ok" }; }
  async settle() { return this.snapshot(); }
  async isProcessAlive() { return !this.crashed; }
}

test("Android exploration classifies a process exit and never maps the exposed app behind it", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-android-crash-"));
  const result = await exploreAndroid({ appId: "io.tapp.crash", maxActions: 3, timeoutSec: 30, outDir, driver: new CrashDriver() });
  const markers = fs.readFileSync(result.markersPath, "utf8");
  assert.match(markers, /OCQA_ISSUE:.*"type":"crash".*"severity":"critical"/);
  assert.doesNotMatch(markers, /"screen":"Other"|"to":"Other"/);
});

class TargetPathDriver {
  constructor() { this.appId = "io.tapp.target"; this.screen = "Home"; }
  async ensureDevice() {}
  async launch() { return this.snapshot(); }
  async screenshot() {}
  async snapshot() {
    const common = { package: this.appId, hittable: true, enabled: true, x: 0, y: 0, w: 100, h: 40 };
    const elements = this.screen === "Home"
      ? [{ ...common, type: "android.widget.Button", id: "settings_button", label: "Settings", text: "Settings", clickable: true }]
      : [{ ...common, type: "android.widget.TextView", id: "settings_title", label: "Settings", text: "Settings" }];
    return { activity: `${this.appId}/.MainActivity`, screenTitle: this.screen, elements };
  }
  async tap(target) { if (target === "settings_button") this.screen = "Settings"; return { status: "ok" }; }
  async settle() { return this.snapshot(); }
  async back() { return { status: "ok" }; }
}

test("Android PR exploration replays one bounded UI Map path before broad crawling", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-android-pr-target-"));
  const seedTargets = [{
    id: "explore_settings", platform: "android", status: "planned",
    node: { id: "screen_settings", semanticKey: "settings", name: "Settings" },
    navigation: { status: "replayable", mode: "ui-map-path", steps: [{
      edgeId: "edge_settings", from: "screen_home", to: "screen_settings",
      action: { type: "tap", target: "Settings", selectors: [{ kind: "resourceId", value: "settings_button" }] },
      wait: { type: "condition", timeoutMs: 6000 },
    }] },
  }];
  const result = await exploreAndroid({ appId: "io.tapp.target", maxActions: 1, timeoutSec: 30, outDir, seedTargets, driver: new TargetPathDriver() });
  const markers = fs.readFileSync(result.markersPath, "utf8");
  assert.match(markers, /OCQA_ACTION:.*"target":"settings_button".*"reason":"pr_ui_map_path"/);
  assert.match(markers, /OCQA_PR_TARGET:\{"targetId":"explore_settings","status":"observed","screen":"Settings"\}/);
  assert.equal(result.seedTargets.length, 1);
});

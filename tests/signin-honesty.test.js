// TM-618: one rule for signing in, on every platform that signs in.
//
// The rule has two halves, and before this story each platform kept only some of it:
//
//   1. Never press a control that must not be pressed. "Continue with Google" hands a third-party
//      identity provider a session on someone's behalf.
//   2. A sign-in step may only pass once the password field has gone. Pressing a control always
//      "succeeds", so without this a dead or mis-chosen button is indistinguishable from signing in.
//
// Keeping the four runners in one file is the point: a platform that grows a sign-in step and
// forgets half the rule fails here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAndroidFlow } from "../mcp-server/src/android-flow.js";
import { runMacosFlow } from "../mcp-server/src/macos-flow.js";

const LOGIN = [{ login: { email: "a@b.c", password: "pw" } }];

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/* ---------------------------------------------------------------- Android */

class AndroidApp {
  /** @param {{submitLabel?: string, deadSubmit?: boolean, withProvider?: boolean}} opts */
  constructor({ submitLabel = "Continue", deadSubmit = false, withProvider = true } = {}) {
    Object.assign(this, { submitLabel, deadSubmit, withProvider });
    this.screen = "Sign In"; this.tapped = [];
  }
  els() {
    if (this.screen !== "Sign In") return [{ id: "home", label: "Home", text: "Home", type: "TextView", hittable: true }];
    const list = [
      { id: "email_field", label: "Email", text: "", type: "EditText", clickable: true, hittable: true, secure: false },
      { id: "password_field", label: "Password", text: "", type: "EditText", clickable: true, hittable: true, secure: true },
      { id: "forgot", label: "Forgot password?", text: "Forgot password?", type: "TextView", clickable: true, hittable: true },
    ];
    // The provider button sits BEFORE the real submit, so a position-only rule reaches it first.
    if (this.withProvider) list.push({ id: "google", label: "Continue with Google", text: "Continue with Google", type: "Button", clickable: true, hittable: true });
    list.push({ id: "submit", label: this.submitLabel, text: this.submitLabel, type: "Button", clickable: true, hittable: true });
    return list;
  }
  async ensureDevice() {} async launch() { return this.snapshot(); } async screenshot() {}
  async snapshot() { return { activity: "io.x/.A", screenTitle: this.screen, elements: this.els() }; }
  async settle() { return this.snapshot(); }
  async type() { return { status: "ok" }; }
  async tap(t) {
    this.tapped.push(t);
    if (!this.deadSubmit && (t === "submit" || t === this.submitLabel)) this.screen = "Home";
    return { status: "ok" };
  }
  async back() { return { status: "ok" }; }
  async imeShowing() { return false; }
  async waitFor(target) { const s = await this.snapshot(); return s.screenTitle === target ? s : null; }
}

async function androidLogin(driver) {
  return runAndroidFlow({ flow: { name: "l", app: "io.x", steps: LOGIN }, logPath: path.join(tmp("tapp-618-a-"), "f.log"), driver });
}

test("android: a provider button is never pressed, even sitting before the real submit", async () => {
  const app = new AndroidApp({ submitLabel: "Start training" });
  const result = await androidLogin(app);
  assert.equal(result.passed, true);
  assert.ok(!app.tapped.includes("google"), `pressed the provider button: ${JSON.stringify(app.tapped)}`);
  assert.equal(app.screen, "Home");
});

test("android: a sign-in that never leaves the form fails", async () => {
  const app = new AndroidApp({ deadSubmit: true });
  const result = await androidLogin(app);
  assert.equal(result.passed, false);
  assert.match(JSON.stringify(result), /did not leave the sign-in form/);
});

/* ------------------------------------------------------------------ macOS */

class MacApp {
  constructor({ submitLabel = "Continue", deadSubmit = false, withProvider = true } = {}) {
    Object.assign(this, { submitLabel, deadSubmit, withProvider });
    this.screen = "Sign In"; this.pressed = [];
  }
  snap() {
    const elements = this.screen !== "Sign In"
      ? [{ id: "home", label: "Home", kind: "text" }]
      : [
        { id: "email", label: "Email", kind: "field", secure: false, clickable: true },
        { id: "password", label: "Password", kind: "secureField", secure: true, clickable: true },
        { id: "forgot", label: "Forgot password?", kind: "button", clickable: true },
        ...(this.withProvider ? [{ id: "google", label: "Continue with Google", kind: "button", clickable: true }] : []),
        { id: "submit", label: this.submitLabel, kind: "button", clickable: true },
      ];
    return { screen: this.screen, elements };
  }
  launch() { return this.snap(); }
  settle() { return this.snap(); }
  find(target) {
    const wanted = String(target || "").toLowerCase();
    return this.snap().elements.find((e) => `${e.id} ${e.label}`.toLowerCase().includes(wanted)) || null;
  }
  type() { return { status: "ok" }; }
  tap(target) {
    this.pressed.push(target);
    if (!this.deadSubmit && (target === this.submitLabel || target === "submit")) this.screen = "Home";
    return { status: "ok" };
  }
  key() {} screenshot() {}
}

async function macLogin(driver) {
  return runMacosFlow({ flow: { name: "l", steps: LOGIN }, appPath: "/Applications/X.app", logPath: path.join(tmp("tapp-618-m-"), "f.log"), driver });
}

test("macOS: a provider button is never pressed", async () => {
  const app = new MacApp({ submitLabel: "Start training" });
  const result = await macLogin(app);
  assert.equal(result.passed, true);
  assert.ok(!app.pressed.includes("Continue with Google"), `pressed the provider button: ${JSON.stringify(app.pressed)}`);
});

test("macOS: a sign-in that never leaves the form fails instead of passing", async () => {
  const app = new MacApp({ deadSubmit: true });
  const result = await macLogin(app);
  assert.equal(result.passed, false, "this passed before TM-618: macOS pressed and never checked");
  assert.match(JSON.stringify(result), /did not leave the form/);
});

/* -------------------------------------- the two source-level runners (iOS, android session) */

test("every runner that signs in rules out the dangerous controls", () => {
  const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  // Strip comments: a comment that quotes the old word list is documentation, not the defect.
  const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // The three JavaScript runners use the shared rule by name.
  for (const rel of ["mcp-server/src/android-flow.js", "mcp-server/src/macos-flow.js"]) {
    assert.match(read(rel), /chooseSignInSubmit/, `${rel} must use the shared sign-in rule`);
  }
  assert.match(read("mcp-server/src/web-flow.js"), /findSignInSubmit|chooseSignInSubmit/,
    "the web runner must use the shared sign-in rule");

  // The interactive sessions live in index.js; the android one had its own word list (TM-618).
  const index = code("mcp-server/src/index.js");
  assert.match(index, /chooseSignInSubmit/, "the android interactive session must use the shared rule");
  assert.ok(!/\/sign in\|log in\|login\|continue\/i/.test(index),
    "index.js still contains the inline sign-in word list that matched 'Continue with Google'");

  // iOS is Swift and cannot import the rule, so it mirrors it; tests/sign-in.test.js pins the two.
  assert.match(read("Harness/OCQAHarnessUITests/ExplorerTests.swift"), /isNeverSignIn/,
    "the iOS harness must rule out the dangerous controls");
});

test("every runner that signs in judges success by the form, not the title", () => {
  const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  // index.js compared screenTitle before and after, which an app with two same-titled screens
  // defeats; it must look for the password field instead.
  const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const index = code("mcp-server/src/index.js");
  assert.ok(!/const before = s\.latestTree\.screenTitle/.test(index),
    "the android session still decides a sign-in from the screen title");
  for (const [rel, needle] of [
    ["mcp-server/src/android-flow.js", /passwordKey/],
    ["mcp-server/src/macos-flow.js", /stillSecure/],
    ["mcp-server/src/web-flow.js", /password\.isVisible/],
    ["Harness/OCQAHarnessUITests/ExplorerTests.swift", /formGone/],
  ]) {
    assert.match(read(rel), needle, `${rel} must confirm the sign-in form has gone`);
  }
});

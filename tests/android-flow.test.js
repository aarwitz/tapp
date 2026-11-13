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
      activity: "io.github.aarwitz.tapp.demo/.MainActivity",
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
    flow: { name: "Android smoke", app: "io.github.aarwitz.tapp.demo", steps: [{ tap: "Continue" }, { assert_screen: "Dashboard" }, { assert_exists: "Settings" }] },
    logPath,
    driver: new FakeAndroidDriver(),
  });
  assert.equal(result.passed, true);
  assert.match(fs.readFileSync(logPath, "utf8"), /"action":"assert_screen".*"status":"pass"/);
});

// TM-554: a login step may not report pass while the app is still on the sign-in form.
// `settle()` returns fresh element objects, as the real driver does — that is what broke the
// original identity-based lookup of the password field.
class LoginDriver {
  /**
   * @param {object} opts
   *   submitLabel  what the product calls its sign-in button ("Continue" is in SIGN_IN_NAME,
   *                "Start training" is not, which is what exposed the bug).
   *   imeCovers    the keyboard hides the submit until a `back` dismisses it.
   *   deadSubmit   pressing the button does nothing: the form must stay and the step must fail.
   */
  constructor({ submitLabel = "Start training", imeCovers = false, deadSubmit = false, backPops = false } = {}) {
    this.submitLabel = submitLabel; this.imeCovers = imeCovers; this.deadSubmit = deadSubmit;
    this.backPops = backPops;
    this.screen = "Sign In"; this.tapped = []; this.backs = 0;
  }
  els() {
    if (this.screen === "Launcher") return [{ id: "launcher", label: "Apps", text: "Apps", type: "TextView", hittable: true }];
    if (this.screen !== "Sign In") return [{ id: "home_title", label: "Home", text: "Home", type: "TextView", hittable: true }];
    return [
      { id: "email_field", label: "Email", text: "", type: "EditText", clickable: true, hittable: true, secure: false },
      { id: "password_field", label: "Password", text: "", type: "EditText", clickable: true, hittable: true, secure: true },
      { id: "forgot", label: "Forgot password?", text: "Forgot password?", type: "TextView", clickable: true, hittable: true },
      { id: "submit_btn", label: this.submitLabel, text: this.submitLabel, type: "Button", clickable: true, hittable: true },
      { id: "google_btn", label: "Continue with Google", text: "Continue with Google", type: "Button", clickable: true, hittable: true },
    ];
  }
  async ensureDevice() {} async launch() { return this.snapshot(); } async screenshot() {}
  async snapshot() { return { activity: "io.tapp.corpus.login/.MainActivity", screenTitle: this.screen, elements: this.els() }; }
  async settle() { return this.snapshot(); }
  async type() { return { status: "ok" }; }
  async tap(target) {
    this.tapped.push(target);
    // The IME swallows the press until it is dismissed; adb reports success regardless.
    if (this.imeCovers && this.backs === 0) return { status: "ok" };
    if (!this.deadSubmit && (target === "submit_btn" || target === this.submitLabel)) this.screen = "Home";
    return { status: "ok" };
  }
  // Back closes the keyboard while it is up, and otherwise leaves the screen — which is why the
  // runner has to ask before pressing it (TM-554).
  async back() { this.backs += 1; if (this.backPops) this.screen = "Launcher"; return { status: "ok" }; }
  async imeShowing() { return this.imeCovers && this.backs === 0; }
  async waitFor(t) { const s = await this.snapshot(); return s.screenTitle === t ? s : null; }
}

async function runLogin(driver) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-login-554-"));
  const result = await runAndroidFlow({
    flow: { name: "login", app: "io.tapp.corpus.login", steps: [{ login: { email: "a@b.c", password: "pw" } }] },
    logPath: path.join(dir, "flow.log"), driver,
  });
  return result;
}

test("TM-554: a product-named submit is pressed, not the email field", async () => {
  const d = new LoginDriver({ submitLabel: "Start training" });
  const result = await runLogin(d);
  assert.equal(result.passed, true);
  assert.equal(d.screen, "Home");
  assert.ok(!d.tapped.includes("email_field"), `tapped the email field: ${JSON.stringify(d.tapped)}`);
});

test("TM-554: a sign-in-named submit keeps working", async () => {
  const d = new LoginDriver({ submitLabel: "Continue" });
  assert.equal((await runLogin(d)).passed, true);
  assert.equal(d.screen, "Home");
});

test("TM-554: the keyboard covering the submit is recovered, not reported as a pass", async () => {
  const d = new LoginDriver({ submitLabel: "Continue", imeCovers: true });
  const result = await runLogin(d);
  assert.equal(result.passed, true);
  assert.equal(d.screen, "Home");
  assert.ok(d.backs > 0, "expected the IME to be dismissed before believing the tap");
});

test("TM-554: a login that never leaves the form fails instead of passing", async () => {
  const d = new LoginDriver({ submitLabel: "Continue", deadSubmit: true });
  const result = await runLogin(d);
  assert.equal(result.passed, false);
  assert.equal(d.screen, "Sign In");
  assert.match(JSON.stringify(result), /login did not leave the sign-in form/);
  assert.equal(d.backs, 0, "Back must not be pressed when no keyboard is up: it would leave the screen");
});

// Linux's follow-up on 2383cd3, which turned out to be a defect: pressing Back with no keyboard up
// pops the sign-in activity, the password field goes with it, and "the form is gone" would have
// been read as a successful sign-in — the very lie this story is about.
test("TM-554: Back leaving the sign-in screen is a failure, never a sign-in", async () => {
  const d = new LoginDriver({ submitLabel: "Continue", deadSubmit: true, imeCovers: true, backPops: true });
  const result = await runLogin(d);
  assert.equal(result.passed, false);
  assert.match(JSON.stringify(result), /dismissing the keyboard also left the sign-in screen/);
});

import test from "node:test";
import assert from "node:assert/strict";

import { chooseSignInSubmit, findSignInSubmit, NOT_SIGN_IN, SIGN_IN_NAME } from "../mcp-server/src/sign-in.js";

const browserTest = { skip: process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1", timeout: 90_000 };

// Every shape below was found on a real sign-in page. The word-list rule this replaced pressed
// the right button on exactly the first one.
const FORMS = {
  "the textbook form: a submit button named for the verb": {
    html: `<form><input type="email"><input type="password"><button type="submit">Sign in</button></form>`,
    expect: "Sign in",
  },
  "a React page with no <form> and no type attribute, button named for the product": {
    html: `<div><input type="email"><input type="password">
      <button>Forgot password?</button><button>Open My Profile</button></div>`,
    expect: "Open My Profile",
  },
  "the recovery link comes first and must never be pressed": {
    html: `<form><input type="email"><input type="password">
      <a role="button" href="#">Reset your password</a><button>Continue</button></form>`,
    expect: "Continue",
  },
  "social sign-in is offered above the real one and is not ours to use": {
    html: `<div><button>Continue with Google</button><button>Continue with Apple</button>
      <input type="email"><input type="password"><button>Let me in</button></div>`,
    expect: "Let me in",
  },
  "a disabled button is not the way in": {
    html: `<div><input type="email"><input type="password">
      <button disabled>Sign in</button><button>Submit form</button></div>`,
    expect: "Submit form",
  },
  "a header 'Sign up' must not be mistaken for 'Sign in'": {
    html: `<header><button>Sign up</button></header><div><input type="email"><input type="password">
      <button>Start coaching</button></div>`,
    expect: "Start coaching",
  },
};

test("tapp presses the button that signs you in, on the shapes real sign-in pages use", browserTest, async (t) => {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch { return t.skip("playwright not installed"); }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    for (const [shape, { html, expect }] of Object.entries(FORMS)) {
      await page.setContent(`<!doctype html><body style="margin:0">${html}</body>`, { waitUntil: "domcontentloaded" });
      const found = await findSignInSubmit(page);
      assert.ok(found, `${shape}: found no sign-in control at all`);
      assert.equal(found.name, expect, `${shape}: pressed the wrong control`);
    }
  } finally { await browser.close(); }
});

test("a page with nothing to press reports nothing rather than guessing", browserTest, async (t) => {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch { return t.skip("playwright not installed"); }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.setContent(`<!doctype html><body><input type="email"><input type="password">
      <button>Forgot password?</button></body>`, { waitUntil: "domcontentloaded" });
    assert.equal(await findSignInSubmit(page), null);
  } finally { await browser.close(); }
});

test("the ordering rules hold without a browser", () => {
  const candidate = (index, name, extra = {}) => ({ index, name, visible: true, disabled: false, after: true, ...extra });
  // A named sign-in control after the password beats a named one before it.
  assert.equal(chooseSignInSubmit([
    candidate(0, "Sign in", { after: false }), candidate(1, "Log in"),
  ]).index, 1);
  // Position is the fallback, and it is reported as such so a report can say how it was found.
  const positional = chooseSignInSubmit([candidate(0, "Forgot password?"), candidate(1, "Open My Profile")]);
  assert.equal(positional.name, "Open My Profile");
  assert.equal(positional.reason, "position");
  assert.equal(chooseSignInSubmit([candidate(0, "Sign in")]).reason, "name");
  // Nothing usable is null, never the first thing on the page.
  assert.equal(chooseSignInSubmit([candidate(0, "Forgot password?")]), null);
  assert.equal(chooseSignInSubmit([candidate(0, "Sign in", { visible: false })]), null);
  assert.equal(chooseSignInSubmit([]), null);
});

test("a machine never signs in through somebody else's identity provider", () => {
  for (const name of ["Continue with Google", "Sign in with Apple", "Continue with GitHub", "Use SSO"]) {
    assert.match(name, NOT_SIGN_IN, `${name} must be ruled out`);
  }
  assert.match("Sign in", SIGN_IN_NAME);
  assert.doesNotMatch("Open My Profile", SIGN_IN_NAME);
});

// TM-618: iOS signs in from the Swift harness, which cannot import this module, so its exclusion
// list is a copy. A copy maintained by hope drifts, and the thing it protects is serious: pressing
// "Continue with Google" hands a third-party identity provider a session on someone's behalf, and
// the hand-off makes the app's own form vanish so the harness's form-gone check reads it as
// success. This pins the two together by behaviour, on the names that matter.
test("the iOS harness's exclusion list agrees with NOT_SIGN_IN", async () => {
  const fs = await import("node:fs");
  const swift = fs.readFileSync(new URL("../Harness/OCQAHarnessUITests/ExplorerTests.swift", import.meta.url), "utf8");

  const block = swift.match(/let neverSignIn = \[([\s\S]*?)\]/);
  assert.ok(block, "the harness must still declare neverSignIn — if it was renamed, update this test with it");
  const swiftList = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(swiftList.length >= 20, `expected the full mirrored list, found ${swiftList.length}`);
  const swiftForbids = (name) => swiftList.some((needle) => name.toLowerCase().includes(needle));

  // Both sides must reach the same verdict on every one of these. The third-party providers are
  // the cases that must never regress.
  const MUST_REFUSE = [
    "Continue with Google", "Continue with Apple", "Continue with Facebook", "Continue with GitHub",
    "Continue with Microsoft", "Sign in with Google", "Forgot password?", "Reset my password",
    "Create an account", "Sign up", "Register", "Privacy policy", "Terms of service",
    "Single sign-on", "Skip", "Cancel", "Dismiss", "Close", "Need help", "Show password",
  ];
  const MUST_ALLOW = ["Sign in", "Log in", "Continue", "Submit", "Next", "Get started", "Start training", "Open My Profile"];

  for (const name of MUST_REFUSE) {
    assert.ok(NOT_SIGN_IN.test(name), `shared rule should refuse ${name}`);
    assert.ok(swiftForbids(name), `the iOS harness list should refuse ${name} — it has drifted from NOT_SIGN_IN`);
  }
  for (const name of MUST_ALLOW) {
    assert.ok(!NOT_SIGN_IN.test(name), `shared rule should allow ${name}`);
    assert.ok(!swiftForbids(name), `the iOS harness list should allow ${name} — it has drifted from NOT_SIGN_IN`);
  }
});

// The harness must refuse to sign in rather than press a provider button when that is all there is.
test("the iOS harness rules the dangerous buttons out before preferring a name", async () => {
  const fs = await import("node:fs");
  const swift = fs.readFileSync(new URL("../Harness/OCQAHarnessUITests/ExplorerTests.swift", import.meta.url), "utf8");
  const fn = swift.match(/func submitButton\(\) -> XCUIElement\? \{[\s\S]*?\n        \}/);
  assert.ok(fn, "submitButton() must still exist");
  const body = fn[0];
  assert.match(body, /isNeverSignIn/, "submitButton() must consult the exclusion list");
  // The filter has to come before the keyword preference, or a provider button still wins.
  assert.ok(body.indexOf("isNeverSignIn") < body.indexOf("keywords.contains"),
    "the exclusion must be applied before the keyword preference");
});

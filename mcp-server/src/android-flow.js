import fs from "node:fs";
import path from "node:path";
import { AndroidDriver, findAndroidElement, isAndroidAppSnapshot } from "./android-driver.js";
import { FlowLog, flowVariables, normalizeFlowStep, substituteFlowValue, isOptionalStep } from "./flow-runtime.js";
import { chooseSignInSubmit } from "./sign-in.js";

const DEFAULT_TIMEOUT = 6000;

async function waitForExactScreen(driver, wanted, timeout) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await driver.snapshot();
    if (latest.screenTitle.toLowerCase() === wanted.toLowerCase()) return latest;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return latest;
}

export async function runAndroidFlow({ flow, appId, apkPath, serial, logPath, screenshotDir, driver }) {
  const targetApp = appId || flow.app;
  if (!targetApp) throw new Error("Android Flow needs `app:` with the application id");
  if (logPath) fs.rmSync(logPath, { force: true });
  const d = driver || new AndroidDriver({ appId: targetApp, serial });
  d.appId = targetApp;
  await d.ensureDevice();
  if (apkPath) await d.install(apkPath);
  let snap = await d.launch({ clearData: flow.reset === "clear" });
  const log = new FlowLog({ logPath, flow });
  const vars = flowVariables(flow);

  for (let i = 0; i < flow.steps.length; i += 1) {
    const raw = normalizeFlowStep(flow.steps[i]);
    const action = raw.action;
    const target = substituteFlowValue(raw.target, vars);
    const value = substituteFlowValue(raw.value, vars);
    const timeout = Number(raw.params.timeoutMs) || DEFAULT_TIMEOUT;
    let status = "pass";
    let detail = "";
    try {
      if (action === "tap") {
        const r = await d.tap(target, snap);
        if (r.status !== "ok") throw new Error(r.detail || `could not tap ‘${target}’`);
      } else if (action === "type") {
        const r = await d.type(target, value, snap);
        if (r.status !== "ok") throw new Error(r.detail || `no field ‘${target}’ to type into`);
      } else if (action === "login") {
        const fields = snap.elements.filter((element) => /EditText/i.test(element.type));
        const emailField = fields.find((element) => /email|user/i.test(`${element.id} ${element.label}`)) || fields.find((element) => !element.secure);
        const passwordField = fields.find((element) => element.secure || /password|passcode/i.test(`${element.id} ${element.label}`));
        if (!emailField || !passwordField) throw new Error("could not identify email and password fields");
        const emailValue = substituteFlowValue(raw.params.email || "$TEST_EMAIL", vars);
        const passwordValue = substituteFlowValue(raw.params.password || "$TEST_PASSWORD", vars);
        const emailResult = await d.type(emailField.id || emailField.label, emailValue, snap);
        if (emailResult.status !== "ok") throw new Error(emailResult.detail || "could not fill the email field");
        snap = await d.settle();
        const passwordResult = await d.type(passwordField.id || passwordField.label, passwordValue, snap);
        if (passwordResult.status !== "ok") throw new Error(passwordResult.detail || "could not fill the password field");
        snap = await d.settle();
        // Same rule as the web runner: rule out "Forgot password" and "Continue with Google" by
        // name, prefer a sign-in name, and otherwise take the first clickable control after the
        // password field — Android apps name that button after the product too.
        //
        // TM-554: `settle()` returns a fresh snapshot, so the pre-typing `passwordField` object is
        // not in `snap.elements` and `indexOf` returned -1. Every control then counted as "after
        // the password", and a submit named for the product (outside SIGN_IN_NAME) fell through to
        // the position rule, which picked the first clickable element — the email field. Tapping a
        // text field succeeds, so the step passed with the form still on screen. Find the field
        // again by key, and never offer a text field as the thing that signs you in.
        const passwordKey = passwordField.id || passwordField.description || passwordField.label;
        const passwordNow = findAndroidElement(snap.elements, passwordKey) || passwordField;
        const passwordIndex = snap.elements.indexOf(passwordNow);
        const choice = chooseSignInSubmit(snap.elements.map((element, index) => ({
          index,
          name: `${element.text || ""} ${element.label || ""}`.replace(/\s+/g, " ").trim() || String(element.id || ""),
          visible: Boolean(element.clickable) && !/EditText/i.test(element.type || ""),
          disabled: element.enabled === false,
          after: passwordIndex >= 0 && index > passwordIndex,
        })));
        const submit = choice ? snap.elements[choice.index] : null;
        if (!submit) throw new Error("could not identify a sign-in control");
        const submitKey = submit.id || submit.description || submit.text;
        const submitName = submit.text || submit.label || submit.id;
        const press = async () => {
          const r = await d.tap(submitKey, snap);
          if (r.status !== "ok") throw new Error(r.detail || "could not submit the login form");
          snap = await d.settle();
          return !findAndroidElement(snap.elements, passwordKey);
        };
        const stillOnForm = `login did not leave the sign-in form: ‘${submitName}’ was pressed but the password field is still on screen`;
        // A login step may only pass when the form is actually gone (TM-554). `adb shell input
        // tap` reports success whatever it lands on, so a press the keyboard swallowed looks
        // exactly like signing in.
        if (!(await press())) {
          // Only Back out of a keyboard that is actually up. Back with no IME means "leave this
          // screen", which would pop the sign-in activity — and then the password field is gone
          // for the wrong reason, which the check above would have read as a successful sign-in.
          if (!(d.imeShowing && (await d.imeShowing()))) throw new Error(stillOnForm);
          await d.back();
          snap = await d.settle();
          if (!findAndroidElement(snap.elements, passwordKey)) {
            throw new Error(`login did not sign in: dismissing the keyboard also left the sign-in screen, so ‘${submitName}’ was never accepted`);
          }
          if (!(await press())) throw new Error(stillOnForm);
        }
      } else if (action === "swipe") {
        await d.swipe(target || "up");
      } else if (action === "back") {
        await d.back();
      } else if (action === "wait_for") {
        const waited = await d.waitFor(target, timeout);
        if (!waited) throw new Error(`‘${target}’ never appeared within ${timeout}ms`);
        snap = waited;
      } else if (action === "wait") {
        await new Promise((resolve) => setTimeout(resolve, timeout));
      } else if (action === "assert_screen") {
        const wanted = value || target;
        snap = await waitForExactScreen(d, wanted, timeout);
        if (snap.screenTitle.toLowerCase() !== wanted.toLowerCase()) throw new Error(`expected screen ‘${wanted}’, saw ‘${snap.screenTitle}’`);
      } else if (action === "assert_exists") {
        if (!await d.waitFor(target, timeout)) throw new Error(`‘${target}’ not found`);
      } else if (action === "assert_absent") {
        snap = await d.settle(1500);
        if (findAndroidElement(snap.elements, target)) throw new Error(`‘${target}’ was present but should be absent`);
      } else if (action === "assert_text") {
        const of = substituteFlowValue(raw.params.of || target, vars);
        const needle = substituteFlowValue(raw.params.contains || value, vars);
        snap = await d.snapshot();
        const el = findAndroidElement(snap.elements, of);
        if (!el || !String(el.text || el.label).toLowerCase().includes(needle.toLowerCase())) throw new Error(`‘${of}’ did not contain ‘${needle}’`);
      } else if (action === "assert_ai") {
        status = "skip";
        detail = "AI assertions are advisory and are not part of deterministic Android replay";
      } else {
        throw new Error(`unknown action ‘${action}’`);
      }
      if (!["wait_for", "assert_screen", "assert_exists", "assert_absent", "assert_text", "assert_ai"].includes(action)) snap = await d.settle();
      if (action !== "assert_ai" && !isAndroidAppSnapshot(snap, targetApp)) throw new Error(`app left the foreground during ‘${action}’`);
    } catch (error) {
      // A step the author marked optional reports what it did not find, and the run carries on.
      if (isOptionalStep(raw)) {
        status = "skip";
        detail = `optional — ${error.message || String(error)}`;
      } else {
        status = "fail";
        detail = error.message || String(error);
        if (screenshotDir) await d.screenshot(path.join(screenshotDir, `flow-failure-${i + 1}.png`)).catch(() => {});
      }
    }
    log.step({ index: i + 1, action, target: action === "login" ? "sign-in form" : target || value, status, detail, task: raw.task });
    if (status === "fail" && !flow.continueOnFailure) break;
  }
  if (screenshotDir) await d.screenshot(path.join(screenshotDir, "flow-final.png")).catch(() => {});
  return log.finish();
}

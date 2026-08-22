import fs from "node:fs";
import path from "node:path";
import { AndroidDriver, findAndroidElement, isAndroidAppSnapshot } from "./android-driver.js";
import { FlowLog, flowVariables, normalizeFlowStep, substituteFlowValue } from "./flow-runtime.js";

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
        const submit = snap.elements.find((element) => element.clickable && /sign in|log in|login|continue|submit/i.test(`${element.text} ${element.label} ${element.id}`));
        if (!submit) throw new Error("could not identify a sign-in control");
        const submitResult = await d.tap(submit.id || submit.description || submit.text, snap);
        if (submitResult.status !== "ok") throw new Error(submitResult.detail || "could not submit the login form");
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
      status = "fail";
      detail = error.message || String(error);
      if (screenshotDir) await d.screenshot(path.join(screenshotDir, `flow-failure-${i + 1}.png`)).catch(() => {});
    }
    log.step({ index: i + 1, action, target: action === "login" ? "sign-in form" : target || value, status, detail, task: raw.task });
    if (status === "fail" && !flow.continueOnFailure) break;
  }
  if (screenshotDir) await d.screenshot(path.join(screenshotDir, "flow-final.png")).catch(() => {});
  return log.finish();
}

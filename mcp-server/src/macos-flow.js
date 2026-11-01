// Deterministic replay of a Flow against a macOS application.
//
// Same vocabulary as every other platform, so a journey kept from a macOS exploration is an
// ordinary Flow file and the Studio, the scheduler and the agent token all work unchanged.
// `swipe` is the one step with no sensible desktop meaning; it is skipped and said so, rather
// than silently passing.
import fs from "node:fs";
import path from "node:path";

import { MacosDriver } from "./macos-driver.js";
import { FlowLog, flowVariables, normalizeFlowStep, substituteFlowValue } from "./flow-runtime.js";
import { chooseSignInSubmit } from "./sign-in.js";

const DEFAULT_TIMEOUT = 6000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function screenMatches(snap, wanted) {
  return String(snap.screen || "").trim().toLowerCase() === String(wanted || "").trim().toLowerCase();
}

async function waitFor(driver, predicate, timeout) {
  const deadline = Date.now() + timeout;
  let snap = driver.settle();
  while (Date.now() < deadline) {
    if (predicate(snap)) return snap;
    await sleep(200);
    snap = driver.settle();
  }
  return predicate(snap) ? snap : null;
}

export async function runMacosFlow({ flow, appPath, logPath, screenshotDir, driver, home }) {
  const target = appPath || flow.app || flow.url;
  if (!target) throw new Error("A macOS Flow needs `app:` with the path to the application");
  if (logPath) fs.rmSync(logPath, { force: true });
  const d = driver || new MacosDriver({ home });
  d.launch(target);
  let snap = d.settle();
  const log = new FlowLog({ logPath, flow });
  const vars = flowVariables(flow);

  for (let index = 0; index < flow.steps.length; index += 1) {
    const raw = normalizeFlowStep(flow.steps[index]);
    const action = raw.action;
    const stepTarget = substituteFlowValue(raw.target, vars);
    const value = substituteFlowValue(raw.value, vars);
    const timeout = Number(raw.params.timeoutMs ?? raw.params.timeout) || DEFAULT_TIMEOUT;
    let status = "pass";
    let detail = "";
    try {
      if (action === "tap") {
        const result = d.tap(stepTarget, snap);
        if (result.status !== "ok") throw new Error(result.detail || `could not press ‘${stepTarget}’`);
      } else if (action === "type") {
        const result = d.type(stepTarget, value, snap);
        if (result.status !== "ok") throw new Error(result.detail || `no field ‘${stepTarget}’ to type into`);
      } else if (action === "login") {
        const fields = snap.elements.filter((element) => !element.inMenu && (element.kind === "field" || element.kind === "secureField"));
        const emailField = fields.find((element) => /email|user|account/i.test(`${element.id} ${element.label}`)) || fields.find((element) => !element.secure);
        const passwordField = fields.find((element) => element.secure || /password|passcode/i.test(`${element.id} ${element.label}`));
        if (!emailField || !passwordField) throw new Error("could not identify email and password fields");
        const emailValue = substituteFlowValue(raw.params.email || "$TEST_EMAIL", vars);
        const passwordValue = substituteFlowValue(raw.params.password || "$TEST_PASSWORD", vars);
        const filledEmail = d.type(emailField.id || emailField.label, emailValue, snap);
        if (filledEmail.status !== "ok") throw new Error(filledEmail.detail || "could not fill the email field");
        snap = d.settle();
        const filledPassword = d.type(passwordField.id || passwordField.label, passwordValue, snap);
        if (filledPassword.status !== "ok") throw new Error(filledPassword.detail || "could not fill the password field");
        snap = d.settle();
        // The one sign-in rule, shared with web, Android and the explorer: rule out "Forgot
        // password" and "Continue with Google" by name, prefer a sign-in name, otherwise take
        // the first pressable control after the password field (mcp-server/src/sign-in.js).
        const passwordIndex = snap.elements.findIndex((element) => element.secure);
        const choice = chooseSignInSubmit(snap.elements.map((element, position) => ({
          index: position,
          name: element.label || element.id,
          visible: Boolean(element.clickable) && !element.inMenu,
          disabled: element.enabled === false,
          after: position > passwordIndex,
        })));
        const submit = choice ? snap.elements[choice.index] : null;
        if (!submit) throw new Error("could not identify a sign-in control");
        const pressed = d.tap(submit.label || submit.id, snap);
        if (pressed.status !== "ok") throw new Error(pressed.detail || "could not submit the sign-in form");
      } else if (action === "back") {
        d.key("escape");
      } else if (action === "wait_for") {
        const seen = await waitFor(d, (candidate) => screenMatches(candidate, stepTarget)
          || candidate.elements.some((element) => `${element.label} ${element.value}`.toLowerCase().includes(String(stepTarget).toLowerCase())), timeout);
        if (!seen) throw new Error(`‘${stepTarget}’ never appeared within ${timeout}ms`);
        snap = seen;
      } else if (action === "wait") {
        await sleep(timeout);
      } else if (action === "assert_screen") {
        const wanted = value || stepTarget;
        const seen = await waitFor(d, (candidate) => screenMatches(candidate, wanted), timeout);
        if (!seen) throw new Error(`expected window ‘${wanted}’, saw ‘${d.settle().screen}’`);
        snap = seen;
      } else if (action === "assert_exists") {
        const seen = await waitFor(d, (candidate) => Boolean(d.find(stepTarget, candidate)), timeout);
        if (!seen) throw new Error(`‘${stepTarget}’ not found`);
        snap = seen;
      } else if (action === "assert_absent") {
        snap = d.settle();
        if (d.find(stepTarget, snap)) throw new Error(`‘${stepTarget}’ was present but should be absent`);
      } else if (action === "assert_text") {
        const of = substituteFlowValue(raw.params.of || stepTarget, vars);
        const needle = substituteFlowValue(raw.params.contains || value, vars);
        snap = d.settle();
        const element = d.find(of, snap);
        if (!element || !`${element.value || element.label}`.toLowerCase().includes(String(needle).toLowerCase())) {
          throw new Error(`‘${of}’ did not contain ‘${needle}’`);
        }
      } else if (action === "swipe") {
        status = "skip";
        detail = "swipe has no meaning on a desktop window";
      } else if (action === "assert_ai") {
        status = "skip";
        detail = "AI assertions are advisory and are not part of deterministic macOS replay";
      } else {
        throw new Error(`unknown action ‘${action}’`);
      }
      if (!["wait_for", "assert_screen", "assert_exists", "assert_absent", "assert_text", "assert_ai", "swipe"].includes(action)) {
        await sleep(200);
        snap = d.settle();
      }
    } catch (error) {
      status = "fail";
      detail = error.message || String(error);
      if (screenshotDir) d.screenshot(path.join(screenshotDir, `flow-failure-${index + 1}.png`), snap);
    }
    log.step({ index: index + 1, action, target: action === "login" ? "sign-in form" : stepTarget || value, status, detail, task: raw.task });
    if (status === "fail" && !flow.continueOnFailure) break;
  }
  if (screenshotDir) d.screenshot(path.join(screenshotDir, "flow-final.png"), snap);
  return log.finish();
}

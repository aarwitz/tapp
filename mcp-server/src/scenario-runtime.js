// Deterministic multi-actor scenarios. Each actor owns an isolated browser
// context while all actors interact with the same deployed system. Scenario
// orchestration never needs a model or coding agent at replay time.
import fs from "node:fs";
import path from "node:path";
import { FlowLog, flowVariables, loadFlowFile, normalizeFlowStep } from "./flow-runtime.js";
import { executeWebFlowStep, runWebRequestStep } from "./web-flow.js";
import { loadPlaywright } from "./web-explorer.js";

const DEFAULT_TIMEOUT = 6000;

export function loadScenarioFile(scenarioPath) {
  return loadFlowFile(scenarioPath);
}

function actorStepBody(step) {
  if (!step || typeof step !== "object" || Array.isArray(step)) return step;
  if (step.do && typeof step.do === "object") return step.do;
  const body = { ...step };
  delete body.actor;
  return body;
}

export function validateScenario(scenario) {
  const errors = [];
  if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) return ["Scenario must be an object"];
  if (scenario.kind && scenario.kind !== "scenario") errors.push("kind must be 'scenario'");
  if (String(scenario.platform || "web").toLowerCase() !== "web") {
    errors.push("multi-actor replay currently supports platform: web; iOS and Android actor isolation are not yet implemented");
  }
  const actors = scenario.actors && typeof scenario.actors === "object" && !Array.isArray(scenario.actors)
    ? Object.keys(scenario.actors) : [];
  if (actors.length < 2) errors.push("actors must define at least two isolated actors");
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) errors.push("steps must be a non-empty array");
  for (const [index, step] of (scenario.steps || []).entries()) {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      errors.push(`steps[${index}] must be an object`);
      continue;
    }
    if (!actors.includes(step.actor)) errors.push(`steps[${index}].actor must name a defined actor`);
    const action = normalizeFlowStep(actorStepBody(step)).action;
    if (!action || action === "noop") errors.push(`steps[${index}] must define an action`);
  }
  for (const phase of ["setup", "teardown"]) {
    if (scenario[phase] !== undefined && !Array.isArray(scenario[phase])) errors.push(`${phase} must be an array`);
    for (const [index, step] of (scenario[phase] || []).entries()) {
      if (!step?.request || typeof step.request !== "object") errors.push(`${phase}[${index}] must be a request step`);
      else if (!step.request.path) errors.push(`${phase}[${index}].request.path is required`);
    }
  }
  return errors;
}

function substituteExplicit(value, vars) {
  return String(value ?? "").replace(/\$([A-Z][A-Z0-9_]*)/g, (match, key) => {
    if (Object.hasOwn(vars, key)) return String(vars[key]);
    if (Object.hasOwn(process.env, key)) return String(process.env[key]);
    return match;
  });
}

function resolveVarMap(raw, base = {}) {
  const out = { ...base };
  for (const [key, value] of Object.entries(raw || {})) out[key] = substituteExplicit(value, out);
  return out;
}

export async function runWebScenario({ scenario, url, variables = {}, logPath, screenshotDir, playwright }) {
  const errors = validateScenario(scenario);
  if (errors.length) throw new Error(`Invalid Scenario: ${errors.join("; ")}`);
  const startUrl = url || scenario.url || (/^https?:\/\//i.test(scenario.app || "") ? scenario.app : "");
  if (!startUrl) throw new Error("Web Scenario needs `url:` (or an http(s) `app:` value)");
  if (logPath) fs.rmSync(logPath, { force: true });

  const setup = scenario.setup || [];
  const teardown = scenario.teardown || [];
  const loggedScenario = { ...scenario, kind: "scenario", steps: [...setup, ...scenario.steps, ...teardown] };
  const log = new FlowLog({ logPath, flow: loggedScenario });
  const sharedVars = resolveVarMap({ ...(scenario.vars || {}), ...variables }, flowVariables(scenario));
  const timeout = Number(scenario.timeoutMs) || DEFAULT_TIMEOUT;
  const pw = playwright || await loadPlaywright();
  const browser = await pw.chromium.launch({ headless: true });
  const sessions = new Map();
  let index = 0;
  let failed = false;

  const emit = (actor, outcome) => {
    index += 1;
    log.step({ index, actor, ...outcome });
    if (outcome.status === "fail") failed = true;
  };

  const requestPhase = async (steps, actor) => {
    for (const step of steps) {
      try {
        emit(actor, await runWebRequestStep({ step, startUrl, vars: sharedVars, timeout }));
      } catch (error) {
        emit(actor, { action: "request", target: String(step?.request?.path || "request"), status: "fail", detail: error.message || String(error) });
        break;
      }
    }
  };

  try {
    await requestPhase(setup, "setup");
    if (!failed) {
      for (const [actor, config] of Object.entries(scenario.actors)) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const page = await context.newPage();
        page.setDefaultTimeout(timeout);
        await page.goto(config.url || startUrl, { waitUntil: "domcontentloaded" });
        const vars = resolveVarMap(config.vars, sharedVars);
        sessions.set(actor, { context, page, vars });
      }

      for (const step of scenario.steps) {
        const session = sessions.get(step.actor);
        const outcome = await executeWebFlowStep({ page: session.page, step: actorStepBody(step), vars: session.vars, defaultTimeout: timeout });
        emit(step.actor, outcome);
        if (outcome.status === "fail" && screenshotDir) {
          fs.mkdirSync(screenshotDir, { recursive: true });
          await session.page.screenshot({ path: path.join(screenshotDir, `scenario-failure-${index}-${step.actor}.png`), fullPage: true }).catch(() => {});
        }
        if (outcome.status === "fail" && !scenario.continueOnFailure) break;
      }
    }
  } finally {
    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
      for (const [actor, session] of sessions) {
        await session.page.screenshot({ path: path.join(screenshotDir, `scenario-final-${actor}.png`), fullPage: true }).catch(() => {});
      }
    }
    await requestPhase(teardown, "teardown");
    for (const { context } of sessions.values()) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  return log.finish();
}

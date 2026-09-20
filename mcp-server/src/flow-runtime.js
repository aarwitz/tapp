// Platform-neutral pieces of Tapp's committed Flow runtime. Drivers own how an
// action reaches a real surface; normalization, variable substitution, marker
// output, and fail-fast semantics stay identical on every platform.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileFlowTasksFromRepository } from "./task-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "../..");

export function normalizeFlowStep(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { action: "noop", target: "", value: "", params: {} };
  if (typeof raw.action === "string") {
    return {
      action: raw.action.toLowerCase(),
      target: String(raw.target ?? raw.field ?? ""),
      value: String(raw.value ?? ""),
      params: raw,
      ...(raw.__tappTask?.name ? { task: raw.__tappTask.name } : {}),
    };
  }
  const entry = Object.entries(raw)[0];
  if (!entry) return { action: "noop", target: "", value: "", params: {} };
  const [key, body] = entry;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return {
      action: key.toLowerCase(),
      target: String(body.target ?? body.field ?? body.of ?? ""),
      value: String(body.value ?? body.contains ?? ""),
      params: body,
      ...(raw.__tappTask?.name ? { task: raw.__tappTask.name } : {}),
    };
  }
  return { action: key.toLowerCase(), target: body === true ? "" : String(body ?? ""), value: body === true ? "" : String(body ?? ""), params: {}, ...(raw.__tappTask?.name ? { task: raw.__tappTask.name } : {}) };
}

// The committed Flow step vocabulary. Every driver (XCUITest, Android, browser) implements exactly
// this table; `tapp flow steps` prints it and `tapp flow validate` rejects anything outside it, so
// a Flow that validates can actually replay (feedback #2: coordinate taps and `click:` used to
// validate and then fail at runtime).
export const FLOW_ACTIONS = Object.freeze([
  { action: "tap", target: "a visible label / accessibility id", passes: "the control was found and tapped; coordinates are not accepted — use the session's tap-by-point to learn the label" },
  { action: "type", target: "{field, value}", passes: "the field was found and now holds the value ($TEST_EMAIL/$TEST_PASSWORD substitute)" },
  { action: "login", target: "{email, password} (defaults to $TEST_EMAIL/$TEST_PASSWORD)", passes: "credentials were entered and submitted and the login form went away" },
  { action: "swipe", target: "up | down | left | right", passes: "the gesture was performed" },
  { action: "back", target: "(none)", passes: "the platform back navigation was performed" },
  { action: "wait", target: "milliseconds (fixed pause; prefer wait_for)", passes: "always" },
  { action: "wait_for", target: "label / text (+ per-step timeoutMs/timeout; flow-level timeoutMs sets the default)", passes: "the element appeared before the timeout" },
  { action: "assert_screen", target: "the detected SCREEN TITLE (navigation bar / heading), not arbitrary text", passes: "the current screen's title equals the target" },
  { action: "assert_exists", target: "label / text", passes: "an element with that text or id is present" },
  { action: "assert_absent", target: "label / text", passes: "no element with that text or id is present" },
  { action: "assert_text", target: "{of, contains}", passes: "the element's text contains the substring" },
  { action: "assert_ai", target: "a natural-language expectation", passes: "the vision judge agrees (needs ANTHROPIC_API_KEY; advisory)" },
]);
const FLOW_ACTION_NAMES = new Set(FLOW_ACTIONS.map((a) => a.action));
const ALIASES = { click: "tap", press: "tap", fill: "type", input: "type", sleep: "wait", wait_for_text: "wait_for", assert_visible: "assert_exists", expect: "assert_exists" };

// Static checks a Flow must pass before any runtime is launched. Returns human-readable errors;
// an empty array means every step is in the vocabulary and shaped so a driver can execute it.
export function validateFlowSteps(flow, platform = inferFlowPlatform(flow)) {
  const errors = [];
  const steps = Array.isArray(flow?.steps) ? flow.steps : [];
  steps.forEach((raw, i) => {
    const step = normalizeFlowStep(raw);
    const n = i + 1;
    if (step.action === "noop") { errors.push(`step ${n}: empty step`); return; }
    if (!FLOW_ACTION_NAMES.has(step.action)) {
      const alias = ALIASES[step.action];
      errors.push(`step ${n}: unknown action '${step.action}'${alias ? ` — did you mean '${alias}'? (web flows use tap:, not click:)` : ""}; run \`tapp flow steps\` for the vocabulary`);
      return;
    }
    if (step.action === "tap" && /^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/.test(step.target)) {
      errors.push(`step ${n}: tap target '${step.target.trim()}' is a coordinate; Flow taps are label-only on ${platform} (use tapp_session_act tap {x,y} to learn the label, then record it)`);
    }
    if (["tap", "wait_for", "assert_screen", "assert_exists", "assert_absent"].includes(step.action) && !step.target.trim()) {
      errors.push(`step ${n}: ${step.action} needs a target`);
    }
    if (step.action === "type" && (!step.target.trim() || !("value" in (step.params || {})))) {
      errors.push(`step ${n}: type needs {field, value}`);
    }
    if (step.action === "assert_text" && (!step.target.trim() || !step.value)) {
      errors.push(`step ${n}: assert_text needs {of, contains}`);
    }
    if (step.action === "swipe" && step.target && !["up", "down", "left", "right"].includes(step.target.trim().toLowerCase())) {
      errors.push(`step ${n}: swipe direction must be up|down|left|right`);
    }
  });
  return errors;
}

export function flowVariables(flow, overrides = {}) {
  return {
    TEST_EMAIL: process.env.OCQA_TEST_EMAIL || "test@example.com",
    TEST_PASSWORD: process.env.OCQA_TEST_PASSWORD || "TestPass123!",
    ...(flow?.vars || {}),
    ...overrides,
  };
}

// Flows created before cross-platform support did not carry `platform`; those
// repository-native files drove XCUITest and remain iOS-only. Treating an
// absent platform as "all" can execute an iOS recording against an unrelated
// web/Android target in a monorepo. Browser URLs are the only safe legacy
// exception because they identify their runtime unambiguously.
export function inferFlowPlatform(flow = {}) {
  const explicit = String(flow.platform || "").trim().toLowerCase();
  if (explicit) return explicit;
  const target = String(flow.url || flow.app || "").trim();
  return /^https?:\/\//i.test(target) ? "web" : "ios";
}

export function substituteFlowValue(value, vars) {
  let out = String(value ?? "");
  // Task outputs can intentionally point at another variable (for example an
  // authenticated email output sourced from $TEST_EMAIL). Resolve a small,
  // bounded chain while preserving unknown placeholders.
  for (let pass = 0; pass < 5; pass += 1) {
    const before = out;
    for (const [key, replacement] of Object.entries(vars || {})) {
      out = out.replaceAll(`$${key}`, String(replacement));
    }
    if (out === before) break;
  }
  return out;
}

export function loadFlowFile(flowPath, options = {}) {
  const helper = path.join(packageRoot, "scripts", "flow_lib.py");
  const parsed = spawnSync("python3", [helper, "to-json", flowPath], { encoding: "utf8" });
  if (parsed.status !== 0) {
    throw new Error((parsed.stderr || parsed.stdout || "Could not parse Flow").trim());
  }
  return compileFlowTasksFromRepository({ flow: JSON.parse(parsed.stdout), sourcePath: flowPath, ...options });
}

export class FlowLog {
  constructor({ logPath, flow }) {
    this.logPath = logPath;
    this.flow = flow;
    this.lines = [];
    this.failed = 0;
    this.executed = 0;
    this.contract = flow.releaseContract?.name || "";
    this.criticality = flow.releaseContract?.criticality || "";
    this.kind = this.contract ? "release-contract" : flow.kind || "flow";
    this.emit(`OCQA_FLOW_RESULT:started total=${flow.steps.length} name=${flow.name || "flow"} kind=${this.kind}${this.contract ? ` contract=${this.contract}` : ""}`);
  }

  emit(line) {
    this.lines.push(line);
    if (this.logPath) {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.appendFileSync(this.logPath, line + "\n");
    }
  }

  step({ index, action, target, status, detail = "", actor = "", task = "" }) {
    this.executed += 1;
    if (status === "fail") this.failed += 1;
    this.emit(`OCQA_FLOW_STEP:${JSON.stringify({ index, action, target, assert: action.startsWith("assert_"), status, detail, ...(actor ? { actor } : {}), ...(task ? { task } : {}), ...(this.contract ? { contract: this.contract } : {}) })}`);
    if (status === "fail") {
      this.emit(`OCQA_ISSUE:${JSON.stringify({
        type: "flow_assertion_failed",
        severity: "high",
        title: `Step ${index} (${action}) failed: ${detail}`,
        screen: actor ? `Scenario actor: ${actor}` : "Flow",
        ...(actor ? { actor } : {}),
        step: index,
      })}`);
    }
  }

  finish(extra = {}) {
    const passed = this.failed === 0 && this.executed > 0;
    // Keep `passed` first for marker consumers that stream-match the payload. `extra` carries
    // run context worth diagnosing from the log alone (e.g. the URL the flow actually opened —
    // field issue #15 was six flows silently replayed against the wrong page).
    this.emit(`OCQA_FLOW_RESULT:${JSON.stringify({ passed, name: this.flow.name || "flow", kind: this.kind, ...(this.contract ? { contract: this.contract, criticality: this.criticality } : {}), total: this.flow.steps.length, executed: this.executed, failed: this.failed, ...extra })}`);
    return { passed, name: this.flow.name || "flow", kind: this.kind, ...(this.contract ? { contract: this.contract, criticality: this.criticality } : {}), total: this.flow.steps.length, executed: this.executed, failed: this.failed, ...extra, logPath: this.logPath, lines: this.lines };
  }
}

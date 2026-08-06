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

  finish() {
    const passed = this.failed === 0 && this.executed > 0;
    // Keep `passed` first for marker consumers that stream-match the payload.
    this.emit(`OCQA_FLOW_RESULT:${JSON.stringify({ passed, name: this.flow.name || "flow", kind: this.kind, ...(this.contract ? { contract: this.contract, criticality: this.criticality } : {}), total: this.flow.steps.length, executed: this.executed, failed: this.failed })}`);
    return { passed, name: this.flow.name || "flow", kind: this.kind, ...(this.contract ? { contract: this.contract, criticality: this.criticality } : {}), total: this.flow.steps.length, executed: this.executed, failed: this.failed, logPath: this.logPath, lines: this.lines };
  }
}

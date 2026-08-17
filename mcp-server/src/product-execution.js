// Shared deterministic execution boundary for customer-facing product operations.
// CLI, MCP, browser, and CI adapters should call this instead of invoking one
// another. The platform scripts remain low-level executors and all evidence is
// written outside the package directory.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileReleaseContract, loadReleaseContractFile } from "./release-contract.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function executionHome() {
  return process.env.TAPP_HOME || path.join(os.homedir(), ".tapp");
}

function atomicJson(destination, value) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, destination);
}

function boundedAppend(value, chunk, maximum = 2 * 1024 * 1024) {
  const next = value + String(chunk || "");
  return next.length > maximum ? next.slice(next.length - maximum) : next;
}

export function runProductProcess(command, args, { cwd, env = process.env, timeoutMs = 900_000, onOutput = () => {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000).unref();
    }, Math.max(1000, Number(timeoutMs) || 900_000));
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout = boundedAppend(stdout, chunk);
      onOutput({ stream: "stdout", text: String(chunk) });
    });
    child.stderr.on("data", (chunk) => {
      stderr = boundedAppend(stderr, chunk);
      onOutput({ stream: "stderr", text: String(chunk) });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: boundedAppend(stderr, error.message), timedOut, error: error.message });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal, stdout, stderr, timedOut });
    });
  });
}

function executionInvocation({ compiledPath, compiled, platform, url, bundleId, appId, apkPath, serial }) {
  if (compiled.kind === "scenario") {
    if (platform !== "web") throw new Error("Isolated multi-actor Scenario replay currently requires the web platform");
    return [process.execPath, [path.join(packageRoot, "scripts", "run-web-scenario.js"), compiledPath, url || compiled.url || compiled.app || ""]];
  }
  if (platform === "web") {
    const targetUrl = url || compiled.url || compiled.app || "";
    if (!targetUrl) throw new Error("Browser contract replay needs an owned URL or managed web target");
    return [process.execPath, [path.join(packageRoot, "scripts", "run-web-flow.js"), compiledPath, targetUrl]];
  }
  if (platform === "android") {
    const targetApp = appId || compiled.app || "";
    if (!targetApp) throw new Error("Android contract replay needs an application id");
    return [process.execPath, [path.join(packageRoot, "scripts", "run-android-flow.js"), compiledPath, targetApp, apkPath || "", serial || ""]];
  }
  const targetApp = bundleId || compiled.app || "";
  if (!targetApp) throw new Error("iOS contract replay needs a bundle id");
  return ["bash", [path.join(packageRoot, "scripts", "run-flow.sh"), compiledPath, targetApp]];
}

export async function executeReleaseContract({
  projectDir,
  contractPath,
  platform,
  url = "",
  bundleId = "",
  appId = "",
  apkPath = "",
  serial = "",
  testEmail,
  testPassword,
  timeout = 600,
  onOutput = () => {},
} = {}) {
  const root = fs.realpathSync(path.resolve(projectDir || process.cwd()));
  const source = path.resolve(root, contractPath || "");
  if (source !== root && !source.startsWith(root + path.sep)) throw new Error("Contract path must remain inside the repository");
  if (!fs.existsSync(source)) throw new Error(`Release contract not found: ${source}`);
  const contract = await loadReleaseContractFile(source);
  const selectedPlatform = String(platform || (contract.platforms.length === 1 ? contract.platforms[0] : "")).toLowerCase();
  if (!["ios", "android", "web"].includes(selectedPlatform)) throw new Error("A concrete ios|android|web platform is required");
  if (!contract.platforms.includes(selectedPlatform)) throw new Error(`Release contract '${contract.name}' does not apply to ${selectedPlatform}`);
  const compiled = compileReleaseContract(contract, { platform: selectedPlatform, sourcePath: source });
  const token = `${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
  const runDir = path.join(executionHome(), "product-execution", token);
  const compiledPath = path.join(runDir, `${contract.name}.json`);
  const logPath = path.join(runDir, "flow.log");
  const evidenceKind = compiled.kind === "scenario" ? "scenario-web" : `flow-${selectedPlatform}`;
  const evidenceDir = path.join(executionHome(), "captures", `${evidenceKind}-${token}`);
  atomicJson(compiledPath, compiled);
  const [command, args] = executionInvocation({ compiledPath, compiled, platform: selectedPlatform, url, bundleId, appId, apkPath, serial });
  const env = {
    ...process.env,
    FLOW_LOG: logPath,
    TAPP_FLOW_EVIDENCE_DIR: evidenceDir,
    ...(typeof testEmail === "string" ? { OCQA_TEST_EMAIL: testEmail } : {}),
    ...(typeof testPassword === "string" ? { OCQA_TEST_PASSWORD: testPassword } : {}),
  };
  const preparation = selectedPlatform === "ios"
    ? await runProductProcess("bash", [path.join(packageRoot, "scripts", "quick-capture.sh"), "build-harness"], {
        cwd: root,
        env,
        timeoutMs: 10 * 60 * 1000,
        onOutput,
      })
    : { code: 0, stdout: "", stderr: "", timedOut: false };
  const result = preparation.code === 0
    ? await runProductProcess(command, args, {
        cwd: root,
        env,
        timeoutMs: Math.max(30, Math.min(3600, Number(timeout) || 600)) * 1000 + 30_000,
        onOutput,
      })
    : preparation;
  let report = "";
  if (compiled.kind === "scenario" && fs.existsSync(logPath)) {
    const rendered = await runProductProcess("python3", [path.join(packageRoot, "scripts", "flow_lib.py"), "report", logPath], { cwd: root, timeoutMs: 30_000, onOutput });
    report = rendered.stdout;
  }
  return {
    passed: result.code === 0,
    code: result.code,
    timedOut: result.timedOut,
    contract: { name: contract.name, title: contract.title, criticality: contract.criticality },
    platform: selectedPlatform,
    kind: compiled.kind,
    deterministicSteps: compiled.steps.length,
    stdout: [preparation.code === 0 ? preparation.stdout : "", result.stdout, report].filter(Boolean).join("\n").trim(),
    stderr: result.stderr.trim(),
    evidence: evidenceDir,
    logPath,
    compiledPath,
  };
}

#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { FlowLog, loadFlowFile } from "../mcp-server/src/flow-runtime.js";
import { distillErrorMessage, runWebFlow } from "../mcp-server/src/web-flow.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flowPath = process.argv[2];
if (!flowPath) {
  console.error("usage: run-web-flow.js <flow.yml|flow.json> [url]");
  process.exit(2);
}
const flow = loadFlowFile(flowPath);
const token = `${process.pid}-${Date.now()}`;
const logPath = process.env.FLOW_LOG || path.join(os.tmpdir(), `tapp-web-flow-${token}.log`);
const screenshotDir = process.env.TAPP_FLOW_EVIDENCE_DIR || path.join(os.tmpdir(), `tapp-web-flow-${token}`);

try {
  const result = await runWebFlow({
    flow,
    url: process.argv[3],
    logPath,
    screenshotDir,
    device: process.env.TAPP_WEB_DEVICE || "",
    viewport: process.env.TAPP_WEB_VIEWPORT || "",
  });
  const report = spawnSync("python3", [path.join(root, "scripts", "flow_lib.py"), "report", logPath], { encoding: "utf8" });
  process.stdout.write((report.stdout || "").trim() + "\n");
  process.exit(result.passed ? 0 : 1);
} catch (error) {
  // A run that dies before step 1 (no browser installed, bad url) still owes a structured
  // report: without one the scoreboard shows an empty row and consumers keep whatever text
  // line they can reach — for a boxed Playwright prompt, its bottom border (field issue #23).
  const cause = distillErrorMessage(error?.message || String(error));
  console.error(`❌ ${cause}`);
  try {
    fs.rmSync(logPath, { force: true });
    const log = new FlowLog({ logPath, flow });
    log.step({ index: 1, action: "harness", target: flow.name || "flow", status: "fail", detail: cause });
    log.finish({ abortReason: cause });
  } catch { /* the console line above is still the answer */ }
  process.exit(2);
}

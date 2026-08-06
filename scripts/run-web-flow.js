#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadFlowFile } from "../mcp-server/src/flow-runtime.js";
import { runWebFlow } from "../mcp-server/src/web-flow.js";

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
  const result = await runWebFlow({ flow, url: process.argv[3], logPath, screenshotDir });
  const report = spawnSync("python3", [path.join(root, "scripts", "flow_lib.py"), "report", logPath], { encoding: "utf8" });
  process.stdout.write((report.stdout || "").trim() + "\n");
  process.exit(result.passed ? 0 : 1);
} catch (error) {
  console.error(`❌ ${error.message || error}`);
  process.exit(2);
}

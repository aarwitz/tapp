#!/usr/bin/env node
// Replay a Flow against a macOS application. Mirrors scripts/run-android-flow.js: the platform
// runner the CLI spawns, so evidence and the log land where every other platform puts them.
import path from "node:path";
import fs from "node:fs";

import { loadFlowFile } from "../mcp-server/src/flow-runtime.js";
import { runMacosFlow } from "../mcp-server/src/macos-flow.js";

const [, , flowPath, appPath = ""] = process.argv;
if (!flowPath) {
  console.error("usage: run-macos-flow.js <flow.yml> [/path/to/App.app]");
  process.exit(2);
}

const evidenceDir = process.env.TAPP_FLOW_EVIDENCE_DIR || "";
if (evidenceDir) fs.mkdirSync(evidenceDir, { recursive: true });

try {
  const flow = loadFlowFile(path.resolve(flowPath));
  const result = await runMacosFlow({
    flow,
    appPath: appPath || flow.app || "",
    logPath: process.env.FLOW_LOG || (evidenceDir ? path.join(evidenceDir, "flow.log") : ""),
    screenshotDir: evidenceDir || "",
  });
  console.log(`${result.passed ? "✅" : "❌"} ${result.name} — ${result.executed}/${result.total} steps, ${result.failed} failed`);
  process.exit(result.passed ? 0 : 1);
} catch (error) {
  console.error(`❌ ${error.message || error}`);
  process.exit(1);
}

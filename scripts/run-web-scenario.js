#!/usr/bin/env node
import path from "node:path";
import { loadScenarioFile, runWebScenario } from "../mcp-server/src/scenario-runtime.js";

const [, , scenarioPath, url] = process.argv;
if (!scenarioPath) {
  console.error("usage: run-web-scenario.js <scenario.yml> [url]");
  process.exit(2);
}

try {
  const scenario = loadScenarioFile(path.resolve(scenarioPath));
  const result = await runWebScenario({
    scenario,
    url,
    logPath: process.env.FLOW_LOG,
    screenshotDir: process.env.TAPP_FLOW_EVIDENCE_DIR,
  });
  process.exit(result.passed ? 0 : 1);
} catch (error) {
  console.error(`Scenario could not run: ${error.message || error}`);
  process.exit(1);
}

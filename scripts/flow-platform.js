#!/usr/bin/env node
// Resolve a Flow's target without executing it. Legacy target-less Flows are
// iOS because that was Tapp's only driver when their format was introduced.
import path from "node:path";
import { inferFlowPlatform, loadFlowFile } from "../mcp-server/src/flow-runtime.js";

const input = process.argv[2] ? path.resolve(process.argv[2]) : "";
if (!input) {
  console.error("usage: flow-platform.js <flow.yml|flow.json>");
  process.exit(2);
}

try {
  process.stdout.write(inferFlowPlatform(loadFlowFile(input)));
} catch (error) {
  console.error(error.message || String(error));
  process.exit(2);
}

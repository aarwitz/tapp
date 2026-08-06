#!/usr/bin/env node
// Expand repository-native Task calls into the shared deterministic Flow JSON
// consumed by every platform driver. No model or customer secret is involved.
import path from "node:path";
import { loadFlowFile } from "../mcp-server/src/flow-runtime.js";

const input = process.argv[2] ? path.resolve(process.argv[2]) : "";
const platform = String(process.argv[3] || "").toLowerCase();
if (!input) {
  console.error("usage: compile-flow.js <flow.yml|flow.json> [ios|android|web]");
  process.exit(2);
}
try {
  process.stdout.write(JSON.stringify(loadFlowFile(input, { platform })));
} catch (error) {
  console.error(error.message || String(error));
  process.exit(2);
}

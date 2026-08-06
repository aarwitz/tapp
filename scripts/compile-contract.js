#!/usr/bin/env node
// Compile one TypeScript release contract for a concrete CI platform. Exit 3
// means the reviewed contract does not apply to this platform and should be
// skipped; every other non-zero exit is a configuration error.
import fs from "node:fs";
import path from "node:path";
import { compileReleaseContract, loadReleaseContractFile } from "../mcp-server/src/release-contract.js";

const [source, platform, output] = process.argv.slice(2);
if (!source || !platform || !output) {
  console.error("usage: compile-contract.js <name.contract.ts> <ios|android|web> <output.json>");
  process.exit(2);
}
try {
  const contract = await loadReleaseContractFile(source);
  if (!contract.platforms.includes(platform)) {
    console.log(`skip ${contract.name}: not applicable to ${platform}`);
    process.exit(3);
  }
  const compiled = compileReleaseContract(contract, { platform, sourcePath: path.resolve(source) });
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(path.resolve(output), JSON.stringify(compiled, null, 2) + "\n");
  console.log(`compiled ${contract.name}: ${compiled.steps.length} deterministic steps`);
} catch (error) {
  console.error(error.message || String(error));
  process.exit(2);
}

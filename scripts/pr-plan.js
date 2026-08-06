#!/usr/bin/env node
// Portable PR planning entrypoint used by the local gate and GitHub Action.
// It never invokes a shell, edits repository artifacts, or guesses ownership.
import fs from "node:fs";
import path from "node:path";
import { buildPrContractPlan, changedFilesFromGit, changedSymbolEvidenceFromGit, prExplorationTargetsFromPlan, readChangedFilesFile } from "../mcp-server/src/pr-selection.js";

const args = { contracts: [], head: "HEAD" };
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[++index];
  if (key === "--project-dir") args.projectDir = value;
  else if (key === "--platform") args.platform = value;
  else if (key === "--base") args.base = value;
  else if (key === "--head") args.head = value;
  else if (key === "--changed-files-file") args.changedFilesFile = value;
  else if (key === "--map") args.mapPath = value;
  else if (key === "--contract") args.contracts.push(value);
  else if (key === "--json-out") args.jsonOut = value;
  else if (key === "--selection-out") args.selectionOut = value;
  else if (key === "--exploration-target-out") args.explorationTargetOut = value;
  else throw new Error(`Unknown argument: ${key}`);
}
if (!args.projectDir || !args.platform || !args.jsonOut) {
  console.error("usage: pr-plan.js --project-dir DIR --platform ios|android|web (--base REF [--head REF] | --changed-files-file FILE) --json-out FILE [--contract FILE ...]");
  process.exit(2);
}
try {
  const changedFiles = args.changedFilesFile
    ? readChangedFilesFile(args.changedFilesFile)
    : changedFilesFromGit({ projectDir: args.projectDir, base: args.base, head: args.head });
  const changedSymbolEvidence = args.changedFilesFile
    ? []
    : changedSymbolEvidenceFromGit({ projectDir: args.projectDir, base: args.base, head: args.head });
  const plan = await buildPrContractPlan({
    projectDir: args.projectDir,
    platform: args.platform,
    changedFiles,
    changedSymbolEvidence,
    mapPath: args.mapPath || "",
    contractPaths: args.contracts,
    discoverContracts: args.contracts.length === 0,
  });
  const output = path.resolve(args.jsonOut);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(plan, null, 2) + "\n");
  if (args.selectionOut) {
    const root = fs.realpathSync(path.resolve(args.projectDir));
    const selectedPaths = plan.selected.map((item) => {
      const candidate = fs.realpathSync(path.resolve(root, item.path));
      if (candidate !== root && !candidate.startsWith(root + path.sep)) throw new Error(`selected contract escapes project directory: ${item.path}`);
      return candidate;
    });
    const selectionOutput = path.resolve(args.selectionOut);
    fs.mkdirSync(path.dirname(selectionOutput), { recursive: true });
    fs.writeFileSync(selectionOutput, JSON.stringify(selectedPaths, null, 2) + "\n");
  }
  if (args.explorationTargetOut) {
    const targetOutput = path.resolve(args.explorationTargetOut);
    fs.mkdirSync(path.dirname(targetOutput), { recursive: true });
    const target = prExplorationTargetsFromPlan(plan, args.platform)[0] || null;
    fs.writeFileSync(targetOutput, JSON.stringify(target, null, 2) + "\n");
  }
  console.log(`PR plan: ${plan.selected.length} selected, ${plan.skipped.length} skipped, ${plan.uncoveredChangedFiles.length} unknown file(s), ${plan.uncoveredUiMap.nodes.length + plan.uncoveredUiMap.edges.length} mapped coverage gap(s)`);
} catch (error) {
  console.error(error.message || String(error));
  process.exit(2);
}

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("Harness/OCQAHarnessUITests/ExplorerTests.swift", "utf8");
const cliSource = fs.readFileSync("bin/tapp.js", "utf8");
const engineSource = fs.readFileSync("mcp-server/src/index.js", "utf8");
const productOperationsSource = fs.readFileSync("mcp-server/src/product-operations.js", "utf8");
const demoSettingsPath = "DemoApp/Sources/SettingsView.swift";
const hasDemoSettingsSource = fs.existsSync(demoSettingsPath);
const demoSettingsSource = hasDemoSettingsSource ? fs.readFileSync(demoSettingsPath, "utf8") : "";
const runFlowSource = fs.readFileSync("scripts/run-flow.sh", "utf8");

test("iOS Flow normalization ignores compiler metadata instead of executing it", () => {
  const normalizer = source.match(/private func normalizeFlowStep[\s\S]*?\n    }\n\n    private func pollUntil/)?.[0] || "";
  assert.match(normalizer, /k\.hasPrefix\("__"\)/);
});

test("iOS Flow evidence preserves reusable Task provenance", () => {
  assert.match(source, /let taskName = \(raw\["__tappTask"\]/);
  assert.match(source, /let taskEvidence = taskName\.isEmpty/);
  assert.match(source, /escapeJSON\(taskName\)/);
});

test("iOS Flow replay refreshes a stale harness cache before execution", () => {
  const flowCommand = cliSource.match(/case "flow":[\s\S]*?case "scenario":/)?.[0] || "";
  assert.match(flowCommand, /ensureIOSHarness\(\)/);
});

test("iOS evidence preserves compiled release-contract identity and criticality", () => {
  assert.match(source, /flow\["releaseContract"\]/);
  assert.match(source, /"release-contract"/);
  assert.match(source, /contractCriticality/);
});

test("iOS PR exploration honors bounded UI Map waits and emits stable target evidence", () => {
  assert.match(source, /routeTimeouts: \[TimeInterval\]/);
  assert.match(source, /tapControlByLabel\(label, timeoutSeconds: directedTimeout\)/);
  assert.match(source, /OCQA_PR_TARGET:/);
  assert.match(source, /OCQA_NAVIGATION_ROOT:/);
});

test("iOS semantic taps try every exact-label match when duplicate SwiftUI controls exist", () => {
  assert.match(source, /let exactMatches = .*allElementsBoundByIndex/);
  assert.match(source, /for match in exactMatches where tryTap\(match\)/);
  assert.match(source, /let containsMatches = .*allElementsBoundByIndex/);
  assert.match(source, /if existedButNotHittable \{/);
  assert.match(source, /for _ in 0\.\.<3/);
});

test("iOS root normalization emits the real launch-sheet transition for map grounding", () => {
  const normalization = source.match(/private func navigateToRootScreen[\s\S]*?OCQA_STATE:navigated_to_root/)?.[0] || "";
  assert.match(normalization, /reason\\":\\"launch_sheet_dismiss/);
  assert.match(normalization, /OCQA_TRANSITION_RESOLVED:/);
  assert.match(normalization, /from\\":\\".*preTitle/);
  assert.match(normalization, /to\\":\\".*postTitle/);
});

test("init carries successful Xcode build evidence into both CLI and MCP application models", () => {
  assert.match(engineSource, /kind: "xcode-build-installed"/);
  assert.match(engineSource, /targetValidation: \{/);
  assert.match(productOperationsSource, /targetValidation: exploration\?\.targetValidation \|\| null/);
  assert.match(cliSource, /initializeProductProject/);
  assert.match(engineSource, /initializeProductProject/);
});

test("the native benchmark fault is explicit and disabled in ordinary DemoApp runs", { skip: !hasDemoSettingsSource }, () => {
  assert.match(demoSettingsSource, /environment\["TAPP_SEEDED_FAULT"\] == "hide-update-profile"/);
  assert.match(demoSettingsSource, /if !hidesUpdateProfileForSeededBenchmark/);
});

test("iOS deterministic Flow replay receives the same bounded launch arguments and environment as QA", () => {
  assert.match(runFlowSource, /os\.environ\.get\("OCQA_APP_LAUNCH_ARGS_JSON"/);
  assert.match(runFlowSource, /d\["OCQA_APP_LAUNCH_ARGS"\] = value/);
  assert.match(runFlowSource, /os\.environ\.get\("OCQA_APP_LAUNCH_ENV_JSON"/);
  assert.match(runFlowSource, /d\["OCQA_APP_LAUNCH_ENV"\] = value/);
  assert.match(runFlowSource, /JSON object with string values/);
});

test("iOS exploration maps a terminal tab sweep instead of leaving its destination disconnected", () => {
  assert.match(source, /pendingTransitionFrom = \(title: titleStr, actionKey: key, hash: stateHash\)\s+target\.tap\(\)/);
  assert.match(source, /Resolve exactly one outstanding terminal transition/);
  assert.match(source, /if let pending = pendingTransitionFrom, app\.state == \.runningForeground/);
  assert.match(source, /knownTransitions\["\\\(pending\.title\)\|\\\(pending\.actionKey\)"\] = terminalTitle/);
  assert.match(source, /OCQA_STATE:.*terminalTitle.*terminalControlsJSON/);
});

test("directed iOS PR exploration keeps its bounded budget on the selected surface", () => {
  assert.match(source, /if targetScreen\.isEmpty && !tabSweepDone && app\.state == \.runningForeground/);
  assert.match(source, /Directed PR exploration has already spent a reviewed map path/);
});

test("autonomous iOS QA starts from a fresh launch with the configured environment", () => {
  const autonomous = source.match(/func testAutonomousExploration\(\) \{[\s\S]*?let maxActions = self\.maxActions/)?.[0] || "";
  assert.match(autonomous, /app\.terminate\(\)/);
  assert.match(autonomous, /app\.launchArguments = appLaunchArgs/);
  assert.match(autonomous, /app\.launchEnvironment = appLaunchEnv/);
  assert.match(autonomous, /app\.launch\(\)/);
  assert.match(autonomous, /controlled-state run/);
});

test("iOS exploration records structural transitions even when the visible title is unchanged", () => {
  assert.match(source, /pendingTransitionFrom: \(title: String, actionKey: String, hash: String\)\?/);
  assert.match(source, /if pending\.hash != stateHash/);
  assert.match(source, /fromHash.*pending\.hash.*toHash.*stateHash/);
  assert.match(source, /if pending\.hash != terminalHash/);
});

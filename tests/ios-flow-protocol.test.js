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
const quickCaptureSource = fs.readFileSync("scripts/quick-capture.sh", "utf8");

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

test("iOS exploration attaches the true launch surface before root normalization", () => {
  const launchEvidence = source.match(/Record the TRUE initial screen[\s\S]*?navigateToRootScreen\(actionCount:/)?.[0] || "";
  assert.match(launchEvidence, /XCTAttachment\(screenshot: initialScreenshot\)/);
  assert.match(launchEvidence, /state_0_/);
  assert.match(launchEvidence, /add\(initialAttachment\)/);
});

test("native progress calls structural states what they are", () => {
  assert.match(cliSource, /structural states observed/);
  assert.match(engineSource, /structural states observed/);
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

test("iOS loop detection requires a cycle across distinct structural states", () => {
  assert.match(source, /Set\(recent\.suffix\(2\)\)\.count == 2/);
  assert.match(source, /Set\(recent\.suffix\(3\)\)\.count == 3/);
  assert.match(source, /Set\(recentScreenTitles\.suffix\(2\)\)\.count == 2/);
  assert.match(source, /Set\(recentScreenTitles\.suffix\(3\)\)\.count == 3/);
});

test("iOS unresponsive findings come from confirmed control taps, not recovery streaks", () => {
  assert.doesNotMatch(source, /title\":\"Unresponsive UI\".*repeated_state_count/);
  assert.match(source, /Control may be unresponsive/);
  assert.match(source, /contentSignature\(post2\) == preContentSig/);
});

test("iOS recovery does not spend a second action after exhausting the requested budget", () => {
  const exhaustedBackRecovery = source.match(/Back didn't change screens[\s\S]*?Stuck on this screen/)?.[0] || "";
  assert.match(exhaustedBackRecovery, /if actionCount >= maxActions \{ break \}/);
  const deadEndRecovery = source.match(/tryGoBack does swipe-down[\s\S]*?Swipe right \(back gesture\)/)?.[0] || "";
  assert.match(deadEndRecovery, /if actionCount >= maxActions \{ break \}/);
});

test("iOS exploration ends a successful sign-in/sign-out cycle without false persistence or trap findings", () => {
  const authCycle = source.match(/Signing out after a successful login[\s\S]*?Persistence probe/)?.[0] || "";
  assert.match(authCycle, /authSucceeded && detectedInputs\.contains\(where: \{ \$0\.secure \}\)/);
  assert.match(authCycle, /OCQA_STATE:auth_cycle_complete/);
  assert.match(authCycle, /break/);
});

test("iOS hang detection excludes determinate progress bars", () => {
  const loadingDetector = source.match(/private func hasIndeterminateLoadingIndicator[\s\S]*?\n    \}/)?.[0] || "";
  assert.match(loadingDetector, /activityIndicators\.allElementsBoundByIndex/);
  assert.match(loadingDetector, /indicator\.value as\? String/);
  assert.match(loadingDetector, /value\.isEmpty.*value == "in progress".*value == "loading"/);
  assert.match(source, /if screenVisitCount\[titleStr\].*hasIndeterminateLoadingIndicator\(\)/s);
});

test("iOS exploration does not call an exhausted internal candidate pool a user-visible dead end", () => {
  assert.doesNotMatch(source, /issues\.append\(\(type: "dead_end"/);
  assert.match(source, /only the stronger navigation-trap path below emits a finding/);
});

test("iOS unconditional launch crashes are classified before the outer watchdog timeout", () => {
  assert.match(quickCaptureSource, /simctl launch.*APP_BUNDLE/);
  assert.match(quickCaptureSource, /kill -0.*PREFLIGHT_PID/);
  assert.match(quickCaptureSource, /OCQA_ISSUE:.*App crashed during launch preflight/);
  assert.match(quickCaptureSource, /severity.*critical/);
  assert.match(quickCaptureSource, /configured launch args\/env skip this probe/i);
});

test("iOS caller time-budget exhaustion is partial evidence, not an app defect", () => {
  assert.match(quickCaptureSource, /time budget; evidence is partial/);
  assert.match(quickCaptureSource, /\\\"timedOut\\\":true/);
  assert.doesNotMatch(quickCaptureSource, /OCQA_ISSUE:.*explore_timeout/);
});

test("iOS blank detection uses semantic content rather than raw container count", () => {
  assert.match(source, /let visibleTextInventory = visionTextInventory\(elements\)/);
  assert.match(source, /let contentInteractables = interactable\.filter/);
  assert.match(source, /!isNavBackButton\(\$0\)/);
  assert.match(source, /if visibleTextInventory\.isEmpty && contentInteractables\.isEmpty/);
  assert.doesNotMatch(source, /if elements\.count < 5 && interactable\.count == 0/);
});

test("iOS in-run crash detection records a terminated process even when relaunch succeeds", () => {
  const earlyCrashCheck = source.match(/Early crash check[\s\S]*?After a submit\/login tap/)?.[0] || "";
  assert.match(earlyCrashCheck, /let stateAfterAction = app\.state/);
  assert.match(earlyCrashCheck, /stateAfterAction == \.notRunning/);
  assert.match(earlyCrashCheck, /issues\.append\(\(type: "crash", severity: "critical"/);
  assert.match(earlyCrashCheck, /app\.activate\(\)/);
  assert.ok(
    earlyCrashCheck.indexOf("stateAfterAction == .notRunning") < earlyCrashCheck.indexOf("app.activate()"),
    "the original process termination must be recorded before recovery can mask it",
  );
});

test("iOS field-persistence findings agree with the completed issue count", () => {
  const persistenceDetector = source.match(/for \(memKey, typed\) in typedFieldMemory[\s\S]*?Keyboard occlusion/)?.[0] || "";
  assert.match(persistenceDetector, /issues\.append\(\(type: "state_persistence", severity: "medium"/);
  assert.match(persistenceDetector, /OCQA_ISSUE:.*state_persistence/);
  assert.ok(
    persistenceDetector.indexOf('issues.append((type: "state_persistence"') < persistenceDetector.indexOf("OCQA_ISSUE:"),
    "the completion counter must be updated before the public issue marker is emitted",
  );
});

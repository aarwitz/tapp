import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const action = fs.readFileSync(new URL("../action.yml", import.meta.url), "utf8");
const ciWorkflow = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const exampleWorkflow = fs.readFileSync(new URL("../.github/workflows/autotap-gate-example.yml", import.meta.url), "utf8");

function shellBodies(yaml) {
  const lines = yaml.split("\n");
  const bodies = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(\s*)run:\s*\|\s*$/);
    if (!match) continue;
    const indent = match[1].length;
    const body = [];
    for (i += 1; i < lines.length; i += 1) {
      const lineIndent = (lines[i].match(/^(\s*)/) || ["", ""])[1].length;
      if (lines[i].trim() && lineIndent <= indent) {
        i -= 1;
        break;
      }
      body.push(lines[i]);
    }
    bodies.push(body.join("\n"));
  }
  return bodies;
}

test("composite Action does not interpolate inputs into shell source", () => {
  for (const body of shellBodies(action)) {
    assert.doesNotMatch(body, /\$\{\{\s*inputs\./);
  }
});

test("nested third-party Actions are pinned to full commit SHAs", () => {
  const nestedUses = [...action.matchAll(/^\s+uses:\s+([^#\s]+)(?:\s+#.*)?$/gm)].map((m) => m[1]);
  assert.ok(nestedUses.length >= 2);
  for (const use of nestedUses) {
    assert.match(use, /^[^@]+@[a-f0-9]{40}$/);
  }
});

test("Action owns the automatic baseline lifecycle", () => {
  assert.match(action, /uses: actions\/cache\/restore@[a-f0-9]{40}/);
  assert.match(action, /uses: actions\/cache\/save@[a-f0-9]{40}/);
  assert.match(action, /uses: actions\/download-artifact@[a-f0-9]{40}/);
  assert.match(action, /name: tapp-baseline/);
  assert.match(action, /retention-days: 90/);
  assert.match(action, /baseline-source:[\s\S]*?value:\s*\$\{\{ steps\.baseline\.outputs\.source \}\}/);
  assert.match(action, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.match(action, /steps\.gate\.outputs\.gate_failed == 'false'/);
  assert.match(action, /r\.get\("inconclusive"\).*r\.get\("verdict"\) == "blocked"/);
});

test("Action isolates writable runtime data and exposes CI controls", () => {
  assert.match(action, /AUTOTAP_HOME=\$RUNNER_TEMP\/tapp-home/);
  assert.match(action, /TAPP_INPUT_TIMEOUT: \$\{\{ inputs\.timeout \}\}/);
  assert.match(action, /--timeout "\$TAPP_INPUT_TIMEOUT"/);
  assert.match(action, /bundle-id:[\s\S]*?required: false/);
  assert.match(action, /platform:[\s\S]*?default: "ios"/);
  assert.match(action, /android-app-id:/);
  assert.match(action, /TAPP_INPUT_PLATFORM: \$\{\{ inputs\.platform \}\}/);
  assert.match(action, /--platform "\$TAPP_INPUT_PLATFORM"/);
  assert.match(action, /target-key:[\s\S]*?default: "default"/);
  assert.match(action, /tapp-baseline-v3-\$\{\{ inputs\.platform \}\}-\$\{\{ steps\.target\.outputs\.key \}\}/);
  assert.match(action, /name: tapp-baseline-\$\{\{ inputs\.platform \}\}-\$\{\{ steps\.target\.outputs\.key \}\}/);
  assert.match(action, /--target-key "\$TAPP_INPUT_TARGET_KEY"/);
  assert.match(action, /name: tapp-evidence-\$\{\{ inputs\.platform \}\}-\$\{\{ steps\.target\.outputs\.key \}\}/);
  assert.match(action, /autotap-release-check:\$\{process\.env\.TAPP_TARGET_KEY\}/);
  assert.match(action, /scenarios:[\s\S]*?TAPP_INPUT_SCENARIOS: \$\{\{ inputs\.scenarios \}\}/);
  assert.match(action, /--scenarios "\$TAPP_INPUT_SCENARIOS"/);
  assert.match(action, /pr-selection:[\s\S]*?default: "true"/);
  assert.match(action, /github\.paginate\(github\.rest\.pulls\.listFiles/);
  assert.match(action, /file\.previous_filename/);
  assert.match(action, /typeof file\.patch === 'string'/);
  assert.match(action, /patch: file\.patch/);
  assert.doesNotMatch(action, /JSON\.stringify\(\[\.\.\.new Set\(files\.flatMap/);
  assert.match(action, /--changed-files-file "\$TAPP_PR_CHANGED_FILES_PATH" --pr-plan-out "\$PR_PLAN"/);
  assert.match(action, /\$\{\{ runner\.temp \}\}\/tapp-pr-plan\.json/);
  assert.doesNotMatch(action, /npm install[^\n]*playwright/);
  assert.doesNotMatch(action, /npm exec[^\n]*playwright/);
  assert.match(action, /node "\$TAPP_ACTION_PATH\/node_modules\/playwright\/cli\.js" install chromium/);
  assert.match(action, /No Gradle wrapper found; commit gradlew or pass a prebuilt app-path/);
  assert.doesNotMatch(action, /command -v gradle/);
  assert.match(action, /APK_ROOT="\$PROJECT_DIR\/\$MODULE_REL\/build\/outputs\/apk"/);
  assert.match(action, /multiple APKs; pass the intended artifact with app-path/);
});

test("repository CI exercises the public composite Action on every supported platform", () => {
  for (const job of ["action-ios", "action-web", "android-corpus"]) {
    assert.match(ciWorkflow, new RegExp(`\\n  ${job}:[\\s\\S]*?\\n      - name: Exercise the published`));
  }
  assert.match(ciWorkflow, /name: Exercise the published iOS Action path[\s\S]*?uses: \.\/[\s\S]*?platform: ios/);
  assert.match(ciWorkflow, /name: Exercise the published web Action path[\s\S]*?uses: \.\/[\s\S]*?platform: web/);
  assert.match(ciWorkflow, /name: Exercise the published web Action path[\s\S]*?web-target: SocialDemo/);
  assert.doesNotMatch(ciWorkflow, /Start the owned SocialDemo target/);
  assert.match(ciWorkflow, /name: Exercise the published Android Action path[\s\S]*?uses: \.\/[\s\S]*?platform: android/);
  assert.match(ciWorkflow, /name: Exercise the published Android Action path[\s\S]*?android-project: AndroidCorpus[\s\S]*?android-task: ":logindemo:assembleDebug"/);
  assert.doesNotMatch(ciWorkflow, /name: Exercise the published Android Action path[\s\S]*?app-path: AndroidCorpus\/logindemo/);
  assert.match(ciWorkflow, /SocialDemo\/\.autotap\/contracts\/\*\.contract\.ts/);
  assert.match(ciWorkflow, /DemoApp\/\.autotap\/contracts\/\*\.contract\.ts/);
  assert.match(ciWorkflow, /AndroidCorpus\/logindemo\/\.autotap\/contracts\/\*\.contract\.ts/);
});

test("repository workflows pin every third-party Action to a full commit SHA", () => {
  for (const workflow of [ciWorkflow, exampleWorkflow]) {
    const uses = [...workflow.matchAll(/^\s+- uses:\s+([^#\s]+)(?:\s+#.*)?$/gm)].map((match) => match[1]);
    assert.ok(uses.length > 0);
    for (const value of uses) {
      if (value.startsWith("./")) continue;
      assert.match(value, /^[^@]+@[a-f0-9]{40}$/);
    }
  }
});

test("repository CI rejects high-severity production dependency advisories", () => {
  assert.match(ciWorkflow, /npm audit --omit=dev --audit-level=high/);
});

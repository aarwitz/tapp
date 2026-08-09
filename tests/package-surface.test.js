import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));

test("npm package exposes Tapp as its only current product identity", () => {
  assert.equal(pkg.name, "@aarwitz/tapp");
  assert.deepEqual(pkg.bin, { tapp: "bin/tapp.js" });

  for (const file of ["README.md", "AGENTS.md", "SECURITY.md", "server.json", "mcp-server/README.md"]) {
    assert.doesNotMatch(read(file), /\bAutoTap\b/, file);
    assert.doesNotMatch(read(file), /\bruntapp\b|\btapp-mcp\b/i, file);
  }
});

test("npm package ships only the runtime script allowlist", () => {
  assert.equal(pkg.files.includes("scripts/"), false);
  assert.deepEqual(
    pkg.files.filter((entry) => entry.startsWith("scripts/")).sort(),
    [
      "scripts/ci-gate.sh",
      "scripts/compile-contract.js",
      "scripts/compile-flow.js",
      "scripts/flow-platform.js",
      "scripts/flow_ai_judge.py",
      "scripts/flow_lib.py",
      "scripts/platform-gate.js",
      "scripts/pr-plan.js",
      "scripts/quick-capture.sh",
      "scripts/run-android-flow.js",
      "scripts/run-flow.sh",
      "scripts/run-web-flow.js",
      "scripts/run-web-scenario.js",
    ].sort(),
  );
});

test("shipped native fixtures use Tapp labels and identifiers", () => {
  const demo = [
    read("DemoApp/Info.plist"),
    read("DemoApp/DemoApp.xcodeproj/project.pbxproj"),
    read("DemoApp/Sources/AboutView.swift"),
    read("DemoApp/Sources/WhatsNewView.swift"),
    read("DemoApp/.autotap/application-model.json"),
    read("DemoApp/.autotap/ui-map.json"),
    read("DemoApp/.autotap/flows/menu-to-daily-summary.yml"),
    read("DemoApp/.autotap/contracts/onboarding-summary.contract.ts"),
    read(".autotap/flows/demoapp-smoke.yml"),
  ].join("\n");
  const harness = [
    read("Harness/OCQAHarness.xcodeproj/project.pbxproj"),
    read("Harness/generate-harness-xcodeproj.rb"),
  ].join("\n");

  assert.doesNotMatch(demo, /com\.autotap\.demoapp|\bAutoTap\b/);
  assert.doesNotMatch(harness, /autotap/i);
  assert.match(demo, /io\.github\.aarwitz\.tapp\.demoapp/);
  assert.match(harness, /io\.github\.aarwitz\.tapp\.harness/);
});

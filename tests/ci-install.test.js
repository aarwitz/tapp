import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderGithubWorkflow, writeCiInstallation, writeTargetBaseline } from "../mcp-server/src/ci-setup.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-ci-install-"));
  fs.mkdirSync(path.join(root, ".tapp", "contracts"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), "<main>site</main>");
  fs.writeFileSync(path.join(root, ".tapp", "contracts", "checkout.contract.ts"), "fixture");
  const target = { id: "target_web_store", platform: "web", name: "Store", sourcePath: ".", status: "configured", build: { tool: "static-files", dependencyStatus: "not-required" }, runtime: { management: "tapp-managed" } };
  const model = {
    kind: "tapp-application-model", targets: [target], actors: [{ credentialRequirements: ["email", "password"] }],
    artifacts: { contracts: [{ name: "checkoutWorks", path: ".tapp/contracts/checkout.contract.ts", scope: ".", platforms: ["web"] }] },
  };
  return { root, model, target };
}

test("CI installation renders one target-aware keyless web gate without shell interpolation", () => {
  const { root, model } = fixture();
  const rendered = renderGithubWorkflow({ projectDir: root, model, actionRef: "aarwitz/tapp@v0.13.1" });
  assert.equal(rendered.manifest.status, "ready-for-review");
  assert.equal(rendered.manifest.targets[0].inputs["target-key"], "target_web_store");
  assert.equal(rendered.manifest.targets[0].inputs["web-target"], "target_web_store");
  assert.equal(rendered.manifest.targets[0].inputs.contracts, ".tapp/contracts/checkout.contract.ts");
  assert.equal(rendered.manifest.targets[0].inputs["test-email"], "${{ secrets.TAPP_TEST_EMAIL }}");
  assert.match(rendered.workflow, /uses: actions\/checkout@[a-f0-9]{40}/);
  assert.match(rendered.workflow, /uses: aarwitz\/tapp@v0\.13\.1/);
  assert.match(rendered.workflow, /web-target: "target_web_store"/);
  assert.doesNotMatch(rendered.workflow, /run:[\s\S]*\$\{\{ secrets\.TAPP_TEST_EMAIL/);
});

test("CI installation wires an accepted target-specific baseline and refuses silent overwrite", () => {
  const { root, model, target } = fixture();
  writeTargetBaseline({ projectDir: root, target, report: { platform: "web", targetKey: target.id, verdict: "ready", inconclusive: false, findings: [], screens: ["Home"], gate: { failed: false }, contracts: [{ passed: true }] } });
  const rendered = renderGithubWorkflow({ projectDir: root, model, actionRef: "aarwitz/tapp@v0.13.1" });
  assert.equal(rendered.manifest.targets[0].baseline, ".tapp/baselines/web/target_web_store.json");
  assert.match(rendered.workflow, /baseline: "\.tapp\/baselines\/web\/target_web_store\.json"/);
  const installed = writeCiInstallation({ projectDir: root, ...rendered });
  assert.equal(fs.existsSync(installed.workflowPath), true);
  assert.equal(JSON.parse(fs.readFileSync(installed.manifestPath, "utf8")).kind, "tapp-ci-installation");
  assert.throws(() => writeCiInstallation({ projectDir: root, ...rendered }), /never overwrites/);
});

test("CI installation reports unresolved native configuration instead of inventing it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-ci-install-native-"));
  fs.writeFileSync(path.join(root, "gradlew"), "#!/bin/sh\n");
  const model = { kind: "tapp-application-model", actors: [], artifacts: { contracts: [] }, targets: [
    { id: "target_ios_app", platform: "ios", name: "App", sourcePath: "App.xcodeproj", status: "needs-confirmation", build: { container: "App.xcodeproj", proposedScheme: "App" }, runtime: {} },
    { id: "target_android_app", platform: "android", name: "app", sourcePath: "app", status: "needs-confirmation", build: { projectDir: ".", task: ":app:assembleDebug" }, runtime: {} },
  ] };
  const rendered = renderGithubWorkflow({ projectDir: root, model, actionRef: "aarwitz/tapp@v0.13.1" });
  assert.equal(rendered.manifest.status, "requires-configuration");
  assert.deepEqual(rendered.manifest.unresolved.map((item) => item.message).sort(), ["Android application id is unknown", "shared iOS scheme has not been validated"]);
  assert.match(rendered.workflow, /Start Android API 35 emulator/);
});

test("CI installation scopes module contracts and credentials to the matching Android target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-ci-install-android-workspace-"));
  fs.writeFileSync(path.join(root, "gradlew"), "#!/bin/sh\n");
  const model = {
    kind: "tapp-application-model",
    actors: [{ name: "customer", configured: false, contracts: ["loginWorks"], credentialRequirements: ["email", "password"], credentialBindings: { email: "LOGIN_EMAIL", password: "LOGIN_PASSWORD" } }],
    artifacts: { contracts: [{ name: "loginWorks", path: "login/.tapp/contracts/login.contract.ts", scope: "login", platforms: ["android"] }] },
    targets: [
      { id: "target_login", platform: "android", name: "login", sourcePath: "login", status: "configured", build: { projectDir: ".", task: ":login:assembleDebug" }, runtime: { applicationId: "com.example.login" } },
      { id: "target_shop", platform: "android", name: "shop", sourcePath: "shop", status: "configured", build: { projectDir: ".", task: ":shop:assembleDebug" }, runtime: { applicationId: "com.example.shop" } },
    ],
  };
  const rendered = renderGithubWorkflow({ projectDir: root, model, actionRef: "aarwitz/tapp@v0.13.1" });
  const login = rendered.manifest.targets.find((target) => target.id === "target_login");
  const shop = rendered.manifest.targets.find((target) => target.id === "target_shop");
  assert.deepEqual(login.contracts, ["login/.tapp/contracts/login.contract.ts"]);
  assert.deepEqual(login.requiredSecrets, ["LOGIN_EMAIL", "LOGIN_PASSWORD"]);
  assert.equal(login.inputs["test-email"], "${{ secrets.LOGIN_EMAIL }}");
  assert.deepEqual(shop.contracts, []);
  assert.deepEqual(shop.requiredSecrets, []);
  assert.equal(Object.hasOwn(shop.inputs, "test-email"), false);
  assert.equal(rendered.manifest.status, "ready-for-review");
});

test("CI installation does not leak one shared actor's credentials into unrelated target contracts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-ci-install-shared-actor-"));
  fs.writeFileSync(path.join(root, "gradlew"), "#!/bin/sh\n");
  const model = {
    kind: "tapp-application-model",
    actors: [{ name: "customer", contracts: ["settingsWorks", "loginWorks"], credentialRequirements: ["email", "password"], credentialBindings: { email: "LOGIN_EMAIL", password: "LOGIN_PASSWORD" } }],
    artifacts: { contracts: [
      { name: "settingsWorks", path: "demo/.tapp/contracts/settings.contract.ts", scope: "demo", platforms: ["android"], actors: [{ name: "customer", session: "default", credentialRequirements: [], credentialBindings: {} }] },
      { name: "loginWorks", path: "login/.tapp/contracts/login.contract.ts", scope: "login", platforms: ["android"], actors: [{ name: "customer", session: "default", credentialRequirements: ["email", "password"], credentialBindings: { email: "LOGIN_EMAIL", password: "LOGIN_PASSWORD" } }] },
    ] },
    targets: [
      { id: "target_demo", platform: "android", name: "demo", sourcePath: "demo", status: "configured", build: { projectDir: ".", task: ":demo:assembleDebug" }, runtime: { applicationId: "com.example.demo" } },
      { id: "target_login", platform: "android", name: "login", sourcePath: "login", status: "configured", build: { projectDir: ".", task: ":login:assembleDebug" }, runtime: { applicationId: "com.example.login" } },
    ],
  };
  const rendered = renderGithubWorkflow({ projectDir: root, model, actionRef: "aarwitz/tapp@v0.13.1" });
  const demo = rendered.manifest.targets.find((target) => target.id === "target_demo");
  const login = rendered.manifest.targets.find((target) => target.id === "target_login");
  assert.deepEqual(demo.requiredSecrets, []);
  assert.equal(Object.hasOwn(demo.inputs, "test-email"), false);
  assert.deepEqual(login.requiredSecrets, ["LOGIN_EMAIL", "LOGIN_PASSWORD"]);
  assert.equal(login.inputs["test-email"], "${{ secrets.LOGIN_EMAIL }}");
});

test("CI installation refuses to present an unpinned system Gradle build as ready", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-ci-install-no-wrapper-"));
  const model = { kind: "tapp-application-model", actors: [], artifacts: { contracts: [] }, targets: [
    { id: "target_android", platform: "android", name: "app", sourcePath: ".", status: "configured", build: { projectDir: ".", task: ":assembleDebug" }, runtime: { applicationId: "com.example.app" } },
  ] };
  const rendered = renderGithubWorkflow({ projectDir: root, model, actionRef: "aarwitz/tapp@v0.13.1" });
  assert.equal(rendered.manifest.status, "requires-configuration");
  assert.match(rendered.manifest.unresolved[0].message, /Gradle wrapper is missing/);
});

test("CI installation refuses to hide blocking application-model requirements", () => {
  const { root, model } = fixture();
  model.requirements = [{ id: "ui-map", severity: "blocking", status: "missing", message: "No repository UI Map has been grounded in a real run.", remediation: "Explore the real target before installing CI." }];
  const rendered = renderGithubWorkflow({ projectDir: root, model, actionRef: "aarwitz/tapp@v0.13.1" });
  assert.equal(rendered.manifest.status, "requires-configuration");
  assert.deepEqual(rendered.manifest.unresolved[0], {
    targetId: "application-model",
    platform: "repository",
    message: "No repository UI Map has been grounded in a real run. Next: Explore the real target before installing CI.",
  });
});

test("CI installation maps actor-specific environment bindings to GitHub secrets without values", () => {
  const { root, model } = fixture();
  model.actors = [
    { name: "alice", session: "isolated", credentialRequirements: ["email", "password"], credentialBindings: { email: "ALICE_EMAIL", password: "ALICE_PASSWORD" } },
    { name: "bob", session: "isolated", credentialRequirements: ["email", "password"], credentialBindings: { email: "BOB_EMAIL", password: "BOB_PASSWORD" } },
  ];
  const rendered = renderGithubWorkflow({ projectDir: root, model, actionRef: "aarwitz/tapp@v0.13.1" });
  assert.equal(rendered.manifest.targets[0].inputs["test-email"], "${{ secrets.ALICE_EMAIL }}");
  assert.deepEqual(rendered.manifest.targets[0].requiredSecrets, ["ALICE_EMAIL", "ALICE_PASSWORD", "BOB_EMAIL", "BOB_PASSWORD"]);
  assert.deepEqual(rendered.manifest.security.secrets, ["ALICE_EMAIL", "ALICE_PASSWORD", "BOB_EMAIL", "BOB_PASSWORD"]);
  assert.match(rendered.workflow, /env:\n          ALICE_EMAIL: "\$\{\{ secrets\.ALICE_EMAIL \}\}"/);
  assert.match(rendered.workflow, /BOB_PASSWORD: "\$\{\{ secrets\.BOB_PASSWORD \}\}"/);
  assert.doesNotMatch(rendered.workflow, /alice@example|password-value/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generateProductPlan,
  initializeProductProject,
  prepareProductCi,
  prepareProductTarget,
  readProductProject,
  reviewProductPlan,
  runProductGate,
} from "../mcp-server/src/product-operations.js";
import { buildUiMapFromMarkers, writeUiMap } from "../mcp-server/src/ui-map.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-product-operations-"));
  fs.writeFileSync(path.join(root, "index.html"), "<h1>Home</h1><button id='settings'>Settings</button>");
  fs.mkdirSync(path.join(root, ".tapp", "tasks"), { recursive: true });
  const markers = path.join(root, "markers.txt");
  fs.writeFileSync(markers, [
    'OCQA_NAVIGATION_ROOT:{"screen":"Home","role":"screen","controls":[{"kind":"button","label":"Settings","cssId":"settings"}]}',
    'OCQA_STATE:{"screen":"Home","role":"screen","controls":[{"kind":"button","label":"Settings","cssId":"settings"}]}',
    'OCQA_ACTION:{"type":"tap","target":"label:Settings","screen":"Home"}',
    'OCQA_TRANSITION:{"from":"Home","to":"Settings","action":"label:Settings"}',
    'OCQA_STATE:{"screen":"Settings","role":"settings","controls":[]}',
  ].join("\n") + "\n");
  const map = buildUiMapFromMarkers({ markersPath: markers, platform: "web", target: "http://127.0.0.1:1", runId: "operation-test" });
  writeUiMap(path.join(root, ".tapp", "ui-map.json"), map);
  const home = map.nodes.find((node) => node.semanticKey === "home");
  const settings = map.nodes.find((node) => node.semanticKey === "settings");
  const edge = map.edges.find((item) => item.from === home.id && item.to === settings.id);
  fs.writeFileSync(path.join(root, ".tapp", "tasks", "open-settings.yml"), `kind: task
version: 1
name: openSettings
description: Open settings from the observed home screen.
preconditions:
  - screen: Home
postconditions:
  - screen: Settings
implementations:
  web:
    steps:
      - tap: Settings
      - wait_for: Settings
coverage:
  nodes: [${JSON.stringify(home.id)}, ${JSON.stringify(settings.id)}]
  edges: [${JSON.stringify(edge.id)}]
`);
  return root;
}

test("shared product operations own inspect, review, generation, snapshot, and CI preview semantics", async () => {
  const root = fixture();
  const initialized = await initializeProductProject({ projectDir: root, mode: "write", platform: "web" });
  assert.equal(initialized.project.state.inspected, true);
  assert.equal(initialized.model.uiMap.status, "observed");
  const proposal = initialized.plan.items.find((item) => item.name === "openSettingsWorks");
  assert.ok(proposal, "a reusable Task becomes a reviewable business-contract proposal");

  const reviewed = reviewProductPlan({ projectDir: root, approve: [proposal.id], defer: initialized.plan.items.filter((item) => item.id !== proposal.id).map((item) => item.id) });
  assert.equal(reviewed.plan.items.find((item) => item.id === proposal.id).decision, "approved");
  const generated = await generateProductPlan({ projectDir: root });
  assert.equal(generated.generated.some((item) => item.name === "openSettingsWorks"), true);
  assert.equal(fs.existsSync(path.join(root, generated.generated.find((item) => item.name === "openSettingsWorks").path)), true);

  const snapshot = readProductProject({ projectDir: root });
  assert.equal(snapshot.state.generated, true);
  assert.equal(snapshot.map.nodes.length, 2);
  const ci = prepareProductCi({ projectDir: root, actionRef: "aarwitz/tapp@0123456789abcdef0123456789abcdef01234567" });
  assert.equal(ci.manifest.targets.length, 1);
  assert.match(ci.workflow, /Tapp release gate/);
});

test("product readiness reads validation from the canonical generation record", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-product-validation-state-"));
  fs.mkdirSync(path.join(root, ".tapp"), { recursive: true });
  fs.writeFileSync(path.join(root, ".tapp", "application-model.json"), JSON.stringify({ kind: "tapp-application-model", application: { name: "fixture", platforms: ["web"], targetIds: [] }, targets: [], requirements: [] }));
  fs.writeFileSync(path.join(root, ".tapp", "release-plan.json"), JSON.stringify({ kind: "tapp-release-plan", items: [{ name: "proof", decision: "approved", generation: { path: ".tapp/proposals/proof.ts", status: "validated-draft", trusted: true } }] }));
  assert.equal(readProductProject({ projectDir: root }).state.validated, true);
});

test("product snapshots read only the .tapp tree — a legacy .autotap model is ignored", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-product-legacy-tree-"));
  fs.mkdirSync(path.join(root, ".autotap"), { recursive: true });
  fs.writeFileSync(path.join(root, ".autotap", "application-model.json"), JSON.stringify({
    kind: "tapp-application-model", application: { name: "legacy", platforms: [], targetIds: [] }, targets: [], requirements: [],
  }));
  const project = readProductProject({ projectDir: root });
  // The .autotap model is invisible; the snapshot resolves to an empty .tapp workspace.
  assert.notEqual(project.application?.name, "legacy");
  assert.equal(path.basename(project.paths.dir), ".tapp");
});

test("shared gate operation owns native target prerequisites with exact remediation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-product-native-gate-"));
  fs.mkdirSync(path.join(root, ".tapp"), { recursive: true });
  const model = {
    kind: "tapp-application-model",
    application: { name: "native", platforms: ["ios", "android"], targetIds: ["target_ios", "target_android"] },
    targets: [
      { id: "target_ios", platform: "ios", name: "iOS app", sourcePath: "App.xcodeproj", runtime: {}, build: {} },
      { id: "target_android", platform: "android", name: "Android app", sourcePath: "app", runtime: {}, build: {} },
    ],
    requirements: [],
  };
  fs.writeFileSync(path.join(root, ".tapp", "application-model.json"), JSON.stringify(model));
  await assert.rejects(runProductGate({ projectDir: root, platform: "ios", target: "target_ios" }), /requires a built simulator \.app/);
  await assert.rejects(runProductGate({ projectDir: root, platform: "android", target: "target_android" }), /requires an application id/);
});

test("shared target preparation keeps iOS, Android, and web build semantics out of browser adapters", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-product-target-preparation-"));
  fs.mkdirSync(path.join(root, ".tapp"), { recursive:true });
  fs.mkdirSync(path.join(root, "Apple", "Product.xcodeproj"), { recursive:true });
  fs.mkdirSync(path.join(root, "android", "app"), { recursive:true });
  const model = {
    kind:"tapp-application-model",
    application:{ name:"multi-platform", platforms:["ios", "android", "web"], targetIds:["target_ios", "target_android", "target_web"] },
    targets:[
      { id:"target_ios", platform:"ios", name:"Apple Product", sourcePath:"Apple/Product.xcodeproj", status:"configured", build:{ container:"Apple/Product.xcodeproj", proposedScheme:"Product", configuration:"Debug" }, runtime:{ surface:"iOS Simulator" } },
      { id:"target_android", platform:"android", name:"app", sourcePath:"android/app", status:"configured", build:{ projectDir:"android", task:":app:assembleDebug" }, runtime:{ surface:"Android emulator/device", applicationId:"com.acme.product" } },
      { id:"target_web", platform:"web", name:"browser", sourcePath:"web", status:"configured", build:{}, runtime:{ surface:"Chromium", management:"customer-managed", ownedUrl:"https://owned.example.test" } },
    ],
    requirements:[],
  };
  fs.writeFileSync(path.join(root, ".tapp", "application-model.json"), JSON.stringify(model));
  const realRoot = fs.realpathSync(root);

  const ios = await prepareProductTarget({
    projectDir:root, platform:"ios", target:"target_ios",
    buildIos:async (request) => {
      assert.equal(request.container, path.join(realRoot, "Apple", "Product.xcodeproj"));
      assert.equal(request.scheme, "Product");
      const appPath = path.join(root, "temporary-build", "Product.app");
      fs.mkdirSync(appPath, { recursive:true });
      return { appPath, scheme:request.scheme };
    },
    installIos:async (appPath) => ({ bundleId:"com.acme.product", appPath }),
  });
  assert.equal(ios.selectedTarget.id, "target_ios");
  assert.equal(ios.runtime.bundleId, "com.acme.product");

  const android = await prepareProductTarget({
    projectDir:root, platform:"android", target:"target_android",
    buildAndroid:async (request) => {
      assert.equal(request.gradleProjectDir, path.join(realRoot, "android"));
      assert.equal(request.moduleDir, path.join(realRoot, "android", "app"));
      assert.equal(request.task, ":app:assembleDebug");
      const apkPath = path.join(root, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
      fs.mkdirSync(path.dirname(apkPath), { recursive:true });
      fs.writeFileSync(apkPath, "fixture");
      return { apkPath };
    },
  });
  assert.equal(android.runtime.appId, "com.acme.product");
  assert.match(android.runtime.apkPath, /app-debug\.apk$/);

  const web = await prepareProductTarget({ projectDir:root, platform:"web", target:"target_web" });
  assert.equal(web.runtime.url, "https://owned.example.test");
  assert.equal(web.runtime.management, "customer-managed");
  await assert.rejects(prepareProductTarget({ projectDir:root }), /Multiple targets match/);
});

function mixedIosWebRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-product-mixed-init-"));
  fs.mkdirSync(path.join(root, "Product.xcodeproj"), { recursive: true });
  fs.mkdirSync(path.join(root, "website"), { recursive: true });
  fs.writeFileSync(path.join(root, "website", "package.json"), JSON.stringify({ name: "product-web" }));
  fs.writeFileSync(path.join(root, "website", "index.html"), "<main>Product web</main>");
  return root;
}

test("fresh source-connected exploration refuses to guess among mixed repository targets", async () => {
  const root = mixedIosWebRepository();
  let explored = false;
  await assert.rejects(
    initializeProductProject({
      projectDir: root,
      mode: "explore",
      runExploration: async () => { explored = true; return {}; },
    }),
    (error) => {
      assert.match(error.message, /Multiple application targets were detected; Tapp will not guess/);
      assert.match(error.message, /ios:Product \(Product\.xcodeproj\)/);
      assert.match(error.message, /web:product-web \(website\)/);
      assert.match(error.message, /--platform ios --target "Product\.xcodeproj"/);
      assert.match(error.message, /--platform web --target "website"/);
      assert.equal(error.code, "TAPP_TARGET_SELECTION_REQUIRED");
      assert.equal(error.details.reason, "target-selection-required");
      assert.deepEqual(error.details.choices.map((choice) => ({ platform: choice.platform, selector: choice.selector })), [
        { platform: "ios", selector: "Product.xcodeproj" },
        { platform: "web", selector: "website" },
      ]);
      return true;
    }
  );
  assert.equal(explored, false, "ambiguity is resolved before any build, launch, or exploration");
  assert.equal(fs.existsSync(path.join(root, ".tapp")), false, "an ambiguous first run does not write repository artifacts");
});

test("explicit first-run target becomes the default without erasing other detected platforms", async () => {
  const root = mixedIosWebRepository();
  let request;
  const result = await initializeProductProject({
    projectDir: root,
    mode: "explore",
    platform: "web",
    target: "website",
    runExploration: async (value) => {
      request = value;
      return { platform: "web", target: "http://127.0.0.1:4173", findings: [], inconclusive: false };
    },
  });
  assert.equal(request.platform, "web");
  assert.equal(request.target, path.join(fs.realpathSync(root), "website"));
  assert.deepEqual(result.model.targets.map((target) => target.platform).sort(), ["ios", "web"]);
  const web = result.model.targets.find((target) => target.platform === "web");
  assert.equal(result.model.application.defaultTargetId, web.id, "the explicit choice powers the next bare explore");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".tapp", "application-model.json"), "utf8")).targets.length, 2);
  const ios = result.model.targets.find((target) => target.platform === "ios");
  assert.equal(result.requirementScope.active.some((item) => item.targetId === ios.id), false, "the selected web run is not failed by iOS setup");
  assert.equal(result.requirementScope.deferred.some((item) => item.targetId === ios.id && item.id.endsWith(":scheme")), true);
});

test("explicit init exploration asks again even when a prior target default exists", async () => {
  const root = mixedIosWebRepository();
  await initializeProductProject({
    projectDir: root,
    mode: "explore",
    platform: "web",
    target: "website",
    runExploration: async () => ({ platform: "web", target: "http://127.0.0.1:4173", findings: [], inconclusive: false }),
  });
  const prior = JSON.parse(fs.readFileSync(path.join(root, ".tapp", "application-model.json"), "utf8"));
  assert.ok(prior.application.defaultTargetId, "the first explicit selection records a default for bare explore");
  let explored = false;
  await assert.rejects(
    initializeProductProject({
      projectDir: root,
      mode: "explore",
      runExploration: async () => { explored = true; return {}; },
    }),
    (error) => error.code === "TAPP_TARGET_SELECTION_REQUIRED" && error.details?.choices?.length === 2
  );
  assert.equal(explored, false, "init asks before any repeated build or exploration");
  const persisted = JSON.parse(fs.readFileSync(path.join(root, ".tapp", "application-model.json"), "utf8"));
  assert.equal(persisted.application.defaultTargetId, prior.application.defaultTargetId, "asking does not rewrite the prior selection");
});

test("CLI baseline is a thin adapter over shared gate and baseline operations", () => {
  const source = fs.readFileSync("bin/tapp.js", "utf8");
  const baseline = source.match(/case "baseline":[\s\S]*?case "ci":/)?.[0] || "";
  assert.match(baseline, /runProductGate/);
  assert.match(baseline, /createProductBaseline/);
  assert.doesNotMatch(baseline, /writeTargetBaseline|ci-gate\.sh/);
});

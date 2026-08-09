import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildInitArtifacts, generateApprovedContractProposals, mergeGeneratedTaskProposalValidation, portableEvidenceReference, promoteValidatedProposals, recordContractProposalValidation, recordGeneratedTaskProposalValidation, resolvePlanValidationFlag, reviewReleasePlan, writeInitArtifacts } from "../mcp-server/src/application-model.js";

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

test("repository validation metadata stores portable evidence references instead of local absolute paths", () => {
  assert.equal(portableEvidenceReference("/Users/person/.tapp/captures/flow-web-123"), "tapp-capture:flow-web-123");
  assert.equal(portableEvidenceReference("C:\\Users\\person\\.tapp\\captures\\flow-web-456\\report.html"), "tapp-capture:flow-web-456");
  assert.match(portableEvidenceReference("/private/tmp/customer-proof.log"), /^local-evidence:[0-9a-f]{16}$/);
  assert.equal(portableEvidenceReference("flow-web-proof"), "flow-web-proof");
});

test("plan validation resolves artifact paths before changing into the imported repository", () => {
  assert.equal(resolvePlanValidationFlag("apk", "AndroidCorpus/demo.apk", { cwd: "/workspace" }), path.join("/workspace", "AndroidCorpus", "demo.apk"));
  assert.equal(resolvePlanValidationFlag("app-id", "com.example.demo", { cwd: "/workspace" }), "com.example.demo");
});

test("revalidating a promoted contract keeps item and top-level generation trust in sync", () => {
  const generation = {
    id: "proposal_profile",
    name: "profileReachable",
    path: ".tapp/contracts/profile-reachable.contract.ts",
    status: "requires-revalidation",
    trusted: false,
    replayRequired: true,
    validationStale: true,
    promotedAt: "2026-08-05T00:00:00.000Z",
    realValidation: {},
  };
  const plan = {
    items: [{ id: "contract_profile", name: "profileReachable", platforms: ["ios"], generation }],
    generation: { generated: [{ ...generation }] },
  };
  const replayed = recordContractProposalValidation(plan, {
    id: "contract_profile",
    platform: "ios",
    passed: true,
    evidence: "/Users/person/.tapp/captures/flow-ios-current",
    detail: "current replay passed",
  });
  const itemGeneration = replayed.items[0].generation;
  const indexedGeneration = replayed.generation.generated[0];
  assert.equal(itemGeneration.status, "promoted");
  assert.equal(itemGeneration.trusted, true);
  assert.equal(itemGeneration.validationStale, false);
  assert.equal(indexedGeneration.status, "promoted");
  assert.equal(indexedGeneration.trusted, true);
  assert.equal(indexedGeneration.validationStale, false);
  assert.equal(indexedGeneration.realValidation.ios.evidence, "tapp-capture:flow-ios-current");
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-"));
  write(path.join(root, "package.json"), { name: "partner-app", scripts: { start: "vite", build: "vite build" }, dependencies: { vite: "1.0.0" } });
  write(path.join(root, "index.html"), "<main>fixture</main>");
  write(path.join(root, "Partner.xcodeproj/xcshareddata/xcschemes/Partner.xcscheme"), "<Scheme />");
  write(path.join(root, "android/settings.gradle"), "include ':app'\n");
  write(path.join(root, "android/gradlew"), "#!/bin/sh\n");
  write(path.join(root, "android/build.gradle"), "plugins { id 'com.android.application' version '9.3.0' apply false }\n");
  write(path.join(root, "android/app/build.gradle"), "plugins { id 'com.android.application' }\nandroid { defaultConfig { applicationId 'com.example.partner' } }\n");
  write(path.join(root, ".tapp/tasks/sign-in.json"), { kind: "task", version: 1, name: "signIn", steps: [{ tap: "Sign in" }], coverage: { nodes: ["sign-in"], edges: [] } });
  write(path.join(root, ".tapp/tasks/open-settings.json"), { kind: "task", version: 1, name: "openSettings", steps: [{ tap: "Settings" }] });
  write(path.join(root, ".tapp/contracts/auth.contract.ts"), `import { defineContract } from "@aarwitz/tapp/contracts";
export default defineContract({name:"authenticationWorks",title:"Customers can sign in",businessValue:"Customers reach the product",criticality:"critical",platforms:["ios","android","web"],actors:{customer:{role:"member",credentials:{email:"private@example.test",password:"do-not-copy"}}},steps:[{actor:"customer",task:"signIn"}],coverage:{capabilities:["authentication"],sourcePaths:["src/auth"]}});`);
  write(path.join(root, ".tapp/ui-map.json"), {
    schemaVersion: 1,
    app: { target: "partner", platforms: ["web"], sourceRoot: "." },
    coverage: { tasks: ["signIn"], contracts: ["authenticationWorks"], uncoveredNodeIds: ["screen_settings"], uncoveredEdgeIds: [] },
    nodes: [
      { id: "screen_sign_in", semanticKey: "sign-in", name: "Sign in", platforms: ["web"], controls: [], coveredBy: { tasks: ["signIn"], contracts: ["authenticationWorks"] }, observation: { count: 2 } },
      { id: "screen_settings", semanticKey: "settings", name: "Settings", platforms: ["web"], controls: [{ id: "control_save" }], coveredBy: { tasks: [], contracts: [] }, observation: { count: 1 } },
    ],
    edges: [],
  });
  return root;
}

test("tapp init constructs one evidence-classified model and grounded compact release plan across platforms", async () => {
  const root = fixture();
  const { model, plan } = await buildInitArtifacts({ projectDir: root, ownedUrl: "http://127.0.0.1:4173" });
  assert.deepEqual(model.application.platforms, ["android", "ios", "web"]);
  assert.equal(model.targets.find((target) => target.platform === "ios").build.proposedScheme, "Partner");
  assert.equal(model.targets.find((target) => target.platform === "android").runtime.applicationId, "com.example.partner");
  assert.equal(model.targets.filter((target) => target.platform === "android").length, 1);
  assert.equal(model.targets.find((target) => target.platform === "web").runtime.ownedUrl, "http://127.0.0.1:4173");
  assert.equal(model.uiMap.nodeCount, 2);
  assert.deepEqual(model.uiMap.platforms, ["web"]);
  assert.equal(model.actors[0].credentialsConfigured, true);
  assert.deepEqual(model.actors[0].credentialRequirements, ["email", "password"]);
  assert.doesNotMatch(JSON.stringify(model), /private@example|do-not-copy/);
  assert.equal(model.capabilities.some((capability) => capability.name === "Authentication" && capability.status === "declared"), true);
  assert.equal(model.criticalJourneys[0].status, "authored-unvalidated");
  assert.equal(model.provenance.remoteAiUsed, false);

  assert.equal(plan.items.find((item) => item.name === "authenticationWorks").decision, "accepted");
  assert.equal(plan.items.some((item) => item.name === "openSettingsWorks" && item.origin === "deterministic-source-proposal"), true);
  assert.equal(plan.items.some((item) => item.origin === "deterministic-ui-map-proposal" && item.groundedBy[0].id === "screen_settings"), true);
  assert.equal(plan.items.every((item) => /replay|compile/i.test(item.requiredValidation)), true);
});

test("a successful init Xcode build removes the scheme blocker with portable runtime evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-xcode-proof-"));
  write(path.join(root, "Unshared.xcodeproj/project.pbxproj"), "// fixture");
  write(path.join(root, ".tapp/ui-map.json"), {
    schemaVersion: 1,
    app: { target: "com.example.unshared", platforms: ["ios"], sourceRoot: "." },
    coverage: { tasks: [], contracts: [], uncoveredNodeIds: ["screen_home"], uncoveredEdgeIds: [] },
    nodes: [{ id: "screen_home", semanticKey: "home", name: "Home", status: "observed", platforms: ["ios"], controls: [], coveredBy: { tasks: [], contracts: [] }, observation: { count: 1 } }],
    edges: [],
  });

  const withoutProof = await buildInitArtifacts({ projectDir: root, platform: "ios" });
  assert.equal(withoutProof.model.targets[0].status, "needs-confirmation");
  assert.equal(withoutProof.model.requirements.some((item) => item.id.endsWith(":scheme")), true);

  const withProof = await buildInitArtifacts({
    projectDir: root,
    platform: "ios",
    targetValidation: {
      platform: "ios",
      target: "com.example.unshared",
      resolution: {
        kind: "xcode-build-installed",
        bundleId: "com.example.unshared",
        build: { container: path.join(root, "Unshared.xcodeproj"), scheme: "Unshared", configuration: "Debug" },
      },
      evidence: { captureId: "ios-init-proof", verdict: "ready", inconclusive: false },
    },
  });
  const target = withProof.model.targets[0];
  assert.equal(target.status, "configured");
  assert.equal(target.build.proposedScheme, "Unshared");
  assert.deepEqual(target.build.schemeCandidates, ["Unshared"]);
  assert.equal(target.runtime.bundleId, "com.example.unshared");
  assert.match(target.evidence.detail, /confirmed by a successful Tapp build/);
  assert.doesNotMatch(target.evidence.detail, /must be validated/);
  assert.equal(target.runtimeValidation.basis, "runtime-observed");
  assert.equal(target.runtimeValidation.build.container, "Unshared.xcodeproj");
  assert.equal(target.runtimeValidation.evidence.capture, "tapp-capture:ios-init-proof");
  assert.equal(withProof.model.requirements.some((item) => item.id.endsWith(":scheme")), false);
  assert.equal(withProof.plan.coverageGaps.unknownRequirements.some((item) => item.endsWith(":scheme")), false);
  assert.doesNotMatch(JSON.stringify(withProof.model), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  writeInitArtifacts({ ...withProof, root, outDir: ".tapp" });
  const refreshed = await buildInitArtifacts({ projectDir: root, platform: "ios" });
  assert.equal(refreshed.model.targets[0].status, "configured", "source-only refresh must retain matching runtime validation");
  assert.equal(refreshed.model.targets[0].runtimeValidation.evidence.capture, "tapp-capture:ios-init-proof");
  assert.equal(refreshed.model.requirements.some((item) => item.id.endsWith(":scheme")), false);
});

test("an empty UI Map remains inconclusive and blocks release planning", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-empty-map-"));
  write(path.join(root, "package.json"), { name: "empty-map-app", dependencies: { vite: "1.0.0" } });
  write(path.join(root, "index.html"), "<main>fixture</main>");
  write(path.join(root, ".tapp/ui-map.json"), {
    schemaVersion: 1,
    app: { target: "empty", platforms: ["web"], sourceRoot: "." },
    nodes: [],
    edges: [],
    coverage: { tasks: [], contracts: [], uncoveredNodeIds: [], uncoveredEdgeIds: [] },
  });
  const { model } = await buildInitArtifacts({ projectDir: root, ownedUrl: "http://127.0.0.1:4173" });
  assert.equal(model.uiMap.status, "inconclusive");
  assert.deepEqual(model.uiMap.platforms, ["web"]);
  const requirement = model.requirements.find((item) => item.id === "ui-map");
  assert.equal(requirement?.severity, "blocking");
  assert.equal(requirement?.status, "inconclusive");
  assert.match(requirement?.remediation || "", /explor/i);
});

test("an observed state never hides an inconclusive exploration run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-inconclusive-map-"));
  write(path.join(root, "package.json"), { name: "login-wall-app", dependencies: { vite: "1.0.0" } });
  write(path.join(root, "index.html"), "<main>fixture</main>");
  write(path.join(root, ".tapp/ui-map.json"), {
    schemaVersion: 1,
    app: { target: "login-wall", platforms: ["web"], sourceRoot: "." },
    provenance: {
      generatedBy: "tapp", runIds: ["run-login-wall"], builds: [],
      firstObservedAt: "2026-08-04T00:00:00.000Z", lastObservedAt: "2026-08-04T00:00:00.000Z",
      lastRun: { id: "run-login-wall", platform: "web", verdict: "caution", inconclusive: true, statesExplored: 1, actionsPerformed: 0 },
    },
    nodes: [{ id: "screen_login", semanticKey: "login", name: "Login", platforms: ["web"], controls: [], coveredBy: { tasks: [], contracts: [] }, observation: { count: 1 } }],
    edges: [],
    coverage: { tasks: [], contracts: [], uncoveredNodeIds: ["screen_login"], uncoveredEdgeIds: [] },
  });
  const { model } = await buildInitArtifacts({ projectDir: root, ownedUrl: "http://127.0.0.1:4173" });
  assert.equal(model.uiMap.status, "inconclusive");
  assert.equal(model.uiMap.lastRun.id, "run-login-wall");
  const requirement = model.requirements.find((item) => item.id === "ui-map");
  assert.equal(requirement?.status, "inconclusive");
  assert.match(requirement?.message || "", /inconclusive/i);
});

test("init artifacts never overwrite by default and refresh preserves explicit human decisions", async () => {
  const root = fixture();
  const built = await buildInitArtifacts({ projectDir: root, ownedUrl: "http://127.0.0.1:4173" });
  const written = writeInitArtifacts({ ...built, root });
  assert.equal(fs.existsSync(written.modelPath), true);
  assert.throws(() => writeInitArtifacts({ ...built, root }), /already exist/);
  const pending = written.plan.items.find((item) => item.decision === "pending");
  const reviewed = reviewReleasePlan(written.plan, { reject: [pending.name] });
  fs.writeFileSync(written.planPath, JSON.stringify(reviewed, null, 2));
  const refreshed = writeInitArtifacts({ ...built, root, refresh: true });
  assert.equal(refreshed.plan.items.find((item) => item.id === pending.id).decision, "rejected");
});

test("release-plan review rejects ambiguous or unknown decisions", async () => {
  const { plan } = await buildInitArtifacts({ projectDir: fixture(), ownedUrl: "http://127.0.0.1:4173" });
  const pending = plan.items.find((item) => item.decision === "pending");
  assert.throws(() => reviewReleasePlan(plan, { approve: [pending.name], reject: [pending.name] }), /more than one decision/);
  assert.throws(() => reviewReleasePlan(plan, { approve: ["inventedJourney"] }), /Unknown plan item/);
});

test("a multi-target workspace uses the repository name instead of the first module name", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-workspace-"));
  const root = path.join(parent, "MobileSuite");
  write(path.join(root, "settings.gradle"), "include ':alpha', ':beta'\n");
  write(path.join(root, "gradlew"), "#!/bin/sh\n");
  write(path.join(root, "alpha/build.gradle"), "plugins { id 'com.android.application' }\nandroid { defaultConfig { applicationId 'com.example.alpha' } }\n");
  write(path.join(root, "beta/build.gradle"), "plugins { id 'com.android.application' }\nandroid { defaultConfig { applicationId 'com.example.beta' } }\n");
  write(path.join(root, "alpha/.tapp/tasks/sign-in.json"), { kind: "task", version: 1, name: "signIn", steps: [{ tap: "Sign in" }] });
  write(path.join(root, "alpha/.tapp/contracts/auth.contract.ts"), `import { defineContract } from "@aarwitz/tapp/contracts"; export default defineContract({name:"alphaAuthWorks",title:"Alpha authentication",businessValue:"Alpha users enter",criticality:"high",platforms:["android"],actors:{customer:{}},steps:[{actor:"customer",task:"signIn"}]});`);
  const { model } = await buildInitArtifacts({ projectDir: root });
  assert.equal(model.application.name, "MobileSuite");
  assert.deepEqual(model.artifacts.contracts.map((contract) => contract.name), ["alphaAuthWorks"]);
  assert.deepEqual(model.artifacts.contracts[0].actors, [{ name: "customer", session: "default", credentialRequirements: [], credentialBindings: {} }]);
  assert.equal(model.artifacts.tasks[0].path, "alpha/.tapp/tasks/sign-in.json");
});

test("a multi-target workspace reports target-scoped UI Map coverage without hiding missing targets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-target-maps-"));
  write(path.join(root, "settings.gradle"), "include ':login', ':shop'\n");
  write(path.join(root, "gradlew"), "#!/bin/sh\n");
  write(path.join(root, "login/build.gradle"), "plugins { id 'com.android.application' }\nandroid { defaultConfig { applicationId 'com.example.login' } }\n");
  write(path.join(root, "shop/build.gradle"), "plugins { id 'com.android.application' }\nandroid { defaultConfig { applicationId 'com.example.shop' } }\n");
  write(path.join(root, "login/.tapp/ui-map.json"), {
    schemaVersion: 1,
    app: { target: "com.example.login", platforms: ["android"], sourceRoot: ".", entryNodes: { android: "screen_sign_in" }, navigationRoots: { android: "screen_sign_in" } },
    nodes: [{ id: "screen_sign_in", semanticKey: "sign-in", name: "Sign In", status: "observed", platforms: ["android"], controls: [], observation: { count: 1 } }],
    edges: [],
    coverage: { tasks: [], contracts: [], uncoveredNodeIds: ["screen_sign_in"], uncoveredEdgeIds: [] },
  });
  const { model } = await buildInitArtifacts({ projectDir: root });
  const login = model.targets.find((target) => target.name === "login");
  const shop = model.targets.find((target) => target.name === "shop");
  assert.equal(model.uiMap.status, "partial");
  assert.equal(model.uiMap.nodeCount, 1);
  assert.deepEqual(model.uiMap.observedTargetIds, [login.id]);
  assert.deepEqual(model.uiMap.missingTargetIds, [shop.id]);
  assert.equal(model.uiMaps.find((map) => map.targetId === login.id).path, "login/.tapp/ui-map.json");
  assert.equal(model.uiMaps.find((map) => map.targetId === shop.id).status, "missing");
  assert.equal(model.requirements.some((item) => item.id === `${login.id}:ui-map`), false);
  assert.match(model.requirements.find((item) => item.id === `${shop.id}:ui-map`).message, /shop/);
  const proposal = (await buildInitArtifacts({ projectDir: root })).plan.items.find((item) => item.name === "signInReachable");
  assert.equal(proposal.scope, "login");
  assert.deepEqual(proposal.platforms, ["android"]);
  assert.equal(proposal.groundedBy[0].targetId, login.id);
  assert.equal(proposal.groundedBy[0].mapPath, "login/.tapp/ui-map.json");
  const reviewed = reviewReleasePlan((await buildInitArtifacts({ projectDir: root })).plan, { approve: [proposal.id] });
  const generated = await generateApprovedContractProposals(reviewed, { projectDir: root });
  assert.deepEqual(generated.blocked, []);
  assert.equal(generated.generated[0].mapPath, "login/.tapp/ui-map.json");
  assert.match(generated.generated[0].path, /^login\/\.tapp\/proposals\/contracts\//);
  assert.match(generated.generatedTasks[0].path, /^login\/\.tapp\/proposals\/tasks\//);
  const generatedItem = generated.plan.items.find((item) => item.id === proposal.id);
  const taskEvidence = recordGeneratedTaskProposalValidation({ projectDir: root, item: generatedItem, platform: "android", evidence: "flow-android-target-map", detail: "real replay passed" });
  assert.equal(taskEvidence[0].trusted, true);
  assert.match(taskEvidence[0].path, /^login\/\.tapp\/proposals\/tasks\//);
  let validated = mergeGeneratedTaskProposalValidation(generated.plan, taskEvidence);
  validated = recordContractProposalValidation(validated, { id: proposal.id, platform: "android", passed: true, evidence: "flow-android-target-map" });
  const promoted = await promoteValidatedProposals(validated, { projectDir: root, ids: [proposal.id] });
  assert.equal(promoted.promotedContracts[0].path, "login/.tapp/contracts/sign-in-reachable.contract.ts");
  assert.match(promoted.promotedTasks[0].path, /^login\/\.tapp\/tasks\//);
  assert.deepEqual(promoted.mapPaths, [fs.realpathSync(path.join(root, "login", ".tapp", "ui-map.json"))]);
  const covered = JSON.parse(fs.readFileSync(path.join(root, "login", ".tapp", "ui-map.json"), "utf8"));
  assert.equal(covered.coverage.contracts.includes("signInReachable"), true);
});

test("backend-only Node packages are not invented as browser application targets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-node-workspace-"));
  write(path.join(root, "api/package.json"), { name: "api", scripts: { start: "node server.js", dev: "node --watch server.js" }, dependencies: { express: "5.0.0" } });
  write(path.join(root, "api/server.js"), "console.log('api')\n");
  write(path.join(root, "site/package.json"), { name: "site", scripts: { start: "node server.js" } });
  write(path.join(root, "site/index.html"), "<main>site</main>");
  const { model } = await buildInitArtifacts({ projectDir: root, ownedUrl: "http://127.0.0.1:3000" });
  assert.deepEqual(model.targets.filter((target) => target.platform === "web").map((target) => target.name), ["site"]);
});

test("web target dependency installation is derived from repository evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-web-install-"));
  write(path.join(root, "package.json"), { name: "dependency-free-site", scripts: { start: "node server.js" } });
  write(path.join(root, "index.html"), "<main>site</main>");
  let built = await buildInitArtifacts({ projectDir: root, ownedUrl: "http://127.0.0.1:3000" });
  assert.equal(built.model.targets[0].build.install, null, "a dependency-free app must not invent npm ci");
  assert.equal(built.model.requirements.some((item) => item.id.endsWith(":dependency-lock")), false);

  write(path.join(root, "package.json"), { name: "unlocked-site", scripts: { start: "vite" }, dependencies: { vite: "1.0.0" } });
  built = await buildInitArtifacts({ projectDir: root, ownedUrl: "http://127.0.0.1:3000" });
  assert.equal(built.model.targets[0].build.install, null, "an unlocked dependency graph must not be presented as deterministic");
  const requirement = built.model.requirements.find((item) => item.id.endsWith(":dependency-lock"));
  assert.equal(requirement?.severity, "blocking");
  assert.match(requirement?.remediation || "", /lockfile/i);

  write(path.join(root, "package-lock.json"), { lockfileVersion: 3, packages: {} });
  built = await buildInitArtifacts({ projectDir: root, ownedUrl: "http://127.0.0.1:3000" });
  assert.equal(built.model.targets[0].build.install, "npm ci");
  assert.equal(built.model.targets[0].build.lockfile, "package-lock.json");
  assert.equal(built.model.requirements.some((item) => item.id.endsWith(":dependency-lock")), false);
});

test("a deterministically managed web target does not invent an owned-URL blocker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-managed-web-model-"));
  write(path.join(root, "package.json"), { name: "managed-site", scripts: { start: "node server.js" } });
  write(path.join(root, "index.html"), "<main>site</main>");
  const { model } = await buildInitArtifacts({ projectDir: root });
  const web = model.targets.find((target) => target.platform === "web");
  assert.equal(web.status, "configured");
  assert.equal(web.runtime.management, "tapp-managed");
  assert.equal(model.requirements.some((item) => item.id.endsWith(":owned-url")), false);
});

test("application model merges explicit actors and contract placeholders without persisting values", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-actors-"));
  write(path.join(root, "index.html"), "<main>social</main>");
  write(path.join(root, ".tapp/project.json"), {
    kind: "tapp-project-config", schemaVersion: 1,
    actors: {
      alice: { role: "member", session: "isolated", provisioning: "seeded", credentials: { email: { env: "ALICE_EMAIL" }, password: { env: "ALICE_PASSWORD" } } },
      bob: { role: "member", session: "isolated", provisioning: "seeded", credentials: { email: { env: "BOB_EMAIL" }, password: { env: "BOB_PASSWORD" } } },
    },
  });
  write(path.join(root, ".tapp/tasks/open-feed.json"), { kind: "task", version: 1, name: "openFeed", steps: [{ tap: "Feed" }] });
  write(path.join(root, ".tapp/tasks/sign-in.json"), { kind: "task", version: 1, name: "signIn", inputs: { email: { required: true, secret: true }, password: { required: true, secret: true } }, steps: [{ type: { field: "Email", value: "{{email}}" } }, { type: { field: "Password", value: "{{password}}" } }, { tap: "Sign in" }] });
  write(path.join(root, ".tapp/contracts/social.contract.ts"), `import { defineContract } from "@aarwitz/tapp/contracts";
export default defineContract({name:"socialWorks",title:"Social state propagates",businessValue:"Members interact",criticality:"critical",platforms:["web"],actors:{alice:{role:"member",session:"isolated",credentials:{email:"$ALICE_EMAIL",password:"$ALICE_PASSWORD"}},bob:{role:"member",session:"isolated",credentials:{email:"$BOB_EMAIL",password:"$BOB_PASSWORD"}}},steps:[{actor:"alice",task:"openFeed"},{actor:"bob",task:"openFeed"}]});`);
  const built = await buildInitArtifacts({ projectDir: root });
  const { model } = built;
  assert.deepEqual(model.actors.map((actor) => actor.name), ["alice", "bob"]);
  assert.deepEqual(model.actors[0].credentialBindings, { email: "ALICE_EMAIL", password: "ALICE_PASSWORD" });
  assert.equal(model.actors[0].provisioning, "seeded");
  assert.equal(model.configuration.status, "configured");
  assert.equal(model.configuration.actorCount, 2);
  assert.equal(model.stateBoundaries[0].isolation, "required");
  assert.equal(model.requirements.some((item) => item.id.includes("credential-bindings")), false);
  assert.doesNotMatch(JSON.stringify(model), /alice@example|password-value/);
  const signInProposal = built.plan.items.find((item) => item.name === "signInWorks");
  assert.deepEqual(signInProposal.actors, ["alice"]);
  const reviewed = reviewReleasePlan(built.plan, { approve: [signInProposal.id] });
  const generated = await generateApprovedContractProposals(reviewed, { projectDir: root });
  const source = fs.readFileSync(path.join(root, generated.generated[0].path), "utf8");
  assert.match(source, /\$ALICE_EMAIL/);
  assert.match(source, /\$ALICE_PASSWORD/);
  assert.doesNotMatch(source, /\$TEST_EMAIL|\$TEST_PASSWORD/);
});

test("application model blocks missing and conflicting actor credential bindings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-actor-conflict-"));
  write(path.join(root, "index.html"), "<main>app</main>");
  write(path.join(root, ".tapp/project.json"), { kind: "tapp-project-config", schemaVersion: 1, actors: { alice: { credentials: { email: { env: "ALICE_EMAIL" } } } } });
  write(path.join(root, ".tapp/tasks/sign-in.json"), { kind: "task", version: 1, name: "signIn", steps: [{ tap: "Sign in" }] });
  write(path.join(root, ".tapp/contracts/auth.contract.ts"), `import { defineContract } from "@aarwitz/tapp/contracts"; export default defineContract({name:"authWorks",title:"Auth works",businessValue:"Members enter",criticality:"critical",platforms:["web"],actors:{alice:{credentials:{email:"$OTHER_EMAIL",password:"literal-forbidden"}}},steps:[{actor:"alice",task:"signIn"}]});`);
  const { model } = await buildInitArtifacts({ projectDir: root });
  assert.equal(model.requirements.find((item) => item.id === "actor:alice:credential-bindings")?.severity, "blocking");
  assert.equal(model.requirements.find((item) => item.id === "actor:alice:credential-conflicts")?.severity, "blocking");
  assert.doesNotMatch(JSON.stringify(model), /literal-forbidden/);
});

test("planner proposes a grounded cross-actor propagation contract only with isolated actors, compatible Tasks, and reset lifecycle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-cross-actor-plan-"));
  write(path.join(root, "index.html"), "<main>social</main>");
  write(path.join(root, ".tapp/project.json"), {
    kind: "tapp-project-config", schemaVersion: 1,
    actors: {
      alice: { role: "member", session: "isolated", provisioning: "seeded", credentials: { email: { env: "ALICE_EMAIL" }, password: { env: "ALICE_PASSWORD" } } },
      bob: { role: "member", session: "isolated", provisioning: "seeded", credentials: { email: { env: "BOB_EMAIL" }, password: { env: "BOB_PASSWORD" } } },
    },
    lifecycle: {
      setup: [{ request: { method: "POST", path: "/__tapp/reset", status: 200 } }],
      teardown: [{ request: { method: "POST", path: "/__tapp/reset", status: 200 } }],
    },
  });
  write(path.join(root, ".tapp/tasks/sign-in.yml"), `kind: task
version: 1
name: signIn
inputs:
  email: { required: true, secret: true }
  password: { required: true, secret: true }
postconditions:
  - screen: Feed
implementations:
  web:
    steps:
      - type: { field: Email, value: "{{email}}" }
      - type: { field: Password, value: "{{password}}" }
      - tap: Sign in
`);
  write(path.join(root, ".tapp/tasks/create-post.yml"), `kind: task
version: 1
name: createPost
inputs:
  text: { required: true }
outputs:
  publishedText: { fromInput: text }
preconditions:
  - screen: Feed
postconditions:
  - exists: "{{text}}"
implementations:
  web:
    steps:
      - type: { field: Post text, value: "{{text}}" }
      - tap: Publish
`);
  const built = await buildInitArtifacts({ projectDir: root });
  const proposal = built.plan.items.find((item) => item.origin === "deterministic-cross-actor-proposal");
  assert.equal(proposal.name, "postPropagatesAcrossActors");
  assert.deepEqual(proposal.actors, ["alice", "bob"]);
  assert.deepEqual(proposal.tasks, ["signIn", "createPost"]);
  assert.equal(proposal.journeySteps[2].save.publishedText, "SHARED_POST");
  assert.equal(proposal.journeySteps[3].expect.exists, "$SHARED_POST");
  assert.equal(built.plan.items.some((item) => item.name === "signInWorks" || item.name === "createPostWorks"), false, "one system contract supersedes duplicated single-Task proposals");

  const reviewed = reviewReleasePlan(built.plan, { approve: [proposal.id] });
  const generated = await generateApprovedContractProposals(reviewed, { projectDir: root });
  assert.equal(generated.blocked.length, 0);
  assert.equal(generated.generated[0].staticValidation[0].kind, "scenario");
  const source = fs.readFileSync(path.join(root, generated.generated[0].path), "utf8");
  assert.match(source, /\$ALICE_EMAIL/);
  assert.match(source, /\$BOB_EMAIL/);
  assert.match(source, /"path": "\/__tapp\/reset"/);
  assert.match(source, /"exists": "\$SHARED_POST"/);
  assert.doesNotMatch(source, /\$TEST_EMAIL|\$TEST_PASSWORD/);

  const configPath = path.join(root, ".tapp/project.json");
  const noTeardown = JSON.parse(fs.readFileSync(configPath, "utf8"));
  delete noTeardown.lifecycle.teardown;
  write(configPath, noTeardown);
  const ungrounded = await buildInitArtifacts({ projectDir: root });
  assert.equal(ungrounded.plan.items.some((item) => item.origin === "deterministic-cross-actor-proposal"), false, "planner does not claim cross-account isolation without deterministic cleanup");
});

test("planner proposes a durable checkout contract only from reviewed outputs, order history, observed states, and reset lifecycle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-durable-checkout-"));
  write(path.join(root, "index.html"), "<main>commerce</main>");
  write(path.join(root, ".tapp/project.json"), {
    kind: "tapp-project-config", schemaVersion: 1,
    actors: { customer: { role: "customer", session: "default", provisioning: "seeded", credentials: {} } },
    lifecycle: {
      setup: [{ request: { method: "POST", path: "/__tapp/reset", status: 200 } }],
      teardown: [{ request: { method: "POST", path: "/__tapp/reset", status: 200 } }],
    },
  });
  write(path.join(root, ".tapp/tasks/complete-checkout.yml"), `kind: task
version: 1
name: completeCheckout
inputs:
  product: { required: true, default: Tapp Pro Plan }
outputs:
  orderedProduct: { fromInput: product }
preconditions:
  - screen: Shop
postconditions:
  - screen: Order confirmed
  - exists: "{{product}}"
implementations:
  web:
    steps:
      - tap: "Buy {{product}}"
      - tap: Checkout
      - tap: Place order
`);
  write(path.join(root, ".tapp/tasks/open-orders.yml"), `kind: task
version: 1
name: openOrders
postconditions:
  - screen: Orders
implementations:
  web:
    steps:
      - tap: Orders
`);
  write(path.join(root, ".tapp/ui-map.json"), {
    schemaVersion: 1,
    app: { target: "commerce", platforms: ["web"], sourceRoot: ".", entryNodes: { web: "screen_shop" } },
    provenance: { lastRun: { id: "real-commerce-run", platform: "web", verdict: "ready", inconclusive: false } },
    nodes: [
      { id: "screen_shop", semanticKey: "shop", name: "Shop", status: "observed", platforms: ["web"], controls: [], coveredBy: { tasks: [], contracts: [] }, observation: { count: 2 } },
      { id: "screen_confirmed", semanticKey: "order-confirmed", name: "Order confirmed", status: "observed", platforms: ["web"], controls: [], coveredBy: { tasks: [], contracts: [] }, observation: { count: 1 } },
      { id: "screen_orders", semanticKey: "orders", name: "Orders", status: "observed", platforms: ["web"], controls: [], coveredBy: { tasks: [], contracts: [] }, observation: { count: 1 } },
    ],
    edges: [], coverage: { tasks: [], contracts: [], uncoveredNodeIds: ["screen_shop", "screen_confirmed", "screen_orders"], uncoveredEdgeIds: [] },
  });
  const built = await buildInitArtifacts({ projectDir: root });
  const proposal = built.plan.items.find((item) => item.origin === "deterministic-business-effect-proposal");
  assert.equal(proposal.name, "checkoutCreatesDurableOrder");
  assert.equal(proposal.criticality, "critical");
  assert.deepEqual(proposal.tasks, ["completeCheckout", "openOrders"]);
  assert.equal(proposal.journeySteps[0].save.orderedProduct, "ORDERED_ITEM");
  assert.equal(proposal.journeySteps[2].expect.exists, "$ORDERED_ITEM");
  assert.equal(built.plan.items.some((item) => item.name === "completeCheckoutWorks" || item.name === "openOrdersWorks"), false);

  const reviewed = reviewReleasePlan(built.plan, { approve: [proposal.id] });
  const generated = await generateApprovedContractProposals(reviewed, { projectDir: root });
  assert.equal(generated.blocked.length, 0);
  assert.equal(generated.generated[0].staticValidation[0].kind, "flow");
  const source = fs.readFileSync(path.join(root, generated.generated[0].path), "utf8");
  assert.match(source, /"setup"/);
  assert.match(source, /"task": "openOrders"/);
  assert.match(source, /"exists": "\$ORDERED_ITEM"/);

  const mapPath = path.join(root, ".tapp/ui-map.json");
  const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  map.nodes = map.nodes.filter((node) => node.semanticKey !== "orders");
  write(mapPath, map);
  const ungrounded = await buildInitArtifacts({ projectDir: root });
  assert.equal(ungrounded.plan.items.some((item) => item.origin === "deterministic-business-effect-proposal"), false, "planner does not infer durability without observed order-history evidence");
});

test("approved Task-backed plan items generate drafts while UI-only ideas without entry evidence stay blocked", async () => {
  const root = fixture();
  const { plan } = await buildInitArtifacts({ projectDir: root, ownedUrl: "http://127.0.0.1:4173" });
  const taskItem = plan.items.find((item) => item.name === "openSettingsWorks");
  const uiItem = plan.items.find((item) => item.origin === "deterministic-ui-map-proposal");
  const reviewed = reviewReleasePlan(plan, { approve: [taskItem.id, uiItem.id] });
  const result = await generateApprovedContractProposals(reviewed, { projectDir: root });
  assert.equal(result.generated.length, 1);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.generated[0].name, "openSettingsWorks");
  assert.equal(result.generated[0].trusted, false);
  assert.equal(result.generated[0].staticValidation.length, 3);
  assert.equal(result.blocked[0].name, uiItem.name);
  assert.match(result.blocked[0].reason, /no observed web navigation root/);
  const draft = fs.readFileSync(path.join(root, result.generated[0].path), "utf8");
  assert.match(draft, /defineContract/);
  assert.match(draft, /"task": "openSettings"/);
  assert.match(result.plan.generation.invariant, /not real-surface validation/);
  const webPassed = recordContractProposalValidation(result.plan, { id: taskItem.id, platform: "web", passed: true, evidence: "flow-web-proof" });
  assert.equal(webPassed.items.find((item) => item.id === taskItem.id).generation.trusted, false, "three-platform draft is not trusted after only web replay");
  const iosPassed = recordContractProposalValidation(webPassed, { id: taskItem.id, platform: "ios", passed: true, evidence: "flow-ios-proof" });
  const androidPassed = recordContractProposalValidation(iosPassed, { id: taskItem.id, platform: "android", passed: true, evidence: "flow-android-proof" });
  assert.equal(androidPassed.items.find((item) => item.id === taskItem.id).generation.trusted, true);
  assert.equal(androidPassed.items.find((item) => item.id === taskItem.id).generation.status, "validated-draft");
  const preserved = await generateApprovedContractProposals(androidPassed, { projectDir: root });
  assert.equal(preserved.plan.items.find((item) => item.id === taskItem.id).generation.trusted, true, "identical regeneration preserves complete replay evidence");
  assert.equal(preserved.plan.items.find((item) => item.id === taskItem.id).generation.status, "validated-draft");
  const repeated = await generateApprovedContractProposals(reviewed, { projectDir: root });
  assert.equal(repeated.generated[0].path, result.generated[0].path);
  assert.equal(repeated.blocked[0].name, uiItem.name);
});

test("approved UI Map journeys generate reusable compositional Task drafts before contract drafts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-map-tasks-"));
  write(path.join(root, "package.json"), { name: "mapped-store", scripts: { start: "node server.js" } });
  write(path.join(root, "index.html"), "<main>store</main>");
  const home = "screen_home";
  const checkout = "screen_checkout";
  const confirmation = "screen_confirmation";
  write(path.join(root, ".tapp/ui-map.json"), {
    schemaVersion: 1,
    app: { target: "store", platforms: ["web"], sourceRoot: ".", entryNodes: { web: home } },
    provenance: { generatedBy: "tapp", runIds: ["web-1"], builds: [], firstObservedAt: "2026-08-04T00:00:00.000Z", lastObservedAt: "2026-08-04T00:00:00.000Z" },
    nodes: [
      { id: home, semanticKey: "store-home", name: "Store Home", platforms: ["web"], controls: [{ id: "checkout-control", semanticKey: "checkout", kind: "link", label: "Checkout", selectors: [{ kind: "label", value: "Checkout" }], platforms: ["web"] }], coveredBy: { tasks: [], contracts: [] }, observation: { count: 1 } },
      { id: checkout, semanticKey: "checkout", name: "Checkout", platforms: ["web"], controls: [{ id: "order-control", semanticKey: "place-order", kind: "button", label: "Place order", selectors: [{ kind: "label", value: "Place order" }], platforms: ["web"] }], coveredBy: { tasks: [], contracts: [] }, observation: { count: 1 } },
      { id: confirmation, semanticKey: "order-confirmation", name: "Order Confirmation", platforms: ["web"], controls: [], coveredBy: { tasks: [], contracts: [] }, observation: { count: 1 } },
    ],
    edges: [
      { id: "edge_checkout", from: home, to: checkout, status: "observed", platforms: ["web"], action: { type: "tap", target: "Checkout", selectors: [{ kind: "label", value: "Checkout" }] }, coveredBy: { tasks: [], contracts: [] }, observation: { count: 1 } },
      { id: "edge_order", from: checkout, to: confirmation, status: "observed", platforms: ["web"], action: { type: "tap", target: "Place order", selectors: [{ kind: "label", value: "Place order" }] }, preparation: [{ type: "type", target: "name_field", valueSource: "generated-text" }, { type: "type", target: "address_field", valueSource: "generated-text" }], preconditions: [{ type: "field-populated", target: "name_field" }, { type: "field-populated", target: "address_field" }], coveredBy: { tasks: [], contracts: [] }, observation: { count: 1 } },
    ],
    coverage: { tasks: [], contracts: [], uncoveredNodeIds: [home, checkout, confirmation], uncoveredEdgeIds: ["edge_checkout", "edge_order"] },
  });
  const { plan } = await buildInitArtifacts({ projectDir: root, ownedUrl: "http://127.0.0.1:3000" });
  const selected = plan.items.filter((item) => ["checkoutReachable", "orderConfirmationReachable"].includes(item.name));
  assert.equal(selected.length, 2);
  plan.items.find((item) => item.name === "orderConfirmationReachable").groundedBy.push({
    type: "pr-exploration", targetId: "explore_checkout", changedFiles: ["src/checkout.ts"], route: "/checkout", provenance: "runtime-observed",
  });
  const reviewed = reviewReleasePlan(plan, { approve: selected.map((item) => item.id) });
  const result = await generateApprovedContractProposals(reviewed, { projectDir: root });
  assert.equal(result.blocked.length, 0);
  assert.equal(result.generated.length, 2);
  assert.deepEqual(result.generatedTasks.map((item) => item.name).sort(), ["openCheckout", "openOrderConfirmation"]);
  const checkoutResult = result.generated.find((item) => item.name === "checkoutReachable");
  const confirmationResult = result.generated.find((item) => item.name === "orderConfirmationReachable");
  assert.deepEqual(checkoutResult.tasks, ["openCheckout"]);
  assert.deepEqual(confirmationResult.tasks, ["openCheckout", "openOrderConfirmation"]);
  assert.equal(confirmationResult.staticValidation[0].platform, "web");
  assert.ok(confirmationResult.staticValidation[0].deterministicSteps >= 6);
  for (const task of result.generatedTasks) {
    assert.match(task.path, /^\.tapp\/proposals\/tasks\//);
    const definition = JSON.parse(fs.readFileSync(path.join(root, task.path), "utf8"));
    assert.equal(definition.generation.trusted, false);
    assert.equal(definition.coverage.edges.length, 1);
    assert.deepEqual(definition.coverage.sourcePaths, ["src/checkout.ts"]);
    const steps = definition.implementations.web.steps;
    const tapIndex = steps.findIndex((step) => typeof step.tap === "string");
    assert.ok(tapIndex > 0);
    assert.deepEqual(steps[tapIndex - 1], { wait_for: steps[tapIndex].tap }, "generated navigation waits for the observed control before tapping it");
  }
  const confirmationSource = fs.readFileSync(path.join(root, confirmationResult.path), "utf8");
  assert.match(confirmationSource, /"sourcePaths": \[/);
  assert.match(confirmationSource, /"src\/checkout\.ts"/);
  const orderTask = JSON.parse(fs.readFileSync(path.join(root, result.generatedTasks.find((task) => task.name === "openOrderConfirmation").path), "utf8"));
  assert.deepEqual(orderTask.implementations.web.steps.slice(1, 5), [
    { wait_for: "name_field" },
    { type: { field: "name_field", value: "Tapp test" } },
    { wait_for: "address_field" },
    { type: { field: "address_field", value: "Tapp test" } },
  ]);

  const confirmationItem = result.plan.items.find((item) => item.id === confirmationResult.id);
  const taskUpdates = recordGeneratedTaskProposalValidation({ projectDir: root, item: confirmationItem, platform: "web", evidence: "flow-web-proof", detail: "real replay passed" });
  let validatedPlan = mergeGeneratedTaskProposalValidation(result.plan, taskUpdates);
  validatedPlan = recordContractProposalValidation(validatedPlan, { id: confirmationItem.id, platform: "web", passed: true, evidence: "flow-web-proof" });
  write(path.join(root, ".tapp/release-plan.json"), validatedPlan);
  const rebuilt = await buildInitArtifacts({ projectDir: root, ownedUrl: "http://127.0.0.1:3000" });
  let refreshed = writeInitArtifacts({ ...rebuilt, root, refresh: true });
  assert.equal(refreshed.plan.items.find((item) => item.id === confirmationItem.id).generation.trusted, true, "source-only refresh preserves replay evidence");
  assert.deepEqual(refreshed.plan.items.find((item) => item.id === confirmationItem.id).tasks, ["openCheckout", "openOrderConfirmation"]);

  refreshed = writeInitArtifacts({ ...rebuilt, root, refresh: true, invalidateValidation: true });
  assert.equal(refreshed.plan.items.find((item) => item.id === confirmationItem.id).generation.trusted, false, "new runtime evidence requires replay");
  assert.equal(refreshed.plan.items.find((item) => item.id === confirmationItem.id).generation.status, "requires-revalidation");
  const invalidatedTask = JSON.parse(fs.readFileSync(path.join(root, confirmationResult.taskPaths[0]), "utf8"));
  assert.equal(invalidatedTask.generation.trusted, false);
  assert.equal(invalidatedTask.generation.status, "requires-revalidation");

  const invalidatedItem = refreshed.plan.items.find((item) => item.id === confirmationItem.id);
  const replayedTaskUpdates = recordGeneratedTaskProposalValidation({ projectDir: root, item: invalidatedItem, platform: "web", evidence: "flow-web-current", detail: "current replay passed" });
  let replayedPlan = mergeGeneratedTaskProposalValidation(refreshed.plan, replayedTaskUpdates);
  replayedPlan = recordContractProposalValidation(replayedPlan, { id: invalidatedItem.id, platform: "web", passed: true, evidence: "flow-web-current" });
  const promoted = await promoteValidatedProposals(replayedPlan, { projectDir: root, ids: [invalidatedItem.id] });
  assert.deepEqual(promoted.promotedContracts.map((item) => item.name), ["orderConfirmationReachable"]);
  assert.deepEqual(promoted.promotedTasks.map((item) => item.name).sort(), ["openCheckout", "openOrderConfirmation"]);
  assert.equal(fs.existsSync(path.join(root, ".tapp/contracts/order-confirmation-reachable.contract.ts")), true);
  assert.equal(fs.existsSync(path.join(root, ".tapp/tasks/open-checkout.task.json")), true);
  assert.equal(fs.existsSync(path.join(root, confirmationResult.path)), false, "promoted contract leaves the proposal staging area");
  assert.equal(fs.existsSync(path.join(root, confirmationResult.taskPaths[0])), false, "promoted Task leaves the proposal staging area");
  const promotedItem = promoted.plan.items.find((item) => item.id === invalidatedItem.id);
  assert.equal(promotedItem.decision, "accepted");
  assert.equal(promotedItem.generation.status, "promoted");
  assert.match(promotedItem.generation.path, /^\.tapp\/contracts\//);
  const coveredMap = JSON.parse(fs.readFileSync(path.join(root, ".tapp/ui-map.json"), "utf8"));
  assert.equal(coveredMap.coverage.tasks.includes("openCheckout"), true);
  assert.equal(coveredMap.coverage.contracts.includes("orderConfirmationReachable"), true);

  write(path.join(root, ".tapp/release-plan.json"), promoted.plan);
  const postPromotionBuild = await buildInitArtifacts({ projectDir: root, ownedUrl: "http://127.0.0.1:3000" });
  const postPromotionRefresh = writeInitArtifacts({ ...postPromotionBuild, root, refresh: true });
  assert.equal(postPromotionRefresh.plan.items.filter((item) => item.name === "orderConfirmationReachable").length, 1, "promoted proposal reconciles to its committed contract identity");
  const committedItem = postPromotionRefresh.plan.items.find((item) => item.name === "orderConfirmationReachable");
  assert.equal(committedItem.id, invalidatedItem.id, "promotion preserves the reviewed plan item's stable identity");
  assert.equal(committedItem.origin, "committed");
  assert.equal(committedItem.decision, "accepted");
  assert.equal(committedItem.generation.status, "promoted");
  assert.equal(committedItem.generation.trusted, true);
  assert.equal(postPromotionRefresh.plan.items.some((item) => item.stale && item.name === "orderConfirmationReachable"), false);
});

test("UI Map proposal generation composes adjacent-edge Tasks once and preserves reviewed entry-to-root setup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-reviewed-multi-edge-task-"));
  write(path.join(root, "package.json"), { name: "profile-app", scripts: { start: "node server.js" } });
  write(path.join(root, "index.html"), "<main>profile</main>");
  write(path.join(root, ".tapp/tasks/open-profile.json"), {
    kind: "task", version: 1, name: "openProfile",
    preconditions: [{ screen: "Home" }],
    implementations: { web: { steps: [
      { wait_for: "Settings" }, { tap: "Settings" },
      { wait_for: "Profile" }, { tap: "Profile" }, { wait_for: "Profile" },
    ] } },
    postconditions: [{ screen: "Profile" }],
    coverage: { nodes: ["home", "settings", "profile"], edges: ["edge_settings", "edge_profile"] },
  });
  write(path.join(root, ".tapp/tasks/complete-onboarding.json"), {
    kind: "task", version: 1, name: "completeOnboarding",
    inputs: { email: { required: true, secret: true }, password: { required: true, secret: true } },
    preconditions: [{ screen: "Welcome" }],
    implementations: { web: { steps: [{ wait_for: "Continue" }, { tap: "Continue" }, { wait_for: "Home" }] } },
    postconditions: [{ screen: "Home" }],
    coverage: { nodes: ["welcome", "home"], edges: ["edge_onboarding"] },
  });
  write(path.join(root, ".tapp/ui-map.json"), {
    schemaVersion: 1,
    app: { target: "profile", platforms: ["web"], sourceRoot: ".", entryNodes: { web: "screen_welcome" }, navigationRoots: { web: "screen_home" } },
    provenance: { generatedBy: "tapp", runIds: ["web-1"], builds: [], firstObservedAt: "2026-08-05T00:00:00.000Z", lastObservedAt: "2026-08-05T00:00:00.000Z" },
    nodes: [
      { id: "screen_welcome", semanticKey: "welcome", name: "Welcome", platforms: ["web"], status: "observed", controls: [], coveredBy: { tasks: ["completeOnboarding"], contracts: [] }, observation: { count: 1 } },
      { id: "screen_home", semanticKey: "home", name: "Home", platforms: ["web"], status: "observed", controls: [], coveredBy: { tasks: ["openProfile"], contracts: [] }, observation: { count: 1 } },
      { id: "screen_settings", semanticKey: "settings", name: "Settings", platforms: ["web"], status: "observed", controls: [], coveredBy: { tasks: ["openProfile"], contracts: [] }, observation: { count: 1 } },
      { id: "screen_profile", semanticKey: "profile", name: "Profile", platforms: ["web"], status: "observed", controls: [], coveredBy: { tasks: ["openProfile"], contracts: [] }, observation: { count: 1 } },
    ],
    edges: [
      { id: "edge_onboarding", from: "screen_welcome", to: "screen_home", status: "observed", confirmed: true, platforms: ["web"], action: { type: "tap", target: "Continue", selectors: [{ kind: "label", value: "Continue" }] }, preconditions: [], actors: [], coveredBy: { tasks: ["completeOnboarding"], contracts: [] }, observation: { count: 1 } },
      { id: "edge_settings", from: "screen_home", to: "screen_settings", status: "observed", confirmed: true, platforms: ["web"], action: { type: "tap", target: "Settings", selectors: [{ kind: "label", value: "Settings" }] }, preconditions: [], actors: [], coveredBy: { tasks: ["openProfile"], contracts: [] }, observation: { count: 1 } },
      { id: "edge_profile", from: "screen_settings", to: "screen_profile", status: "observed", confirmed: true, platforms: ["web"], action: { type: "tap", target: "Profile", selectors: [{ kind: "label", value: "Profile" }] }, preconditions: [], actors: [], coveredBy: { tasks: ["openProfile"], contracts: [] }, observation: { count: 1 } },
    ],
    coverage: { tasks: ["completeOnboarding", "openProfile"], contracts: [], uncoveredNodeIds: [], uncoveredEdgeIds: [] },
  });
  const built = await buildInitArtifacts({ projectDir: root, ownedUrl: "http://127.0.0.1:3000" });
  built.plan.items.push({
    id: "proposal_profile", kind: "release-contract", name: "profileReachable", title: "Profile remains reachable",
    origin: "deterministic-ui-map-proposal", decision: "pending", criticality: "medium",
    businessValue: "Protect profile access.", actors: ["customer"], tasks: [], platforms: ["web"],
    risk: "Profile has no release contract.", groundedBy: [{ type: "ui-map-node", id: "screen_profile", observationCount: 1 }],
  });
  const reviewed = reviewReleasePlan(built.plan, { approve: ["proposal_profile"] });
  const result = await generateApprovedContractProposals(reviewed, { projectDir: root });
  const generated = result.generated.find((item) => item.id === "proposal_profile");
  assert.deepEqual(generated.tasks, ["completeOnboarding", "openProfile"]);
  assert.deepEqual(result.generatedTasks, []);
  const source = fs.readFileSync(path.join(root, generated.path), "utf8");
  assert.equal((source.match(/"task": "openProfile"/g) || []).length, 1);
  assert.equal((source.match(/"task": "completeOnboarding"/g) || []).length, 1);
  assert.match(source, /\$TEST_EMAIL/);
  assert.match(source, /\$TEST_PASSWORD/);
  assert.deepEqual(result.plan.items.find((item) => item.id === "proposal_profile").taskInputs.completeOnboarding, {
    email: { required: true, secret: true },
    password: { required: true, secret: true },
  });
  const repeated = await generateApprovedContractProposals(result.plan, { projectDir: root });
  assert.equal(repeated.blocked.length, 0, "repeating generation reuses identical untrusted drafts without overwriting them");
  assert.equal(repeated.generated.find((item) => item.id === "proposal_profile").path, generated.path);
});

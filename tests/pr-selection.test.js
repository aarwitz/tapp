import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { adoptPrCoverageProposal, buildPrContractPlan, changedFilesFromGit, changedSymbolEvidenceFromGit, parseChangedDiffEvidence, parseChangedFiles, parseChangedSymbols, prExplorationTargetsFromPlan, sourcePathMatches, webSeedRoutesFromPrPlan } from "../mcp-server/src/pr-selection.js";

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function contract(name, criticality, task, sourcePath = "") {
  return `import { defineContract } from "@aarwitz/tapp/contracts";
export default defineContract({name:${JSON.stringify(name)},title:${JSON.stringify(name)},businessValue:"value",criticality:${JSON.stringify(criticality)},platforms:["web"],actors:{customer:{}},steps:[{actor:"customer",task:${JSON.stringify(task)}}],coverage:{sourcePaths:${JSON.stringify(sourcePath ? [sourcePath] : [])}}});`;
}

test("source ownership matches exact files, directories, and bounded globs", () => {
  assert.equal(sourcePathMatches("src/feed/view.ts", "src/feed"), true);
  assert.equal(sourcePathMatches("src/feedback.ts", "src/feed"), false);
  assert.equal(sourcePathMatches("src/feed/view.ts", "src/**/view.ts"), true);
});

test("PR planning always selects critical contracts and uses Task/UI Map ownership for relevance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-pr-plan-"));
  write(path.join(root, ".tapp/tasks/open-feed.json"), {
    kind: "task", version: 1, name: "openFeed", steps: [{ tap: "Feed" }],
    coverage: { nodes: ["feed"], edges: [], sourcePaths: ["src/feed"] },
  });
  write(path.join(root, ".tapp/tasks/open-profile.json"), {
    kind: "task", version: 1, name: "openProfile", steps: [{ tap: "Profile" }], coverage: {},
  });
  write(path.join(root, ".tapp/contracts/critical.contract.ts"), contract("revenueWorks", "critical", "openProfile"));
  write(path.join(root, ".tapp/contracts/feed.contract.ts"), contract("feedWorks", "high", "openFeed"));
  write(path.join(root, ".tapp/contracts/profile.contract.ts"), contract("profileWorks", "high", "openProfile"));
  write(path.join(root, ".tapp/ui-map.json"), {
    schemaVersion: 1, coverage: { tasks: [], contracts: [], uncoveredNodeIds: [], uncoveredEdgeIds: [] },
    nodes: [{ id: "screen_feed", semanticKey: "feed", name: "Feed", sourcePaths: ["src/feed/view.ts"], coveredBy: { tasks: [], contracts: [] } }],
    edges: [],
  });
  const plan = await buildPrContractPlan({ projectDir: root, platform: "web", changedFiles: ["src/feed/view.ts", "src/unowned/new.ts"] });
  assert.deepEqual(plan.selected.map((item) => item.name).sort(), ["feedWorks", "revenueWorks"]);
  assert.equal(plan.selected.find((item) => item.name === "feedWorks").reasons.some((reason) => reason.type === "task-source"), true);
  assert.deepEqual(plan.impactedUiMap.nodes, ["screen_feed"]);
  assert.deepEqual(plan.uncoveredChangedFiles, ["src/unowned/new.ts"]);
  assert.equal(plan.maintenanceCandidates[0].contract, "feedWorks");
  assert.deepEqual(plan.maintenanceCandidates[0].tasks, ["openFeed"]);
  assert.deepEqual(plan.maintenanceCandidates[0].taskPaths, [".tapp/tasks/open-feed.json"]);
  assert.deepEqual(plan.skipped.map((item) => item.name), ["profileWorks"]);
});

test("changing a reusable Task selects every contract that composes it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-pr-task-"));
  write(path.join(root, ".tapp/tasks/sign-in.json"), { kind: "task", version: 1, name: "signIn", steps: [{ tap: "Sign in" }] });
  write(path.join(root, ".tapp/contracts/a.contract.ts"), contract("accountWorks", "high", "signIn"));
  write(path.join(root, ".tapp/contracts/b.contract.ts"), contract("checkoutWorks", "high", "signIn"));
  const plan = await buildPrContractPlan({ projectDir: root, changedFiles: [".tapp/tasks/sign-in.json"] });
  assert.deepEqual(plan.selected.map((item) => item.name), ["accountWorks", "checkoutWorks"]);
  assert.equal(plan.selected.every((item) => item.reasons[0].type === "task-changed"), true);
});

test("changing a nested Task selects contracts through the full composition graph", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-pr-nested-task-"));
  write(path.join(root, ".tapp/tasks/fill-form.json"), { kind: "task", version: 1, name: "fillForm", steps: [{ type: { field: "Email", value: "test@example.com" } }] });
  write(path.join(root, ".tapp/tasks/sign-in.json"), { kind: "task", version: 1, name: "signIn", steps: [{ task: "fillForm" }, { tap: "Sign in" }] });
  write(path.join(root, ".tapp/contracts/a.contract.ts"), contract("accountWorks", "high", "signIn"));
  const plan = await buildPrContractPlan({ projectDir: root, changedFiles: [".tapp/tasks/fill-form.json"] });
  assert.deepEqual(plan.selected.map((item) => item.name), ["accountWorks"]);
  assert.deepEqual(plan.selected[0].tasks, ["signIn", "fillForm"]);
  assert.equal(plan.selected[0].reasons.some((reason) => reason.type === "task-changed" && reason.task === "fillForm"), true);
});

test("mapped-but-uncovered UI changes are distinct from files unknown to the application model", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-pr-map-gap-"));
  write(path.join(root, ".tapp/tasks/open-home.json"), { kind: "task", version: 1, name: "openHome", steps: [{ tap: "Home" }] });
  write(path.join(root, ".tapp/contracts/home.contract.ts"), contract("homeWorks", "high", "openHome"));
  write(path.join(root, ".tapp/ui-map.json"), {
    schemaVersion: 1,
    coverage: { tasks: [], contracts: [], uncoveredNodeIds: ["screen_admin"], uncoveredEdgeIds: [] },
    nodes: [{ id: "screen_admin", semanticKey: "admin", name: "Admin", sourcePaths: ["src/admin"], coveredBy: { tasks: [], contracts: [] } }],
    edges: [],
  });
  const plan = await buildPrContractPlan({ projectDir: root, changedFiles: ["src/admin/panel.ts", "src/unknown.ts"] });
  assert.deepEqual(plan.uncoveredChangedFiles, ["src/unknown.ts"]);
  assert.deepEqual(plan.uncoveredUiMap.nodes, ["screen_admin"]);
  assert.equal(plan.explorationTargets[0].navigation.status, "blocked");
});

test("an observed static web route schedules bounded advisory exploration for its exact changed file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-pr-route-target-"));
  write(path.join(root, ".tapp/ui-map.json"), {
    schemaVersion: 1,
    coverage: { tasks: [], contracts: [], uncoveredNodeIds: ["screen_pricing"], uncoveredEdgeIds: [] },
    nodes: [{
      id: "screen_pricing", semanticKey: "pricing", name: "Pricing", sourcePaths: [],
      routes: [{ platform: "web", path: "/pricing.html", replayable: true, status: "observed" }],
      controls: [{ id: "control_buy", semanticKey: "buy", kind: "button", label: "Buy", selectors: [{ kind: "cssId", value: "buy" }] }],
      coveredBy: { tasks: [], contracts: [] },
    }],
    edges: [],
  });
  const plan = await buildPrContractPlan({ projectDir: root, platform: "web", changedFiles: ["pricing.html", "unknown.js"] });
  assert.deepEqual(plan.impactedUiMap.nodes, [], "derived route evidence must not masquerade as reviewed ownership");
  assert.deepEqual(plan.derivedUiMapImpacts.nodes, ["screen_pricing"]);
  assert.deepEqual(plan.uncoveredChangedFiles, ["unknown.js"]);
  assert.deepEqual(plan.uncoveredUiMap.nodes, ["screen_pricing"]);
  assert.equal(plan.explorationTargets.length, 1);
  assert.equal(plan.explorationTargets[0].navigation.route, "/pricing.html");
  assert.equal(plan.explorationTargets[0].evidence[0].provenance, "source-derived");
  assert.deepEqual(plan.explorationTargets[0].baselineControls[0].selectors, [{ kind: "cssId", value: "buy" }]);
  assert.equal(plan.policy.derivedRouteEvidence, "bounded-exploration-only");
});

test("reviewed Task ownership schedules one native changed-surface replay through observed UI Map edges", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-pr-native-target-"));
  write(path.join(root, ".tapp/tasks/open-settings.json"), {
    kind: "task", version: 1, name: "openSettings",
    implementations: { ios: { steps: [{ tap: "Settings" }] } },
    coverage: { nodes: ["settings"], sourcePaths: ["Sources/SettingsView.swift"] },
  });
  write(path.join(root, ".tapp/ui-map.json"), {
    schemaVersion: 1,
    app: { target: "app", platforms: ["ios"], sourceRoot: "", entryNodes: { ios: "screen_welcome" }, navigationRoots: { ios: "screen_home" } },
    coverage: { tasks: [], contracts: [], uncoveredNodeIds: ["screen_settings"], uncoveredEdgeIds: ["edge_settings"] },
    nodes: [
      { id: "screen_welcome", semanticKey: "welcome", name: "Welcome", status: "observed", platforms: ["ios"], controls: [], coveredBy: { tasks: [], contracts: [] } },
      { id: "screen_home", semanticKey: "home", name: "Home", status: "observed", platforms: ["ios"], controls: [{ id: "settings", semanticKey: "settings", label: "Settings", selectors: [{ kind: "accessibilityId", value: "settings_button" }] }], coveredBy: { tasks: [], contracts: [] } },
      { id: "screen_settings", semanticKey: "settings", name: "Settings", status: "observed", platforms: ["ios"], controls: [], coveredBy: { tasks: ["openSettings"], contracts: [] } },
    ],
    edges: [{
      id: "edge_settings", from: "screen_home", to: "screen_settings", status: "observed", confirmed: true, platforms: ["ios"],
      action: { type: "tap", target: "Settings", selectors: [{ kind: "label", value: "Settings" }] },
      preconditions: [], actors: [], wait: { type: "condition", timeoutMs: 6000 }, coveredBy: { tasks: ["openSettings"], contracts: [] },
    }],
  });
  const plan = await buildPrContractPlan({ projectDir: root, platform: "ios", changedFiles: ["Sources/SettingsView.swift"] });
  assert.deepEqual(plan.selected, []);
  assert.deepEqual(plan.uncoveredChangedFiles, []);
  assert.deepEqual(plan.impactedUiMap.nodes, ["screen_settings"]);
  assert.equal(plan.explorationTargets.length, 1);
  assert.equal(plan.explorationTargets[0].navigation.mode, "ui-map-path");
  assert.deepEqual(plan.explorationTargets[0].navigation.steps.map((step) => step.edgeId), ["edge_settings"]);
  assert.equal(plan.explorationTargets[0].evidence[0].provenance, "human-authored-task");
  assert.deepEqual(prExplorationTargetsFromPlan(plan, "ios"), [{
    id: plan.explorationTargets[0].id,
    platform: "ios",
    status: "planned",
    node: { id: "screen_settings", semanticKey: "settings", name: "Settings" },
    navigation: plan.explorationTargets[0].navigation,
    budget: { maxTargetRoutes: 1, maxActions: 12 },
  }]);
});

test("selected critical contract coverage prevents a redundant changed-surface exploration target", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-pr-selected-coverage-"));
  write(path.join(root, ".tapp/tasks/open-pricing.json"), {
    kind: "task", version: 1, name: "openPricing", steps: [{ tap: "Pricing" }], coverage: { nodes: ["pricing"] },
  });
  write(path.join(root, ".tapp/contracts/pricing.contract.ts"), contract("pricingWorks", "critical", "openPricing"));
  write(path.join(root, ".tapp/ui-map.json"), {
    schemaVersion: 1, coverage: { tasks: [], contracts: [], uncoveredNodeIds: [], uncoveredEdgeIds: [] },
    nodes: [{ id: "screen_pricing", semanticKey: "pricing", name: "Pricing", sourcePaths: [], routes: [{ platform: "web", path: "/pricing.html", replayable: true }], controls: [], coveredBy: { tasks: ["openPricing"], contracts: ["pricingWorks"] } }],
    edges: [],
  });
  const plan = await buildPrContractPlan({ projectDir: root, platform: "web", changedFiles: ["pricing.html"] });
  assert.deepEqual(plan.selected[0].coverage.nodes, ["screen_pricing"]);
  assert.deepEqual(plan.uncoveredUiMap.nodes, []);
  assert.deepEqual(plan.explorationTargets, []);
});

test("only planned replayable web exploration targets become bounded gate seeds", () => {
  const target = (route, overrides = {}) => ({ platform: "web", status: "planned", navigation: { status: "replayable", route }, ...overrides });
  assert.deepEqual(webSeedRoutesFromPrPlan({ explorationTargets: [
    target("/pricing.html"),
    target("/pricing.html"),
    target("/admin", { status: "rejected" }),
    target("/native", { platform: "ios" }),
    target("/blocked", { navigation: { status: "blocked" } }),
    target("/status.html"),
  ] }), ["/pricing.html", "/status.html"]);
  assert.deepEqual(webSeedRoutesFromPrPlan({ explorationTargets: [target("/pricing.html")] }, 0), []);
});

test("explicit PR proposal adoption appends one pending item only when map and runtime evidence are current", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-pr-adopt-"));
  const mapNode = { id: "screen_pricing", semanticKey: "pricing", name: "Pricing", status: "observed", routes: [{ platform: "web", path: "/pricing.html", replayable: true }], controls: [] };
  write(path.join(root, ".tapp/ui-map.json"), { schemaVersion: 1, nodes: [mapNode], edges: [] });
  write(path.join(root, ".tapp/release-plan.json"), { schemaVersion: 1, kind: "tapp-release-plan", status: "reviewed", items: [] });
  const proposed = {
    id: "proposal_pricing", kind: "release-contract", name: "pricingReachable", title: "Pricing remains reachable",
    origin: "deterministic-ui-map-proposal", decision: "pending", criticality: "high", businessValue: "Protect pricing",
    actors: ["customer"], tasks: [], platforms: ["web"], groundedBy: [{ type: "ui-map-node", id: "screen_pricing", observationCount: 2 }],
    requiredValidation: "Generate and replay",
  };
  const prPlanPath = path.join(root, "executed-pr-plan.json");
  write(prPlanPath, {
    schemaVersion: 1,
    explorationTargets: [{
      id: "explore_pricing", platform: "web", changedFiles: ["pricing.html"], navigation: { route: "/pricing.html" },
      execution: { status: "observed", conclusive: true },
      coverageProposal: { kind: "release-plan-item-proposal", autoApply: false, operation: { op: "add-item", item: proposed } },
    }],
  });
  const beforePrPlan = fs.readFileSync(prPlanPath, "utf8");
  const adopted = adoptPrCoverageProposal({ projectDir: root, prPlanPath, item: "explore_pricing" });
  assert.equal(adopted.mode, "added");
  assert.equal(adopted.item.decision, "pending");
  assert.equal(adopted.item.adoption.source, "executed-pr-exploration");
  assert.equal(adopted.plan.status, "awaiting-review");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".tapp/release-plan.json"), "utf8")).items.length, 1);
  assert.equal(fs.readFileSync(prPlanPath, "utf8"), beforePrPlan, "adoption must not mutate its evidence artifact");
  const reconciled = adoptPrCoverageProposal({ projectDir: root, prPlanPath, item: "explore_pricing" });
  assert.equal(reconciled.mode, "reconciled-existing");
  assert.equal(reconciled.plan.items.length, 1);
  assert.equal(reconciled.item.decision, "pending");
  assert.equal(reconciled.item.groundedBy.filter((ground) => ground.type === "ui-map-node").length, 1);
});

test("PR proposal adoption refuses unobserved or stale evidence without changing the release plan", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-pr-adopt-stale-"));
  write(path.join(root, ".tapp/ui-map.json"), { schemaVersion: 1, nodes: [], edges: [] });
  const releasePlanPath = path.join(root, ".tapp/release-plan.json");
  write(releasePlanPath, { schemaVersion: 1, kind: "tapp-release-plan", status: "reviewed", items: [] });
  const prPlanPath = path.join(root, "pr-plan.json");
  write(prPlanPath, { schemaVersion: 1, explorationTargets: [{ id: "target", platform: "web", execution: { status: "not-reached", conclusive: false } }] });
  const before = fs.readFileSync(releasePlanPath, "utf8");
  assert.throws(() => adoptPrCoverageProposal({ projectDir: root, prPlanPath, item: "target" }), /no conclusive observed/);
  assert.equal(fs.readFileSync(releasePlanPath, "utf8"), before);
});

test("PR proposal adoption explains how to recover from a stale persistent UI Map", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-pr-adopt-stale-map-"));
  write(path.join(root, ".tapp/ui-map.json"), { schemaVersion: 1, nodes: [], edges: [] });
  const releasePlanPath = path.join(root, ".tapp/release-plan.json");
  write(releasePlanPath, { schemaVersion: 1, kind: "tapp-release-plan", status: "reviewed", items: [] });
  const prPlanPath = path.join(root, "pr-plan.json");
  write(prPlanPath, {
    schemaVersion: 1,
    explorationTargets: [{
      id: "explore_dashboard",
      platform: "web",
      navigation: { route: "/dashboard.html" },
      execution: { status: "observed", conclusive: true },
      coverageProposal: {
        kind: "release-plan-item-proposal",
        autoApply: false,
        operation: {
          op: "add-item",
          item: {
            id: "proposal_dashboard",
            kind: "release-contract",
            name: "dashboardReachable",
            origin: "deterministic-ui-map-proposal",
            decision: "pending",
            groundedBy: [{ type: "ui-map-node", id: "screen_dashboard" }],
          },
        },
      },
    }],
  });
  const before = fs.readFileSync(releasePlanPath, "utf8");
  assert.throws(
    () => adoptPrCoverageProposal({ projectDir: root, prPlanPath, item: "explore_dashboard" }),
    /@aarwitz\/tapp@latest init --explore --refresh.*@aarwitz\/tapp@latest pr gate.*@aarwitz\/tapp@latest pr adopt/,
  );
  assert.equal(fs.readFileSync(releasePlanPath, "utf8"), before);
});

test("changed-file parsing accepts GitHub objects and Git ingestion preserves both sides of renames", () => {
  assert.deepEqual(parseChangedFiles([{ filename: "src/new.ts", previous_filename: "src/old.ts" }]), ["src/new.ts", "src/old.ts"]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-pr-git-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "tapp@example.invalid");
  git("config", "user.name", "Tapp Test");
  write(path.join(root, "old name.txt"), "before\n");
  git("add", "--", "old name.txt");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  fs.renameSync(path.join(root, "old name.txt"), path.join(root, "new name.txt"));
  git("add", "-A");
  git("commit", "-qm", "rename");
  assert.deepEqual(changedFilesFromGit({ projectDir: root, base, head: "HEAD" }), ["new name.txt", "old name.txt"]);
});

test("bounded PR patches expose declaration identities without retaining source hunks", () => {
  const changes = [{
    filename: "app.js",
    patch: "@@ -20,1 +20,1 @@ function showCheckout() {\n-  oldLabel();\n+  newLabel();",
  }];
  assert.deepEqual(parseChangedSymbols(changes), [{ file: "app.js", symbol: "showCheckout", basis: "diff-declaration-or-hunk-context" }]);
  assert.deepEqual(parseChangedDiffEvidence(changes), [{
    file: "app.js", patchAvailable: true, hunks: 1, attributedHunks: 1, precise: true, symbols: ["showCheckout"],
  }]);
});

test("reviewed symbol ownership narrows affected Tasks while preserving the composed contract", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-pr-symbol-"));
  write(path.join(root, ".tapp/tasks/checkout.json"), {
    kind: "task", version: 1, name: "completeCheckout", steps: [{ tap: "Place order" }],
    coverage: { sourcePaths: ["app.js"], sourceSymbols: [{ path: "app.js", symbols: ["showCheckout"] }] },
  });
  write(path.join(root, ".tapp/tasks/orders.json"), {
    kind: "task", version: 1, name: "openOrders", steps: [{ tap: "Orders" }],
    coverage: { sourcePaths: ["app.js"], sourceSymbols: [{ path: "app.js", symbols: ["showOrders"] }] },
  });
  write(path.join(root, ".tapp/contracts/order.contract.ts"), `import { defineContract } from "@aarwitz/tapp/contracts";
export default defineContract({name:"orderPersists",title:"orderPersists",businessValue:"value",criticality:"critical",platforms:["web"],actors:{customer:{}},steps:[{actor:"customer",task:"completeCheckout"},{actor:"customer",task:"openOrders"}]});`);
  const changedFiles = [{ filename: "app.js", patch: "@@ -20,1 +20,1 @@ function showCheckout() {\n-  oldLabel();\n+  newLabel();" }];
  const plan = await buildPrContractPlan({ projectDir: root, platform: "web", changedFiles });
  assert.deepEqual(plan.changedSymbols, [{ file: "app.js", symbol: "showCheckout", basis: "diff-declaration-or-hunk-context" }]);
  assert.equal(plan.selected.length, 1);
  assert.equal(plan.selected[0].reasons.some((reason) => reason.type === "task-symbol" && reason.task === "completeCheckout"), true);
  assert.equal(plan.selected[0].reasons.some((reason) => reason.task === "openOrders"), false);
  assert.deepEqual(plan.maintenanceCandidates[0].tasks, ["completeCheckout"]);
  assert.doesNotMatch(JSON.stringify(plan), /oldLabel|newLabel/, "review artifacts must not retain source hunks");
});

test("unattributable patches fall back to file ownership instead of skipping relevant Tasks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-pr-symbol-fallback-"));
  for (const [name, symbol] of [["completeCheckout", "showCheckout"], ["openOrders", "showOrders"]]) {
    write(path.join(root, `.tapp/tasks/${name}.json`), {
      kind: "task", version: 1, name, steps: [{ tap: name }],
      coverage: { sourcePaths: ["app.js"], sourceSymbols: [{ path: "app.js", symbols: [symbol] }] },
    });
    write(path.join(root, `.tapp/contracts/${name}.contract.ts`), contract(`${name}Works`, "high", name));
  }
  const plan = await buildPrContractPlan({
    projectDir: root,
    platform: "web",
    changedFiles: [{ filename: "app.js", patch: "@@ -1,1 +1,1 @@\n-old();\n+newer();" }],
  });
  assert.deepEqual(plan.selected.map((item) => item.name).sort(), ["completeCheckoutWorks", "openOrdersWorks"]);
  assert.equal(plan.selected.every((item) => item.reasons.some((reason) => reason.type === "task-source" && reason.precision === "file-fallback")), true);
  assert.deepEqual(plan.diffEvidence, [{ file: "app.js", patchAvailable: true, hunks: 1, attributedHunks: 0, precise: false }]);
});

test("local git diffs provide the same changed-symbol evidence as hosted PR patches", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-pr-symbol-git-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "tapp@example.invalid");
  git("config", "user.name", "Tapp Test");
  write(path.join(root, "app.js"), "function showCheckout() {\n  return 'Place order';\n}\n\nfunction showOrders() {\n  return 'Orders';\n}\n");
  git("add", "--", "app.js");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  write(path.join(root, "app.js"), "function showCheckout() {\n  return 'Confirm purchase';\n}\n\nfunction showOrders() {\n  return 'Orders';\n}\n");
  git("add", "--", "app.js");
  git("commit", "-qm", "change checkout label");
  const evidence = changedSymbolEvidenceFromGit({ projectDir: root, base });
  assert.deepEqual(evidence.map((item) => ({ file: item.file, symbols: item.symbols, precise: item.precise })), [
    { file: "app.js", symbols: ["showCheckout"], precise: true },
  ]);
});

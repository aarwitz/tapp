// End-user surface smoke: the CLI answers, and the MCP server completes a real
// initialize → tools/list handshake over stdio (hand-rolled client, no SDK dependency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tappBin = path.join(root, "bin", "tapp.js");
const skipRealBrowser = process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1";

test("tapp version prints the package version", () => {
  const out = execFileSync("node", [tappBin, "version"], { encoding: "utf8" }).trim();
  assert.match(out, /^\d+\.\d+\.\d+$/);
});

test("tapp help leads with the zero-config verbs", () => {
  const out = execFileSync("node", [tappBin], { encoding: "utf8" });
  assert.match(out, /Zero-config verbs/);
  assert.match(out, /tapp qa \[target\]/);
  assert.match(out, /never need to know a bundle id/);
  assert.match(out, /tapp task validate FILE/);
  assert.match(out, /tapp contract validate FILE/);
  assert.match(out, /tapp pr plan --base REF/);
  assert.match(out, /tapp init \[repo\]/);
  assert.match(out, /--explore/);
  assert.match(out, /tapp plan review \[FILE\]/);
  assert.match(out, /tapp plan promote \[FILE\]/);
  assert.match(out, /tapp baseline create \[repo\]/);
  assert.match(out, /tapp actor set NAME/);
});

test("tapp actor configures only environment-variable bindings and lists them without values", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-actor-cli-"));
  const configured = execFileSync("node", [tappBin, "actor", "set", "alice", project, "--role", "member", "--session", "isolated", "--provisioning", "seeded", "--credential", "email=ALICE_EMAIL", "--credential", "password=ALICE_PASSWORD"], { cwd: root, encoding: "utf8" });
  assert.match(configured, /No credential values were accepted or written/);
  const persisted = fs.readFileSync(path.join(project, ".autotap", "project.json"), "utf8");
  assert.match(persisted, /ALICE_EMAIL/);
  assert.doesNotMatch(persisted, /alice@example|password-value/);
  const listed = execFileSync("node", [tappBin, "actor", "list", project], { cwd: root, encoding: "utf8" });
  assert.match(listed, /alice · role member · isolated session · seeded/);
  assert.match(listed, /email=\$ALICE_EMAIL/);
  let rejected;
  try { execFileSync("node", [tappBin, "actor", "set", "bob", project, "--password", "password-value"], { cwd: root, encoding: "utf8", stdio: "pipe" }); }
  catch (error) { rejected = error; }
  assert.match(String(rejected?.stderr || ""), /Credential values are never accepted/);
});

test("tapp validates and compiles a reusable Task without an agent or target", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-task-cli-"));
  const taskDir = path.join(rootDir, ".autotap", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  const taskPath = path.join(taskDir, "open-home.json");
  const compiledPath = path.join(rootDir, "compiled.json");
  fs.writeFileSync(taskPath, JSON.stringify({
    kind: "task", version: 1, name: "openHome",
    preconditions: [{ exists: "Home" }],
    steps: [{ tap: "Home" }, { wait_for: "Dashboard" }],
    postconditions: [{ screen: "Dashboard" }],
    coverage: { nodes: ["home", "dashboard"], edges: [] },
  }));
  const validated = execFileSync("node", [tappBin, "task", "validate", taskPath], { cwd: root, encoding: "utf8" });
  assert.match(validated, /Valid Task — openHome v1/);
  const compiled = execFileSync("node", [tappBin, "task", "compile", taskPath, "--platform", "web", "--out", compiledPath], { cwd: root, encoding: "utf8" });
  assert.match(compiled, /4 deterministic Flow steps/);
  const flow = JSON.parse(fs.readFileSync(compiledPath, "utf8"));
  assert.equal(flow.steps.length, 4);
  assert.equal(flow.steps[1].__tappTask.name, "openHome");
});

test("tapp ci help documents the portable gate without requiring Xcode", () => {
  const out = execFileSync("node", [tappBin, "ci", "--help"], { encoding: "utf8" });
  assert.match(out, /should this merge/i);
  assert.match(out, /bundle id is detected from the \.app when omitted/i);
  assert.match(out, /--json-out/);
});

test("tapp validates a committed Android Flow without an agent or device", () => {
  const out = execFileSync("node", [tappBin, "flow", "validate", "AndroidCorpus/demoapp/.autotap/flows/smoke.yml"], {
    encoding: "utf8", cwd: root,
  });
  assert.match(out, /Valid android Flow/);
  assert.match(out, /7 deterministic steps/);
});

test("tapp validates a committed multi-actor Scenario without a browser or model", () => {
  const out = execFileSync("node", [tappBin, "scenario", "validate", "SocialDemo/.autotap/scenarios/social-system.yml"], {
    cwd: root, encoding: "utf8",
  });
  assert.match(out, /Valid web Scenario/);
  assert.match(out, /2 actors, 39 journey steps/);
});

test("tapp validates and compiles a TypeScript release contract without an agent or target", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-contract-cli-"));
  const outPath = path.join(dir, "social.json");
  const contractPath = "SocialDemo/.autotap/contracts/social-system.contract.ts";
  const validated = execFileSync("node", [tappBin, "contract", "validate", contractPath], { cwd: root, encoding: "utf8" });
  assert.match(validated, /Valid Release Contract/);
  assert.match(validated, /critical, 2 actors/);
  const compiled = execFileSync("node", [tappBin, "contract", "compile", contractPath, "--platform", "web", "--out", outPath], { cwd: root, encoding: "utf8" });
  assert.match(compiled, /deterministic steps \(scenario\)/);
  const execution = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(execution.releaseContract.name, "socialSystemWorks");
  assert.equal(execution.steps.length, 39);
});

test("tapp produces a reviewable PR contract plan from explicit changed files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-pr-cli-"));
  const outPath = path.join(dir, "plan.json");
  const output = execFileSync("node", [tappBin, "pr", "plan", "--project-dir", "SocialDemo", "--platform", "web", "--changed-files", "server.js,unowned.ts", "--json-out", outPath], { cwd: root, encoding: "utf8" });
  assert.match(output, /PR contract plan/);
  const plan = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(plan.selected.some((item) => item.name === "socialSystemWorks"), true);
  assert.deepEqual(plan.uncoveredChangedFiles, ["unowned.ts"]);

  const nativeProject = path.join(dir, "native-project");
  const nativeAutotap = path.join(nativeProject, ".autotap");
  fs.mkdirSync(path.join(nativeAutotap, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(nativeAutotap, "tasks", "open-update-profile.json"), JSON.stringify({
    kind: "task", version: 1, name: "openUpdateProfile",
    implementations: { ios: { steps: [{ tap: "Settings" }, { wait_for: "Settings" }, { tap: "Update Profile" }, { wait_for: "Update Profile" }] } },
    coverage: { nodes: ["update-profile"], edges: ["edge_settings", "edge_profile"], sourcePaths: ["Sources/SettingsView.swift"] },
  }));
  fs.writeFileSync(path.join(nativeAutotap, "ui-map.json"), JSON.stringify({
    schemaVersion: 1,
    app: { target: "com.example.app", platforms: ["ios"], navigationRoots: { ios: "screen_dashboard" } },
    coverage: { tasks: [], contracts: [], uncoveredNodeIds: ["screen_update_profile"], uncoveredEdgeIds: ["edge_settings", "edge_profile"] },
    nodes: [
      { id: "screen_dashboard", semanticKey: "dashboard", name: "Dashboard", status: "observed", platforms: ["ios"], controls: [], coveredBy: { tasks: [], contracts: [] } },
      { id: "screen_settings", semanticKey: "settings", name: "Settings", status: "observed", platforms: ["ios"], controls: [], coveredBy: { tasks: [], contracts: [] } },
      { id: "screen_update_profile", semanticKey: "update-profile", name: "Update Profile", status: "observed", platforms: ["ios"], controls: [], coveredBy: { tasks: ["openUpdateProfile"], contracts: [] } },
    ],
    edges: [
      { id: "edge_settings", from: "screen_dashboard", to: "screen_settings", status: "observed", confirmed: true, platforms: ["ios"], action: { type: "tap", target: "Settings", selectors: [{ kind: "label", value: "Settings" }] }, preconditions: [], actors: [], wait: { type: "condition", timeoutMs: 6000 }, coveredBy: { tasks: ["openUpdateProfile"], contracts: [] } },
      { id: "edge_profile", from: "screen_settings", to: "screen_update_profile", status: "observed", confirmed: true, platforms: ["ios"], action: { type: "tap", target: "Update Profile", selectors: [{ kind: "label", value: "Update Profile" }] }, preconditions: [], actors: [], wait: { type: "condition", timeoutMs: 6000 }, coveredBy: { tasks: ["openUpdateProfile"], contracts: [] } },
    ],
  }));
  const nativeOutput = execFileSync("node", [tappBin, "pr", "plan", "--project-dir", nativeProject, "--platform", "ios", "--changed-files", "Sources/SettingsView.swift"], { cwd: root, encoding: "utf8" });
  assert.match(nativeOutput, /Update Profile — replayable via 2 observed UI Map edge\(s\)/);
  assert.doesNotMatch(nativeOutput, /undefined/);
});

test("tapp init produces a grounded dry-run model and explicit plan review preserves customer choice", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-cli-"));
  const outPath = path.join(dir, "init.json");
  const output = execFileSync("node", [tappBin, "init", "WebDemo", "--url", "http://127.0.0.1:4173", "--dry-run", "--json-out", outPath], { cwd: root, encoding: "utf8" });
  assert.match(output, /targets: web:WebDemo/);
  assert.match(output, /UI Map: observed · 8 states · 7 transitions/);
  assert.match(output, /dry run: repository files were not changed/);
  const initialized = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(initialized.model.kind, "tapp-application-model");
  assert.equal(initialized.plan.items.some((item) => item.name === "signInWorks"), true);
  assert.equal(initialized.plan.items.some((item) => /error|blank/i.test(item.name)), false);

  const planPath = path.join(dir, "release-plan.json");
  fs.writeFileSync(planPath, JSON.stringify(initialized.plan, null, 2));
  const reviewed = execFileSync("node", [tappBin, "plan", "review", planPath, "--approve", "signInWorks", "--reject", "pricingReachable"], { cwd: root, encoding: "utf8" });
  assert.match(reviewed, /1 accepted\/approved · 1 rejected · 0 pending/);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  assert.equal(plan.status, "reviewed");
  assert.equal(plan.items.find((item) => item.name === "signInWorks").decision, "approved");
  assert.equal(plan.items.find((item) => item.name === "pricingReachable").decision, "rejected");
});

test("tapp baseline import and CI install complete the reviewable repository patch without external writes", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-ci-install-cli-"));
  fs.mkdirSync(path.join(project, ".autotap", "contracts"), { recursive: true });
  fs.writeFileSync(path.join(project, "index.html"), "<main>site</main>");
  fs.writeFileSync(path.join(project, ".autotap", "contracts", "home.contract.ts"), "fixture");
  const target = { id: "target_web_site", platform: "web", name: "site", sourcePath: ".", status: "configured", build: { tool: "static-files", dependencyStatus: "not-required" }, runtime: { management: "tapp-managed", ownedUrl: null } };
  const model = { kind: "tapp-application-model", targets: [target], actors: [], artifacts: { contracts: [{ name: "homeWorks", path: ".autotap/contracts/home.contract.ts", scope: ".", platforms: ["web"] }] } };
  fs.writeFileSync(path.join(project, ".autotap", "application-model.json"), JSON.stringify(model));
  const gateReport = path.join(project, "gate-report.json");
  fs.writeFileSync(gateReport, JSON.stringify({ platform: "web", targetKey: target.id, verdict: "ready", inconclusive: false, findings: [], screens: ["Home"], screensExplored: 1, actionsPerformed: 2, flows: [], scenarios: [], contracts: [{ name: "Home works", passed: true }], gate: { failed: false, reasons: [] } }));
  const baseline = execFileSync("node", [tappBin, "baseline", "create", project, "--platform", "web", "--from", gateReport], { cwd: root, encoding: "utf8" });
  assert.match(baseline, /Conclusive baseline established/);
  const installed = execFileSync("node", [tappBin, "ci", "install", project, "--action-ref", "aarwitz/tapp@v0.13.1"], { cwd: root, encoding: "utf8" });
  assert.match(installed, /Reviewable CI gate installed/);
  assert.match(installed, /did not commit, push, enable branch protection, or create GitHub resources/);
  const workflow = fs.readFileSync(path.join(project, ".github", "workflows", "tapp.yml"), "utf8");
  assert.match(workflow, /target-key: "target_web_site"/);
  assert.match(workflow, /baseline: "\.autotap\/baselines\/web\/target_web_site\.json"/);
  const ci = JSON.parse(fs.readFileSync(path.join(project, ".autotap", "ci.json"), "utf8"));
  assert.equal(ci.status, "ready-for-review");
  let collision;
  try { execFileSync("node", [tappBin, "ci", "install", project], { cwd: root, encoding: "utf8", stdio: "pipe" }); }
  catch (error) { collision = error; }
  assert.match(String(collision?.stderr || ""), /never overwrites existing files/);
});

test("tapp init --explore rejects dry-run and safely refreshes existing artifacts through shared semantics", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-explore-preflight-"));
  fs.writeFileSync(path.join(project, "index.html"), "<main>fixture</main>");
  let dryRunFailure;
  try {
    execFileSync("node", [tappBin, "init", project, "--explore", "--dry-run", "--platform", "web", "--url", "http://127.0.0.1:9"], { cwd: root, encoding: "utf8", stdio: "pipe" });
  } catch (error) { dryRunFailure = error; }
  assert.match(String(dryRunFailure?.stderr || ""), /cannot be combined with --dry-run/);

  fs.mkdirSync(path.join(project, ".autotap"), { recursive: true });
  fs.writeFileSync(path.join(project, ".autotap", "application-model.json"), "{}\n");
  const refreshed = execFileSync("node", [tappBin, "init", project, "--explore", "--platform", "web", "--url", "http://127.0.0.1:9"], { cwd: root, encoding: "utf8", stdio: "pipe" });
  assert.match(refreshed, /Tapp init/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, ".autotap", "application-model.json"), "utf8")).kind, "tapp-application-model");
});

test("tapp init --explore starts and stops a detected owned web target when URL is omitted", { skip: skipRealBrowser }, async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-managed-web-"));
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "managed-web", scripts: { start: "node server.js" } }));
  fs.writeFileSync(path.join(project, "index.html"), "<main><h1>Home</h1><a href='/checkout'>Checkout</a></main>");
  fs.writeFileSync(path.join(project, "server.js"), `import http from "node:http";
const port = Number(process.env.PORT);
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(request.url === "/checkout" ? "<main><h1>Checkout</h1></main>" : "<main><h1>Home</h1><a href='/checkout'>Checkout</a></main>");
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);
  const outPath = path.join(project, "init-result.json");
  const home = path.join(project, "tapp-home");
  const output = execFileSync("node", [tappBin, "init", project, "--explore", "--platform", "web", "--actions", "6", "--timeout", "60", "--json-out", outPath], { cwd: root, encoding: "utf8", env: { ...process.env, AUTOTAP_HOME: home } });
  assert.match(output, /managed web runtime/i);
  const result = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(result.exploration.managedRuntime, true);
  assert.match(result.exploration.target, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(result.model.targets[0].runtime.ownedUrl, null, "an ephemeral managed localhost URL must never become durable CI configuration");
  assert.equal(result.model.targets[0].runtime.management, "tapp-managed");
  assert.equal(result.model.targets[0].build.install, null);
  await assert.rejects(fetch(result.exploration.target), /fetch failed|ECONNREFUSED/i, "managed runtime is torn down after evidence capture");
});

test("tapp init --explore grounds a fresh repository map before proposing contracts", { skip: skipRealBrowser }, async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-explore-cli-"));
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "fresh-partner", scripts: { start: "node server.js" } }));
  fs.writeFileSync(path.join(project, "index.html"), "<main><h1>Home</h1><a href='/checkout.html'>Checkout</a></main>");
  fs.writeFileSync(path.join(project, "checkout.html"), "<main><h1>Checkout</h1><button id='place-order'>Place order</button></main>");
  const outPath = path.join(project, "init-result.json");
  const port = 44000 + (process.pid % 1000);
  const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: project, stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const output = execFileSync("node", [tappBin, "init", project, "--explore", "--platform", "web", "--url", `http://127.0.0.1:${port}`, "--actions", "6", "--timeout", "60", "--json-out", outPath], { cwd: root, encoding: "utf8" });
    assert.match(output, /Exploration: .*evidence:/);
    assert.match(output, /UI Map: observed/);
    assert.equal(fs.existsSync(path.join(project, ".autotap", "ui-map.json")), true);
    const result = JSON.parse(fs.readFileSync(outPath, "utf8"));
    const persistedMap = JSON.parse(fs.readFileSync(path.join(project, ".autotap", "ui-map.json"), "utf8"));
    assert.equal(persistedMap.provenance.lastRun.id, result.exploration.capture.id);
    assert.equal(persistedMap.provenance.lastRun.platform, "web");
    assert.equal(typeof persistedMap.provenance.lastRun.inconclusive, "boolean");
    assert.ok(result.model.uiMap.nodeCount >= 2);
    assert.equal(result.exploration.platform, "web");
    assert.equal(result.exploration.uiMapPath, path.join(fs.realpathSync(project), ".autotap", "ui-map.json"));
    assert.equal(result.plan.items.some((item) => item.origin === "deterministic-ui-map-proposal"), true);
    const checkout = result.plan.items.find((item) => item.name === "checkoutReachable");
    assert.ok(checkout, "runtime map proposes the observed checkout surface");
    const planPath = path.join(project, ".autotap", "release-plan.json");
    execFileSync("node", [tappBin, "plan", "review", planPath, "--approve", checkout.id], { cwd: root, encoding: "utf8" });
    const generated = execFileSync("node", [tappBin, "plan", "generate", planPath, "--project-dir", project], { cwd: root, encoding: "utf8" });
    assert.match(generated, /1 grounded Task draft/);
    assert.equal(fs.existsSync(path.join(project, ".autotap", "proposals", "tasks", "open-checkout.task.json")), true);
    const validated = execFileSync("node", [tappBin, "plan", "validate", planPath, "--project-dir", project, "--platform", "web", "--url", `http://127.0.0.1:${port}`], { cwd: root, encoding: "utf8" });
    assert.match(validated, /1 passed · 0 failed on web/);
    const validatedPlan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    assert.equal(validatedPlan.items.find((item) => item.id === checkout.id).generation.trusted, true);
    assert.equal(validatedPlan.generation.generatedTasks.find((item) => item.name === "openCheckout").trusted, true);
    const validatedTask = JSON.parse(fs.readFileSync(path.join(project, ".autotap", "proposals", "tasks", "open-checkout.task.json"), "utf8"));
    assert.equal(validatedTask.generation.trusted, true);
    assert.equal(validatedTask.generation.realValidation.web.status, "passed");
    assert.match(validatedTask.generation.realValidation.web.evidence, /flow-web-/);
    const promoted = execFileSync("node", [tappBin, "plan", "promote", planPath, "--project-dir", project, "--item", checkout.id], { cwd: root, encoding: "utf8" });
    assert.match(promoted, /1 Task\(s\) · 1 release contract\(s\)/);
    assert.equal(fs.existsSync(path.join(project, ".autotap", "tasks", "open-checkout.task.json")), true);
    assert.equal(fs.existsSync(path.join(project, ".autotap", "contracts", "checkout-reachable.contract.ts")), true);
    assert.equal(fs.existsSync(path.join(project, ".autotap", "proposals", "tasks", "open-checkout.task.json")), false);
    const promotedPlan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    assert.equal(promotedPlan.items.find((item) => item.id === checkout.id).generation.status, "promoted");
  } finally {
    server.kill();
  }
});

test("tapp init discovers, validates, and fault-checks a grounded cross-actor contract from a contract-free repository", { skip: skipRealBrowser }, async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-cross-actor-discovery-cli-"));
  for (const file of ["package.json", "index.html", "app.js", "styles.css", "server.js"]) fs.copyFileSync(path.join(root, "SocialDemo", file), path.join(project, file));
  fs.mkdirSync(path.join(project, ".autotap"), { recursive: true });
  fs.cpSync(path.join(root, "SocialDemo", ".autotap", "tasks"), path.join(project, ".autotap", "tasks"), { recursive: true });
  fs.copyFileSync(path.join(root, "SocialDemo", ".autotap", "project.json"), path.join(project, ".autotap", "project.json"));
  const actorEnv = { ...process.env, ALICE_EMAIL: "alice@example.test", ALICE_PASSWORD: "demo", BOB_EMAIL: "bob@example.test", BOB_PASSWORD: "demo", OCQA_TEST_EMAIL: "alice@example.test", OCQA_TEST_PASSWORD: "demo", AUTOTAP_HOME: path.join(project, "tapp-home") };
  const initPath = path.join(project, "init.json");
  const initialized = execFileSync("node", [tappBin, "init", project, "--explore", "--platform", "web", "--actions", "15", "--timeout", "120", "--email", "alice@example.test", "--password", "demo", "--json-out", initPath], { cwd: root, encoding: "utf8", env: actorEnv });
  assert.match(initialized, /UI Map: observed · 3 states · 2 transitions/);
  const planPath = path.join(project, ".autotap", "release-plan.json");
  let plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const proposal = plan.items.find((item) => item.origin === "deterministic-cross-actor-proposal");
  assert.equal(proposal.name, "postPropagatesAcrossActors");
  assert.deepEqual(proposal.actors, ["alice", "bob"]);
  assert.equal(plan.items.some((item) => ["signInWorks", "createPostWorks"].includes(item.name)), false);
  execFileSync("node", [tappBin, "plan", "review", planPath, "--approve", proposal.id], { cwd: root, encoding: "utf8", env: actorEnv });
  const generated = execFileSync("node", [tappBin, "plan", "generate", planPath, "--project-dir", project], { cwd: root, encoding: "utf8", env: actorEnv });
  assert.match(generated, /web:17/);

  const port = 46000 + (process.pid % 1000);
  const waitForServer = async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}`)).ok) return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("cross-actor fixture did not start");
  };
  const stopServer = async (server) => {
    if (!server || server.exitCode !== null) return;
    server.kill("SIGTERM");
    await new Promise((resolve) => { server.once("exit", resolve); setTimeout(resolve, 1000); });
  };
  let server;
  try {
    const validated = execFileSync("node", [tappBin, "plan", "validate", planPath, "--project-dir", project, "--platform", "web", "--item", proposal.id], { cwd: root, encoding: "utf8", env: actorEnv });
    assert.match(validated, /RELEASE CONTRACT PASSED/);
    assert.match(validated, /19\/19 steps/);
    plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    assert.equal(plan.items.find((item) => item.id === proposal.id).generation.trusted, true);
    const promoted = execFileSync("node", [tappBin, "plan", "promote", planPath, "--project-dir", project, "--item", proposal.id], { cwd: root, encoding: "utf8", env: actorEnv });
    assert.match(promoted, /1 release contract\(s\)/);
    const contractPath = path.join(project, ".autotap", "contracts", "post-propagates-across-actors.contract.ts");
    assert.equal(fs.existsSync(contractPath), true);

    server = spawn("node", ["server.js"], { cwd: project, stdio: "ignore", env: { ...actorEnv, PORT: String(port), SOCIAL_DEMO_PROPAGATION_MS: "50", SOCIAL_DEMO_FAULT: "hide-cross-actor-posts" } });
    await waitForServer();
    const reportPath = path.join(project, "fault-gate.json");
    let fault;
    try {
      execFileSync("bash", [path.join(root, "scripts", "ci-gate.sh"), "--platform", "web", "--url", `http://127.0.0.1:${port}`, "--project-dir", project, "--contracts", contractPath, "--actions", "10", "--timeout", "120", "--fail-on", "gate", "--json-out", reportPath], { cwd: root, encoding: "utf8", env: actorEnv, stdio: "pipe" });
    } catch (error) { fault = error; }
    assert.equal(fault?.status, 1);
    assert.match(String(fault?.stdout || ""), /Release Contracts — 🔴 1\/1 failed/);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.verdict, "ready", "single-user exploration remains green under the cross-account-only defect");
    assert.equal(report.contracts[0].passed, false);
    assert.equal(report.contracts[0].steps.find((step) => step.status === "fail").actor, "bob");
    assert.equal(report.gate.failed, true);
    assert.match(report.gate.reasons.join("; "), /release contract/);
  } finally {
    await stopServer(server);
  }
});

test("tapp init discovers, validates, and fault-checks a durable checkout contract from a contract-free repository", { skip: skipRealBrowser }, () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-durable-checkout-discovery-cli-"));
  for (const file of ["package.json", "index.html", "app.js", "styles.css", "server.js"]) fs.copyFileSync(path.join(root, "CommerceDemo", file), path.join(project, file));
  fs.mkdirSync(path.join(project, ".autotap"), { recursive: true });
  fs.cpSync(path.join(root, "CommerceDemo", ".autotap", "tasks"), path.join(project, ".autotap", "tasks"), { recursive: true });
  fs.copyFileSync(path.join(root, "CommerceDemo", ".autotap", "project.json"), path.join(project, ".autotap", "project.json"));
  const runtimeEnv = { ...process.env, AUTOTAP_HOME: path.join(project, "tapp-home") };
  const initPath = path.join(project, "init.json");
  const initialized = execFileSync("node", [tappBin, "init", project, "--explore", "--platform", "web", "--actions", "14", "--timeout", "120", "--json-out", initPath], { cwd: root, encoding: "utf8", env: runtimeEnv });
  assert.match(initialized, /UI Map: observed · 5 states · 4 transitions/);
  const planPath = path.join(project, ".autotap", "release-plan.json");
  let plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const proposal = plan.items.find((item) => item.origin === "deterministic-business-effect-proposal");
  assert.equal(proposal.name, "checkoutCreatesDurableOrder");
  assert.equal(proposal.criticality, "critical");
  assert.deepEqual(proposal.tasks, ["completeCheckout", "openOrders"]);
  assert.equal(proposal.groundedBy.filter((item) => item.type === "ui-map-node").length, 3);
  assert.equal(plan.items.some((item) => ["completeCheckoutWorks", "openOrdersWorks"].includes(item.name)), false);

  execFileSync("node", [tappBin, "plan", "review", planPath, "--approve", proposal.id], { cwd: root, encoding: "utf8", env: runtimeEnv });
  const generated = execFileSync("node", [tappBin, "plan", "generate", planPath, "--project-dir", project], { cwd: root, encoding: "utf8", env: runtimeEnv });
  assert.match(generated, /web:14/);
  const validated = execFileSync("node", [tappBin, "plan", "validate", planPath, "--project-dir", project, "--platform", "web", "--item", proposal.id], { cwd: root, encoding: "utf8", env: runtimeEnv });
  assert.match(validated, /RELEASE CONTRACT PASSED/);
  assert.match(validated, /16\/16 steps/);
  plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  assert.equal(plan.items.find((item) => item.id === proposal.id).generation.trusted, true);
  execFileSync("node", [tappBin, "plan", "promote", planPath, "--project-dir", project, "--item", proposal.id], { cwd: root, encoding: "utf8", env: runtimeEnv });
  const contractPath = path.join(project, ".autotap", "contracts", "checkout-creates-durable-order.contract.ts");
  assert.equal(fs.existsSync(contractPath), true);

  const reportPath = path.join(project, "fault-gate.json");
  const behaviorChangesPath = path.join(project, "behavior-changes.json");
  const behaviorPlanPath = path.join(project, "behavior-pr-plan.json");
  fs.writeFileSync(behaviorChangesPath, JSON.stringify(["server.js"]));
  let fault;
  try {
    execFileSync("bash", [path.join(root, "scripts", "ci-gate.sh"), "--platform", "web", "--project-dir", project, "--contracts", contractPath, "--changed-files-file", behaviorChangesPath, "--pr-plan-out", behaviorPlanPath, "--actions", "14", "--timeout", "120", "--fail-on", "gate", "--json-out", reportPath], {
      cwd: root, encoding: "utf8", env: { ...runtimeEnv, COMMERCE_DEMO_FAULT: "drop-order-history" }, stdio: "pipe",
    });
  } catch (error) { fault = error; }
  assert.equal(fault?.status, 1);
  assert.match(String(fault?.stdout || ""), /Release Contracts — 🔴 1\/1 failed/);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.verdict, "ready", "generic crawling remains green when confirmation succeeds but durable state is lost");
  assert.equal(report.contracts[0].passed, false);
  assert.equal(report.contracts[0].steps.find((step) => step.status === "fail").target, "Tapp Pro Plan");
  assert.equal(report.prPlan.maintenanceCandidates[0].proposal.kind, "task-maintenance-candidate");
  assert.equal(report.prPlan.maintenanceCandidates[0].proposal.status, "unclassified", "a behavioral assertion failure must not produce a selector patch");
  assert.equal(report.gate.failed, true);
  assert.match(report.gate.reasons.join("; "), /release contract/);

  const appPath = path.join(project, "app.js");
  const renamedApp = fs.readFileSync(appPath, "utf8").replace(">Place order</button>", ">Confirm purchase</button>");
  assert.notEqual(renamedApp, fs.readFileSync(appPath, "utf8"));
  fs.writeFileSync(appPath, renamedApp);
  const selectorChangesPath = path.join(project, "selector-changes.json");
  const selectorPlanPath = path.join(project, "selector-pr-plan.json");
  const selectorReportPath = path.join(project, "selector-gate.json");
  fs.writeFileSync(selectorChangesPath, JSON.stringify([{
    filename: "app.js",
    patch: "@@ -20,1 +20,1 @@ function showCheckout() {\n-  <button id=\"place-order\">Place order</button>\n+  <button id=\"place-order\">Confirm purchase</button>",
  }]));
  let selectorFailure;
  try {
    execFileSync("bash", [path.join(root, "scripts", "ci-gate.sh"), "--platform", "web", "--project-dir", project, "--contracts", contractPath, "--changed-files-file", selectorChangesPath, "--pr-plan-out", selectorPlanPath, "--actions", "14", "--timeout", "120", "--fail-on", "gate", "--json-out", selectorReportPath], {
      cwd: root, encoding: "utf8", env: runtimeEnv, stdio: "pipe",
    });
  } catch (error) { selectorFailure = error; }
  assert.equal(selectorFailure?.status, 1);
  const selectorReport = JSON.parse(fs.readFileSync(selectorReportPath, "utf8"));
  assert.deepEqual(selectorReport.prPlan.changedSymbols, [{ file: "app.js", symbol: "showCheckout", basis: "diff-declaration-or-hunk-context" }]);
  assert.deepEqual(selectorReport.prPlan.maintenanceCandidates[0].tasks, ["completeCheckout"], "reviewed symbol ownership excludes the unrelated order-history Task");
  const maintenance = selectorReport.prPlan.maintenanceCandidates[0].proposal;
  assert.equal(maintenance.kind, "task-maintenance-patch");
  assert.equal(maintenance.status, "validated-awaiting-review");
  assert.equal(maintenance.autoApply, false);
  assert.equal(maintenance.operations.length, 1);
  assert.equal(maintenance.operations[0].taskPath, ".autotap/tasks/complete-checkout.yml");
  assert.equal(maintenance.operations[0].pointer, "/implementations/web/steps/4/tap");
  assert.equal(maintenance.operations[0].before, "Place order");
  assert.equal(maintenance.operations[0].after, "place-order");
  assert.equal(maintenance.operations[0].evidence.currentLabel, "Confirm purchase");
  assert.equal(maintenance.validation.status, "passed");
  assert.equal(maintenance.validation.passed, true);
  assert.equal(maintenance.validation.disposable, true);
  assert.equal(maintenance.validation.sourceArtifactsUnchanged, true);
  assert.equal(maintenance.validation.executed, 16);
  assert.equal(maintenance.validation.total, 16);
  assert.equal(fs.existsSync(maintenance.validation.evidence.logPath), true);
  assert.match(maintenance.validation.evidence.artifactPath, /^maintenance\/checkoutCreatesDurableOrder$/);
  assert.equal(selectorReport.contracts[0].passed, false, "the current gate stays red until review and validation");

  const contractIntent = fs.readFileSync(contractPath, "utf8");
  const taskPath = path.join(project, maintenance.operations[0].taskPath);
  const taskSource = fs.readFileSync(taskPath, "utf8");
  assert.equal(taskSource.split("      - tap: Place order\n").length - 1, 1);
  fs.writeFileSync(taskPath, taskSource.replace("      - tap: Place order\n", "      - tap: place-order\n"));
  const patchedReportPath = path.join(project, "patched-gate.json");
  const patched = execFileSync("bash", [path.join(root, "scripts", "ci-gate.sh"), "--platform", "web", "--project-dir", project, "--contracts", contractPath, "--actions", "14", "--timeout", "120", "--fail-on", "gate", "--json-out", patchedReportPath], { cwd: root, encoding: "utf8", env: runtimeEnv });
  assert.match(patched, /Release Contracts — 🟢 1\/1 passed/);
  const patchedReport = JSON.parse(fs.readFileSync(patchedReportPath, "utf8"));
  assert.equal(patchedReport.contracts[0].passed, true);
  assert.equal(patchedReport.contracts[0].executed, 16);
  assert.equal(fs.readFileSync(contractPath, "utf8"), contractIntent, "Task maintenance preserves the reviewed business contract byte-for-byte");
});

test("tapp plan generate stays untrusted until tapp plan validate replays the draft on a real target", { skip: skipRealBrowser }, async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-plan-generate-cli-"));
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "draft-fixture", scripts: { start: "vite" }, dependencies: { vite: "1" } }));
  fs.writeFileSync(path.join(project, "index.html"), "<main><h1>Home</h1><button>Home</button></main>");
  fs.mkdirSync(path.join(project, ".autotap", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(project, ".autotap", "tasks", "open-home.json"), JSON.stringify({ kind: "task", version: 1, name: "openHome", implementations: { web: [{ tap: "Home" }] }, postconditions: [{ screen: "Home" }] }));
  execFileSync("node", [tappBin, "init", project, "--url", "http://127.0.0.1:4173"], { cwd: root, encoding: "utf8" });
  const planPath = path.join(project, ".autotap", "release-plan.json");
  execFileSync("node", [tappBin, "plan", "review", planPath, "--approve", "openHomeWorks"], { cwd: root, encoding: "utf8" });
  const generated = execFileSync("node", [tappBin, "plan", "generate", planPath, "--project-dir", project], { cwd: root, encoding: "utf8" });
  assert.match(generated, /1 compile-checked\/untrusted · 0 blocked/);
  assert.match(generated, /real replay still required/);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const result = plan.generation.generated[0];
  assert.equal(result.trusted, false);
  assert.equal(result.staticValidation[0].platform, "web");
  assert.equal(fs.existsSync(path.join(project, result.path)), true);
  const port = 43000 + (process.pid % 1000);
  const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: project, stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const validated = execFileSync("node", [tappBin, "plan", "validate", planPath, "--project-dir", project, "--platform", "web", "--url", `http://127.0.0.1:${port}`], { cwd: root, encoding: "utf8" });
    assert.match(validated, /RELEASE CONTRACT PASSED/);
    assert.match(validated, /1 passed · 0 failed on web/);
    const validatedPlan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    assert.equal(validatedPlan.items.find((item) => item.name === "openHomeWorks").generation.status, "validated-draft");
    assert.equal(validatedPlan.items.find((item) => item.name === "openHomeWorks").generation.trusted, true);
  } finally {
    server.kill();
  }
});

test("tapp builds and inspects a repository-native UI Map from shared markers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-map-cli-"));
  const markers = path.join(dir, "markers.txt");
  const outPath = path.join(dir, "ui-map.json");
  fs.writeFileSync(markers, [
    'OCQA_STATE:{"screen":"Home","role":"screen","controls":[{"kind":"button","label":"Settings","id":"settings"}]}',
    'OCQA_ACTION:{"type":"tap","target":"Settings","screen":"Home"}',
    'OCQA_TRANSITION:{"from":"Home","to":"Settings","action":"Settings","changed":true}',
    'OCQA_STATE:{"screen":"Settings","role":"settings","controls":[]}',
  ].join("\n") + "\n");
  const built = execFileSync("node", [tappBin, "map", "build", markers, "--platform", "web", "--out", outPath], { cwd: root, encoding: "utf8" });
  assert.match(built, /2 states · 1 transitions · 1 controls/);
  const inspected = execFileSync("node", [tappBin, "map", "inspect", outPath], { cwd: root, encoding: "utf8" });
  assert.match(inspected, /UI Map v1/);
  assert.match(inspected, /Settings/);
});

test("MCP stdio handshake: initialize + tools/list", async () => {
  const proc = spawn("node", [tappBin, "mcp"], { stdio: ["pipe", "pipe", "ignore"] });
  const send = (obj) => proc.stdin.write(JSON.stringify(obj) + "\n");
  const responses = new Map();
  let buffer = "";
  proc.stdout.on("data", (d) => {
    buffer += String(d);
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) responses.set(msg.id, msg);
      } catch { /* non-JSON noise */ }
    }
  });
  const waitFor = (id, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (responses.has(id)) return resolve(responses.get(id));
        if (Date.now() - t0 > timeoutMs) return reject(new Error(`no response for id ${id}`));
        setTimeout(tick, 50);
      };
      tick();
    });

  try {
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "tapp-ci", version: "0" } },
    });
    const init = await waitFor(1);
    assert.equal(init.result.serverInfo.name, "tapp-mcp");
    assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+$/, "handshake reports a real version");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = await waitFor(2);
    const names = tools.result.tools.map((t) => t.name);
    assert.ok(names.length >= 15, `expected a full toolset, got ${names.length}`);
    for (const required of ["tapp_run_qa", "tapp_build", "tapp_open_app", "tapp_session_act", "tapp_scenario_run", "tapp_init", "tapp_actor_config", "tapp_release_plan", "tapp_ci_setup", "tapp_ui_map", "tapp_task", "tapp_release_contract", "tapp_pr_plan"]) {
      assert.ok(names.includes(required), `${required} present`);
    }
    const qa = tools.result.tools.find((t) => t.name === "tapp_run_qa");
    assert.ok(qa.inputSchema.properties.androidAppId, "Android QA target is public");
    const flow = tools.result.tools.find((t) => t.name === "tapp_flow_run");
    assert.ok(flow.inputSchema.properties.androidAppId, "Android Flow override is public");
    const initTool = tools.result.tools.find((t) => t.name === "tapp_init");
    assert.ok(initTool.inputSchema.properties.operation.enum.includes("explore"), "init exposes the shared real-surface exploration operation");
    for (const input of ["target", "appBundleId", "androidAppId", "apkPath", "maxActions", "timeout"]) {
      assert.ok(initTool.inputSchema.properties[input], `init explore exposes ${input}`);
    }
    const releasePlanTool = tools.result.tools.find((t) => t.name === "tapp_release_plan");
    assert.ok(releasePlanTool.inputSchema.properties.operation.enum.includes("validate"), "release-plan lifecycle exposes real deterministic draft validation");
    assert.ok(releasePlanTool.inputSchema.properties.operation.enum.includes("promote"), "release-plan lifecycle exposes explicit validated promotion");
    assert.ok(releasePlanTool.inputSchema.properties.items, "promotion can be constrained to reviewed item ids");
    const ciSetup = tools.result.tools.find((t) => t.name === "tapp_ci_setup");
    assert.deepEqual(ciSetup.inputSchema.properties.operation.enum, ["inspect", "install", "baseline"]);
    const actorConfig = tools.result.tools.find((t) => t.name === "tapp_actor_config");
    assert.deepEqual(actorConfig.inputSchema.properties.operation.enum, ["read", "set"]);
    assert.match(actorConfig.description, /never accepts, returns, or persists credential values/);
    assert.ok(ciSetup.inputSchema.properties.target, "baseline setup selects an application-model target explicitly");
    const prPlanTool = tools.result.tools.find((t) => t.name === "tapp_pr_plan");
    assert.deepEqual(prPlanTool.inputSchema.properties.operation.enum, ["plan", "adopt"]);
    assert.ok(prPlanTool.inputSchema.properties.prPlanPath, "PR evidence adoption is explicit in MCP");
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tapp_init", arguments: { operation: "inspect", projectDir: "WebDemo", platform: "web", url: "http://127.0.0.1:4173" } } });
    const initialized = await waitFor(3);
    assert.equal(initialized.result.structuredContent.model.kind, "tapp-application-model");
    assert.equal(initialized.result.structuredContent.model.uiMap.nodeCount, 8);
    assert.equal(initialized.result.structuredContent.plan.items.some((item) => item.name === "signInWorks"), true);
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "tapp_actor_config", arguments: { operation: "read", projectDir: "SocialDemo" } } });
    const actors = await waitFor(4);
    assert.equal(actors.result.structuredContent.actors.alice.credentials.email.env, "ALICE_EMAIL");
    assert.equal(actors.result.structuredContent.actors.bob.session, "isolated");
    assert.doesNotMatch(JSON.stringify(actors.result.structuredContent), /alice@example\.test|"demo"/);
  } finally {
    proc.kill();
  }
});

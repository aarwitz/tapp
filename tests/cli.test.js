// End-user surface smoke: the CLI answers, and the MCP server completes a real
// initialize → tools/list handshake over stdio (hand-rolled client, no SDK dependency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildUiMapFromMarkers } from "../mcp-server/src/ui-map.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tappBin = path.join(root, "bin", "tapp.js");
const cliSource = fs.readFileSync(tappBin, "utf8");
const skipRealBrowser = process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1";
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const hasSocialDemo = fs.existsSync(path.join(root, "SocialDemo"));
const hasCommerceDemo = fs.existsSync(path.join(root, "CommerceDemo"));
const hasWebDemo = fs.existsSync(path.join(root, "WebDemo"));

test("npm package is @aarwitz/tapp while the installed command remains tapp", () => {
  assert.equal(rootPackage.name, "@aarwitz/tapp");
  assert.deepEqual(rootPackage.bin, { tapp: "bin/tapp.js" });
});

test("tapp version prints the package version", () => {
  const out = execFileSync("node", [tappBin, "version"], { encoding: "utf8" }).trim();
  assert.equal(out, rootPackage.version);
});

test("Flow CLI only advertises evidence after a runner writes artifacts", () => {
  const flowCommand = cliSource.match(/case "flow":[\s\S]*?case "contract":/)?.[0] || "";
  assert.match(flowCommand, /const evidenceWritten = fs\.existsSync\(evidenceDir\)/);
  assert.match(flowCommand, /Evidence unavailable — the platform runner did not write any artifacts/);
});

test("tapp help presents a Core / Primitives / Advanced hierarchy", () => {
  const out = execFileSync("node", [tappBin], { encoding: "utf8" });
  // Core leads with the user journey while keeping contract replay and the gate visible.
  assert.match(out, /agent-driven app testing for iOS, Android, and web/);
  assert.match(out, /Core — inspect, explore, gate/);
  assert.match(out, /no Tapp account or server required/);
  assert.match(out, /tapp explore \[target\]/);
  assert.match(out, /tapp focus "goal" \[target\]/);
  assert.match(out, /tapp contract run FILE/);
  assert.match(out, /tapp ci \.\.\./);
  assert.doesNotMatch(out, /tapp qa \[target\]/); // renamed to explore (qa is a hidden alias)
  // Primitives, then Advanced (lifecycle/compilers) below.
  assert.match(out, /Primitives —/);
  assert.match(out, /tapp tree \[target\]/);
  assert.match(out, /Advanced —/);
  assert.match(out, /never need to know a bundle id/);
  // Key verbs remain present (just reorganized).
  assert.match(out, /tapp task validate FILE/);
  assert.match(out, /tapp pr plan --base REF/);
  assert.match(out, /tapp init \[repo\]/);
  assert.match(out, /--explore/);
  assert.match(out, /web: --watch/);
  assert.match(out, /tapp plan review \[FILE\]/);
  assert.match(out, /tapp plan promote \[FILE\]/);
  assert.match(out, /tapp baseline create \[repo\]/);
  assert.match(out, /tapp actor set NAME/);
  assert.match(out, /npx -y skills add aarwitz\/tapp --skill tapp/);
  assert.match(out, /Agent Skill \(recommended/);
  assert.match(out, /claude plugin install tapp@tapp/);
});

test("--help is safe on every verb — shows the reference, writes NOTHING (not even TAPP_HOME)", () => {
  // A fresh TAPP_HOME that does not exist yet — --help must not create it.
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tapp-help-home-")), "home");
  const env = { ...process.env, TAPP_HOME: home };
  const root = execFileSync("node", [tappBin, "--help"], { encoding: "utf8", env });
  assert.match(root, /tapp explore \[target\]/);
  assert.equal(fs.existsSync(home), false, "root --help must not create TAPP_HOME");
  const explore = execFileSync("node", [tappBin, "explore", "--help"], { encoding: "utf8", env });
  assert.match(explore, /full command reference/);
  assert.match(explore, /tapp explore \[target\]/);
  assert.match(explore, /--launch-env/);
  assert.match(explore, /--watch/);
  assert.doesNotMatch(explore, /Core — explore, prove, gate/, "verb help must not repeat the entire root reference");
  const focus = execFileSync("node", [tappBin, "focus", "--help"], { encoding:"utf8", env });
  assert.match(focus, /tapp focus "SCREEN OR CONTROL"/);
  const task = execFileSync("node", [tappBin, "task", "run", "--help"], { encoding: "utf8", env });
  assert.match(task, /tapp task run FILE --platform PLATFORM/);
  const contract = execFileSync("node", [tappBin, "contract", "run", "--help"], { encoding: "utf8", env });
  assert.match(contract, /tapp contract run FILE --platform PLATFORM/);
  const ciInstall = execFileSync("node", [tappBin, "ci", "install", "--help"], { encoding: "utf8", env });
  assert.match(ciInstall, /tapp ci install \[repo\]/);
  // The dangerous case: init --help must NOT create project artifacts...
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-help-safe-"));
  execFileSync("node", [tappBin, "init", "--help"], { cwd: dir, encoding: "utf8", env });
  assert.equal(fs.existsSync(path.join(dir, ".tapp")), false, "init --help must not write project artifacts");
  // ...and no verb's --help may create TAPP_HOME.
  assert.equal(fs.existsSync(home), false, "--help must not create TAPP_HOME");
});

test("unknown commands fail as usage errors without writing TAPP_HOME", () => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tapp-unknown-home-")), "home");
  const env = { ...process.env, TAPP_HOME: home };
  const result = spawnSync("node", [tappBin, "definitely-not-a-command"], { encoding: "utf8", env });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown command: definitely-not-a-command/);
  assert.match(result.stderr, /npx -y @aarwitz\/tapp@latest --help/);
  assert.equal(fs.existsSync(home), false, "an invalid command must not create TAPP_HOME");
});

test("iOS explore accepts explicit launch configuration and rejects malformed launch environments before runtime work", () => {
  const bad = spawnSync("node", [tappBin, "explore", "com.example.app", "--launch-env", "[]"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--launch-env must be a JSON object with string values/);
  assert.match(cliSource, /repeatedFlagValues\(argv, "launch-arg"\)/);
  assert.match(cliSource, /args: \{ testEmail: flags\.email, testPassword: flags\.password, baselineFindings, \.\.\.launchOptions \}/);
});

test("watch mode fails clearly before native runtime work", () => {
  const result = spawnSync("node", [tappBin, "explore", "com.example.app", "--platform", "android", "--watch"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--watch is currently available for web exploration only/);
});

test("tapp doctor keeps the package-only CLI path primary", () => {
  const out = execFileSync("node", [tappBin, "doctor"], { cwd: root, encoding: "utf8" });
  assert.match(out, /Ready\. Start with:/);
  assert.match(out, /@aarwitz\/tapp@latest open \[target\]/);
  assert.match(out, /@aarwitz\/tapp@latest explore \[target\]/);
  assert.match(out, /Android source builds/);
  assert.doesNotMatch(out, /claude mcp add|@aarwitz\/tapp mcp/);
});

test("tapp doctor does not call web ready when Playwright exists but Chromium is absent", () => {
  const browsers = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-empty-browsers-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-doctor-home-"));
  const run = spawnSync("node", [tappBin, "doctor"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers, TAPP_HOME: home },
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Playwright installed; Chromium browser missing/);
  assert.doesNotMatch(run.stdout, /✅ Web/);
});

test("tapp report latest picks the newest capture WITH exploration markers, skipping flow/scenario dirs", () => {
  // The captures directory fills with flow-*/scenario-* evidence dirs that have no ocqa-markers.txt.
  // `report` (latest) must resolve to the newest capture that actually has exploration markers, or it
  // fails despite valid captures being present.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-report-latest-"));
  const captures = path.join(home, "captures");
  fs.mkdirSync(captures, { recursive: true });
  const mk = (name, withMarkers, mtimeSec) => {
    const dir = path.join(captures, name);
    fs.mkdirSync(dir);
    if (withMarkers) fs.writeFileSync(path.join(dir, "ocqa-markers.txt"),
      'OCQA_STATE:{"screen":"Home","elements":10}\nOCQA_COMPLETE:{"actions":1,"states":1,"issues":0}\n');
    else fs.writeFileSync(path.join(dir, "flow-report.json"), "{}"); // non-exploration evidence
    fs.utimesSync(dir, mtimeSec, mtimeSec); // future mtimes → dominate any real repo captures
    return dir;
  };
  const future = Date.now() / 1000 + 86400;
  mk("web-20260101-000001", true, future);              // exploration capture (older of the two)
  mk("flow-web-9999999999999-abcdef01", false, future + 10); // newest, but NO exploration markers
  const env = { ...process.env, TAPP_HOME: home };

  const out = execFileSync("node", [tappBin, "report"], { cwd: root, encoding: "utf8", env });
  assert.match(out, /Evidence report/);
  assert.match(out, /web-20260101-000001/, "selected the exploration capture");
  assert.doesNotMatch(out, /flow-web-9999999999999/, "did not select the newer flow dir");

  // An explicitly named non-exploration capture still fails clearly (no silent success).
  const bad = spawnSync("node", [tappBin, "report", "flow-web-9999999999999-abcdef01"], { cwd: root, encoding: "utf8", env });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr + bad.stdout, /no markers/i);
});

test("tapp open and tree give a coding agent focused web evidence", { skip: skipRealBrowser }, async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-open-web-cli-"));
  const home = path.join(project, "tapp-home");
  const screenshot = path.join(project, "home.png");
  fs.writeFileSync(path.join(project, "index.html"), `
    <main><h1 id="heading">Loading coach profile…</h1><button id="continue">Continue</button><label>Email<input id="email" type="email"></label></main>
    <div id="location" role="dialog" aria-modal="true"><button id="dismiss">Not now</button></div>
    <p id="ready" hidden>Coach Ready</p>
    <script>
      setTimeout(() => { document.querySelector('#heading').textContent = 'Agent Home'; }, 900);
      document.querySelector('#dismiss').addEventListener('click', () => {
        document.querySelector('#location').remove();
        setTimeout(() => { document.querySelector('#ready').hidden = false; }, 300);
      });
    </script>
  `);
  fs.writeFileSync(path.join(project, "settings.html"), '<main><h1>Storefront Settings</h1><button id="save">Save storefront settings</button></main>');
  fs.writeFileSync(path.join(project, "StorefrontSettings.tsx"), 'export const StorefrontSettings = () => <button>Save storefront settings</button>;\n');
  const port = 49000 + (process.pid % 1000);
  const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: project, stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const url = `http://127.0.0.1:${port}`;
    const opened = execFileSync("node", [tappBin, "open", url, "--platform", "web", "--out", screenshot], { cwd: root, encoding: "utf8", env: { ...process.env, TAPP_HOME: home } });
    assert.match(opened, /Opened `http:\/\/127\.0\.0\.1:/);
    assert.match(opened, /Read screen \*\*Agent Home\*\*/);
    assert.match(opened, /`Continue`/);
    assert.match(opened, /Screenshot:/);
    assert.ok(fs.statSync(screenshot).size > 1000, "focused web screenshot is written");

    const tree = JSON.parse(execFileSync("node", [tappBin, "tree", url, "--platform", "web", "--json"], { cwd: root, encoding: "utf8", env: { ...process.env, TAPP_HOME: home } }));
    assert.equal(tree.platform, "web");
    assert.equal(tree.screenTitle, "Agent Home");
    assert.equal(tree.settled, true);
    assert.deepEqual(tree.elements.map((element) => element.label), ["Continue", "Email", "Not now"]);

    const interacted = execFileSync("node", [tappBin, "open", url, "--platform", "web", "--tap", "Not now", "--wait-for", "Coach Ready", "--out", screenshot], { cwd: root, encoding: "utf8", env: { ...process.env, TAPP_HOME: home } });
    assert.match(interacted, /Tapped `Not now`/);
    assert.match(interacted, /Found `Coach Ready`/);
    assert.doesNotMatch(interacted, /still showed a loading state/);

    const markersPath = path.join(project, "markers.txt");
    fs.writeFileSync(markersPath, [
      `OCQA_STATE:{"screen":"Agent Home","url":"${url}/","controls":[{"kind":"link","label":"Storefront"}]}`,
      'OCQA_ACTION:{"type":"tap","target":"Storefront","screen":"Agent Home"}',
      'OCQA_TRANSITION:{"from":"Agent Home","to":"Storefront Settings","action":"Storefront","changed":true}',
      `OCQA_STATE:{"screen":"Storefront Settings","url":"${url}/settings.html","controls":[{"kind":"button","label":"Save storefront settings","cssId":"save"}]}`,
    ].join("\n") + "\n");
    fs.mkdirSync(path.join(project, ".tapp"));
    fs.writeFileSync(path.join(project, ".tapp", "ui-map.json"), JSON.stringify(buildUiMapFromMarkers({ markersPath, platform:"web", target:url, runId:"cli-focus" })));
    const focusedShot = path.join(project, "focused.png");
    const focused = execFileSync("node", [tappBin, "focus", "Save storefront settings", url, "--platform", "web", "--project-dir", project, "--out", focusedShot], { cwd:root, encoding:"utf8", env:{ ...process.env, TAPP_HOME:home } });
    assert.match(focused, /Focused route ready/);
    assert.match(focused, /Reached in 1 route action/);
    assert.match(focused, /Read screen \*\*Storefront Settings\*\*/);
    assert.ok(fs.statSync(focusedShot).size > 1000);
  } finally {
    server.kill();
  }
});

test("tapp focus prepares and stops an owned web target when a repository is passed", { skip: skipRealBrowser }, async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-managed-web-focus-cli-"));
  const home = path.join(project, "tapp-home");
  const screenshot = path.join(project, "focused.jpg");
  fs.writeFileSync(path.join(project, "index.html"), '<main><h1>Home</h1><a href="/settings.html">Storefront</a></main>');
  fs.writeFileSync(path.join(project, "settings.html"), '<main><h1>Storefront Settings</h1><button id="save">Save storefront settings</button></main>');
  fs.writeFileSync(path.join(project, "StorefrontSettings.tsx"), 'export const StorefrontSettings = () => <button>Save storefront settings</button>;\n');
  fs.mkdirSync(path.join(project, ".tapp"));
  fs.writeFileSync(path.join(project, ".tapp", "application-model.json"), JSON.stringify({
    kind:"tapp-application-model",
    application:{ name:"Storefront", platforms:["web", "ios"], targetIds:["storefront", "native"], defaultTargetId:"storefront" },
    targets:[
      { id:"storefront", platform:"web", name:"Storefront", sourcePath:".", build:{ tool:"static-files", projectDir:".", install:null, start:null }, runtime:{} },
      { id:"native", platform:"ios", name:"Native", sourcePath:"Native.xcodeproj", build:{ tool:"xcodebuild", proposedScheme:"Native", configuration:"Debug" }, runtime:{} },
    ],
    requirements:[],
  }));
  const markersPath = path.join(project, "markers.txt");
  fs.writeFileSync(markersPath, [
    'OCQA_STATE:{"screen":"Home","url":"http://127.0.0.1:1/","controls":[{"kind":"link","label":"Storefront"}]}',
    'OCQA_ACTION:{"type":"tap","target":"Storefront","screen":"Home"}',
    'OCQA_TRANSITION:{"from":"Home","to":"Storefront Settings","action":"Storefront","changed":true}',
    'OCQA_STATE:{"screen":"Storefront Settings","url":"http://127.0.0.1:1/settings.html","controls":[{"kind":"button","label":"Save storefront settings","cssId":"save"}]}',
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(project, ".tapp", "ui-map.json"), JSON.stringify(buildUiMapFromMarkers({ markersPath, platform:"web", target:"http://127.0.0.1:1", runId:"managed-cli-focus" })));

  const focused = spawnSync("node", [tappBin, "focus", "Save storefront settings", ".", "--out", screenshot], {
    cwd:project, encoding:"utf8", timeout:30_000, env:{ ...process.env, TAPP_HOME:home },
  });
  assert.equal(focused.status, 0, focused.stderr || focused.stdout);
  const output = `${focused.stderr}\n${focused.stdout}`;
  assert.match(output, /Managed web runtime:/);
  assert.match(output, /Reached in 1 route action/);
  assert.match(output, /Read screen \*\*Storefront Settings\*\*/);
  assert.ok(fs.statSync(screenshot).size > 1000);

  const runtimeUrl = output.match(/→ (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  assert.ok(runtimeUrl, "managed runtime URL is reported");
  await assert.rejects(fetch(runtimeUrl, { signal:AbortSignal.timeout(1500) }), "managed runtime stops after focus");
});

test("tapp focus refuses to guess among modeled targets and prints exact selectors", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-focus-target-choices-"));
  fs.mkdirSync(path.join(project, ".tapp"));
  fs.writeFileSync(path.join(project, ".tapp", "application-model.json"), JSON.stringify({
    kind:"tapp-application-model",
    application:{ name:"Multi", platforms:["web", "ios"], targetIds:["web", "ios"] },
    targets:[
      { id:"web", platform:"web", name:"Storefront", sourcePath:"web" },
      { id:"ios", platform:"ios", name:"Native", sourcePath:"Native.xcodeproj" },
    ],
  }));
  const result = spawnSync("node", [tappBin, "focus", "Settings", "."], { cwd:project, encoding:"utf8", timeout:10_000 });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /Multiple targets match/);
  assert.match(result.stderr, /use --target "Storefront"/);
  assert.match(result.stderr, /use --target "Native"/);
});

test("web QA reports placeholder links and dead controls deterministically despite ambient DOM churn", { skip: skipRealBrowser }, async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-web-determinism-cli-"));
  const home = path.join(project, "tapp-home");
  const firstReport = path.join(project, "first.json");
  const secondReport = path.join(project, "second.json");
  fs.writeFileSync(path.join(project, "index.html"), `
    <main>
      <h1>Stable Home</h1>
      <a href="/next.html">Next page</a>
      <a href="#">Download App</a>
      <a href="#" data-action="open-help">JavaScript Help</a>
      <button id="working">Working action</button>
      <button id="dead">Availability</button>
    </main>
    <script>
      document.querySelector('#working').addEventListener('click', () => {});
      setInterval(() => document.body.setAttribute('data-background-tick', String(Date.now())), 50);
    </script>
  `);
  fs.writeFileSync(path.join(project, "next.html"), `
    <main><h1>Stable Next</h1><a href="/">Home</a></main>
  `);
  const port = 50000 + (process.pid % 1000);
  const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: project, stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const url = `http://127.0.0.1:${port}`;
    let firstOutput = "";
    for (const reportPath of [firstReport, secondReport]) {
      const output = execFileSync("node", [tappBin, "qa", url, "--platform", "web", "--actions", "4", "--timeout", "30", "--json", reportPath], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, TAPP_HOME: home },
      });
      if (!firstOutput) firstOutput = output;
    }
    const first = JSON.parse(fs.readFileSync(firstReport, "utf8"));
    const second = JSON.parse(fs.readFileSync(secondReport, "utf8"));
    const identity = (finding) => `${finding.type}|${finding.target}`;
    assert.deepEqual(first.findings.map(identity), second.findings.map(identity));
    assert.equal(first.verdict, undefined, "exploration renders no ship verdict to jitter");
    assert.equal(first.releaseScore, undefined, "exploratory web has no scalar score to jitter");
    assert.equal(first.inconclusive, second.inconclusive, "unchanged target produces an identical observation");
    assert.deepEqual(second.findingCounts, first.findingCounts);
    assert.deepEqual(second.deterministicFindingCounts, first.deterministicFindingCounts);
    assert.deepEqual(second.sampledFindingCounts, first.sampledFindingCounts);
    assert.ok(first.findings.some((finding) => finding.type === "placeholder_link" && finding.target === "Download App"));
    assert.ok(!first.findings.some((finding) => finding.target === "JavaScript Help"), "action-marked hash link is not called dead");
    assert.ok(first.findings.some((finding) => finding.type === "unresponsive_element" && finding.target === "Availability" && finding.evaluationTier === "sampled"));
    assert.ok(!first.findings.some((finding) => finding.target === "Working action"), "directly wired control is not called dead");
    assert.doesNotMatch(firstOutput, /get this verdict/i, "exploration must not market itself as a verdict");
    assert.match(firstOutput, /run these checks plus reviewed release contracts as a merge gate/i);
  } finally {
    server.kill();
  }
});

test("tapp actor configures only environment-variable bindings and lists them without values", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-actor-cli-"));
  const configured = execFileSync("node", [tappBin, "actor", "set", "alice", project, "--role", "member", "--session", "isolated", "--provisioning", "seeded", "--credential", "email=ALICE_EMAIL", "--credential", "password=ALICE_PASSWORD"], { cwd: root, encoding: "utf8" });
  assert.match(configured, /No credential values were accepted or written/);
  const persisted = fs.readFileSync(path.join(project, ".tapp", "project.json"), "utf8");
  assert.match(persisted, /ALICE_EMAIL/);
  assert.doesNotMatch(persisted, /alice@example|password-value/);
  const listed = execFileSync("node", [tappBin, "actor", "list", project], { cwd: root, encoding: "utf8" });
  assert.match(listed, /alice · role member · isolated session · seeded/);
  assert.match(listed, /email=\$ALICE_EMAIL/);
  fs.mkdirSync(path.join(project, ".tapp", "application-model.json"));
  const configuredDespiteRefreshFailure = spawnSync("node", [tappBin, "actor", "set", "charlie", project, "--email-env", "CHARLIE_EMAIL", "--password-env", "CHARLIE_PASSWORD"], { cwd:root, encoding:"utf8" });
  assert.equal(configuredDespiteRefreshFailure.status, 0, configuredDespiteRefreshFailure.stderr);
  assert.match(configuredDespiteRefreshFailure.stdout, /Actor 'charlie' configured/);
  assert.match(configuredDespiteRefreshFailure.stderr, /Actor was saved.*could not refresh/i);
  let rejected;
  try { execFileSync("node", [tappBin, "actor", "set", "bob", project, "--password", "password-value"], { cwd: root, encoding: "utf8", stdio: "pipe" }); }
  catch (error) { rejected = error; }
  assert.match(String(rejected?.stderr || ""), /Credential values are never accepted/);
});

test("tapp validates and compiles a reusable Task without an agent or target", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-task-cli-"));
  const taskDir = path.join(rootDir, ".tapp", "tasks");
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
  assert.match(out, /--serial <adb-serial>/);
});

test("tapp validates a committed Android Flow without an agent or device", () => {
  const out = execFileSync("node", [tappBin, "flow", "validate", "AndroidCorpus/demoapp/.tapp/flows/smoke.yml"], {
    encoding: "utf8", cwd: root,
  });
  assert.match(out, /Valid android Flow/);
  assert.match(out, /7 deterministic steps/);
});

test("tapp flow example prints a complete Flow that validates without MCP", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-flow-example-"));
  const flowPath = path.join(project, "example.yml");
  const example = execFileSync("node", [tappBin, "flow", "example"], { cwd:project, encoding:"utf8" });
  fs.writeFileSync(flowPath, example);
  assert.match(example, /login:/);
  assert.match(example, /\$TEST_PASSWORD/);
  const validated = execFileSync("node", [tappBin, "flow", "validate", flowPath], { cwd:project, encoding:"utf8" });
  assert.match(validated, /Valid web Flow/);
});

test("tapp validates a committed multi-actor Scenario without a browser or model", { skip: !hasSocialDemo }, () => {
  const out = execFileSync("node", [tappBin, "scenario", "validate", "SocialDemo/.tapp/scenarios/social-system.yml"], {
    cwd: root, encoding: "utf8",
  });
  assert.match(out, /Valid web Scenario/);
  assert.match(out, /2 actors, 39 journey steps/);
});

test("tapp validates and compiles a TypeScript release contract without an agent or target", { skip: !hasSocialDemo }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-contract-cli-"));
  const outPath = path.join(dir, "social.json");
  const contractPath = "SocialDemo/.tapp/contracts/social-system.contract.ts";
  const validated = execFileSync("node", [tappBin, "contract", "validate", contractPath], { cwd: root, encoding: "utf8" });
  assert.match(validated, /Valid Release Contract/);
  assert.match(validated, /critical, 2 actors/);
  const compiled = execFileSync("node", [tappBin, "contract", "compile", contractPath, "--platform", "web", "--out", outPath], { cwd: root, encoding: "utf8" });
  assert.match(compiled, /deterministic steps \(scenario\)/);
  const execution = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(execution.releaseContract.name, "socialSystemWorks");
  assert.equal(execution.steps.length, 39);
});

test("tapp produces a reviewable PR contract plan from explicit changed files", { skip: !hasSocialDemo }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-pr-cli-"));
  const outPath = path.join(dir, "plan.json");
  const output = execFileSync("node", [tappBin, "pr", "plan", "--project-dir", "SocialDemo", "--platform", "web", "--changed-files", "server.js,unowned.ts", "--json-out", outPath], { cwd: root, encoding: "utf8" });
  assert.match(output, /PR contract plan/);
  const plan = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(plan.selected.some((item) => item.name === "socialSystemWorks"), true);
  assert.deepEqual(plan.uncoveredChangedFiles, ["unowned.ts"]);

  const nativeProject = path.join(dir, "native-project");
  const nativeTapp = path.join(nativeProject, ".tapp");
  fs.mkdirSync(path.join(nativeTapp, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(nativeTapp, "tasks", "open-update-profile.json"), JSON.stringify({
    kind: "task", version: 1, name: "openUpdateProfile",
    implementations: { ios: { steps: [{ tap: "Settings" }, { wait_for: "Settings" }, { tap: "Update Profile" }, { wait_for: "Update Profile" }] } },
    coverage: { nodes: ["update-profile"], edges: ["edge_settings", "edge_profile"], sourcePaths: ["Sources/SettingsView.swift"] },
  }));
  fs.writeFileSync(path.join(nativeTapp, "ui-map.json"), JSON.stringify({
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

test("tapp init produces a grounded dry-run model and explicit plan review preserves customer choice", { skip: !hasWebDemo }, () => {
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
  fs.mkdirSync(path.join(project, ".tapp", "contracts"), { recursive: true });
  fs.writeFileSync(path.join(project, "index.html"), "<main>site</main>");
  fs.writeFileSync(path.join(project, ".tapp", "contracts", "home.contract.ts"), "fixture");
  const target = { id: "target_web_site", platform: "web", name: "site", sourcePath: ".", status: "configured", build: { tool: "static-files", dependencyStatus: "not-required" }, runtime: { management: "tapp-managed", ownedUrl: null } };
  const model = { kind: "tapp-application-model", targets: [target], actors: [], artifacts: { contracts: [{ name: "homeWorks", path: ".tapp/contracts/home.contract.ts", scope: ".", platforms: ["web"] }] } };
  fs.writeFileSync(path.join(project, ".tapp", "application-model.json"), JSON.stringify(model));
  const gateReport = path.join(project, "gate-report.json");
  fs.writeFileSync(gateReport, JSON.stringify({ platform: "web", targetKey: target.id, inconclusive: false, findings: [], screens: ["Home"], screensExplored: 1, actionsPerformed: 2, flows: [], scenarios: [], contracts: [{ name: "Home works", passed: true }], gate: { failed: false, outcome: "pass", reasons: [] } }));
  const baseline = execFileSync("node", [tappBin, "baseline", "create", project, "--platform", "web", "--from", gateReport], { cwd: root, encoding: "utf8" });
  assert.match(baseline, /Conclusive baseline established/);
  const installed = execFileSync("node", [tappBin, "ci", "install", project, "--action-ref", "aarwitz/tapp@v0.13.1"], { cwd: root, encoding: "utf8" });
  assert.match(installed, /Reviewable CI gate installed/);
  assert.match(installed, /did not commit, push, enable branch protection, or create GitHub resources/);
  const workflow = fs.readFileSync(path.join(project, ".github", "workflows", "tapp.yml"), "utf8");
  assert.match(workflow, /target-key: "target_web_site"/);
  assert.match(workflow, /baseline: "\.tapp\/baselines\/web\/target_web_site\.json"/);
  const ci = JSON.parse(fs.readFileSync(path.join(project, ".tapp", "ci.json"), "utf8"));
  assert.equal(ci.status, "ready-for-review");
  let collision;
  try { execFileSync("node", [tappBin, "ci", "install", project], { cwd: root, encoding: "utf8", stdio: "pipe" }); }
  catch (error) { collision = error; }
  assert.match(String(collision?.stderr || ""), /never overwrites existing files/);
});

test("tapp init --explore rejects dry-run before browser work", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-explore-preflight-"));
  fs.writeFileSync(path.join(project, "index.html"), "<main>fixture</main>");
  let dryRunFailure;
  try {
    execFileSync("node", [tappBin, "init", project, "--explore", "--dry-run", "--platform", "web", "--url", "http://127.0.0.1:9"], { cwd: root, encoding: "utf8", stdio: "pipe" });
  } catch (error) { dryRunFailure = error; }
  assert.match(String(dryRunFailure?.stderr || ""), /cannot be combined with --dry-run/);
});

test("tapp init --explore lists mixed targets before attempting a build", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-mixed-targets-"));
  fs.mkdirSync(path.join(project, "Product.xcodeproj"));
  fs.mkdirSync(path.join(project, "website"));
  fs.writeFileSync(path.join(project, "website", "package.json"), JSON.stringify({ name: "product-web" }));
  fs.writeFileSync(path.join(project, "website", "index.html"), "<main>Product web</main>");
  const home = path.join(project, "tapp-home");
  const result = spawnSync("node", [tappBin, "init", project, "--explore"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, TAPP_HOME: home },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Multiple application targets were detected; Tapp will not guess/);
  assert.match(result.stderr, /--platform ios --target "Product\.xcodeproj"/);
  assert.match(result.stderr, /--platform web --target "website"/);
  assert.doesNotMatch(result.stderr, /Building for the simulator/);
  assert.equal(fs.existsSync(path.join(project, ".tapp")), false);
});

test("tapp init --explore safely refreshes existing artifacts through shared semantics", { skip: skipRealBrowser }, () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-explore-refresh-"));
  fs.writeFileSync(path.join(project, "index.html"), "<main>fixture</main>");
  fs.mkdirSync(path.join(project, ".tapp"), { recursive: true });
  fs.writeFileSync(path.join(project, ".tapp", "application-model.json"), "{}\n");
  const refreshed = execFileSync("node", [tappBin, "init", project, "--explore", "--platform", "web", "--url", "http://127.0.0.1:9"], { cwd: root, encoding: "utf8", stdio: "pipe" });
  assert.match(refreshed, /Tapp init/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, ".tapp", "application-model.json"), "utf8")).kind, "tapp-application-model");
});

test("tapp init --explore starts and stops a detected owned web target when URL is omitted", { skip: skipRealBrowser }, async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-init-managed-web-"));
  fs.mkdirSync(path.join(project, "Product.xcodeproj"));
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
  const output = execFileSync("node", [tappBin, "init", project, "--explore", "--platform", "web", "--actions", "6", "--timeout", "60", "--json-out", outPath], { cwd: root, encoding: "utf8", env: { ...process.env, TAPP_HOME: home } });
  assert.match(output, /managed web runtime/i);
  assert.match(output, /0 blocking requirement\(s\) for web:managed-web/);
  assert.match(output, /ℹ️ Unselected ios:Product setup gap: Confirm a shared build scheme/);
  assert.doesNotMatch(output, /❌ Confirm a shared build scheme/);
  const result = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(result.exploration.managedRuntime, true);
  assert.equal(result.selectedTarget.platform, "web");
  assert.equal(result.requirementScope.active.some((item) => item.targetPlatform === "ios"), false);
  assert.equal(result.requirementScope.deferred.some((item) => item.targetPlatform === "ios"), true);
  assert.match(result.exploration.target, /^http:\/\/127\.0\.0\.1:\d+$/);
  const web = result.model.targets.find((target) => target.platform === "web");
  assert.equal(web.runtime.ownedUrl, null, "an ephemeral managed localhost URL must never become durable CI configuration");
  assert.equal(web.runtime.management, "tapp-managed");
  assert.equal(web.build.install, null);
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
    assert.equal(fs.existsSync(path.join(project, ".tapp", "ui-map.json")), true);
    const result = JSON.parse(fs.readFileSync(outPath, "utf8"));
    const persistedMap = JSON.parse(fs.readFileSync(path.join(project, ".tapp", "ui-map.json"), "utf8"));
    assert.equal(persistedMap.provenance.lastRun.id, result.exploration.capture.id);
    assert.equal(persistedMap.provenance.lastRun.platform, "web");
    assert.equal(typeof persistedMap.provenance.lastRun.inconclusive, "boolean");
    assert.ok(result.model.uiMap.nodeCount >= 2);
    assert.equal(result.exploration.platform, "web");
    assert.equal(result.exploration.uiMapPath, path.join(fs.realpathSync(project), ".tapp", "ui-map.json"));
    assert.equal(result.plan.items.some((item) => item.origin === "deterministic-ui-map-proposal"), true);
    const checkout = result.plan.items.find((item) => item.name === "checkoutReachable");
    assert.ok(checkout, "runtime map proposes the observed checkout surface");
    const planPath = path.join(project, ".tapp", "release-plan.json");
    execFileSync("node", [tappBin, "plan", "review", planPath, "--approve", checkout.id], { cwd: root, encoding: "utf8" });
    const generated = execFileSync("node", [tappBin, "plan", "generate", planPath, "--project-dir", project], { cwd: root, encoding: "utf8" });
    assert.match(generated, /1 grounded Task draft/);
    assert.equal(fs.existsSync(path.join(project, ".tapp", "proposals", "tasks", "open-checkout.task.json")), true);
    const validated = execFileSync("node", [tappBin, "plan", "validate", planPath, "--project-dir", project, "--platform", "web", "--url", `http://127.0.0.1:${port}`], { cwd: root, encoding: "utf8" });
    assert.match(validated, /1 passed · 0 failed on web/);
    const validatedPlan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    assert.equal(validatedPlan.items.find((item) => item.id === checkout.id).generation.trusted, true);
    assert.equal(validatedPlan.generation.generatedTasks.find((item) => item.name === "openCheckout").trusted, true);
    const validatedTask = JSON.parse(fs.readFileSync(path.join(project, ".tapp", "proposals", "tasks", "open-checkout.task.json"), "utf8"));
    assert.equal(validatedTask.generation.trusted, true);
    assert.equal(validatedTask.generation.realValidation.web.status, "passed");
    assert.match(validatedTask.generation.realValidation.web.evidence, /flow-web-/);
    const promoted = execFileSync("node", [tappBin, "plan", "promote", planPath, "--project-dir", project, "--item", checkout.id], { cwd: root, encoding: "utf8" });
    assert.match(promoted, /1 Task\(s\) · 1 release contract\(s\)/);
    assert.equal(fs.existsSync(path.join(project, ".tapp", "tasks", "open-checkout.task.json")), true);
    assert.equal(fs.existsSync(path.join(project, ".tapp", "contracts", "checkout-reachable.contract.ts")), true);
    assert.equal(fs.existsSync(path.join(project, ".tapp", "proposals", "tasks", "open-checkout.task.json")), false);
    const promotedPlan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    assert.equal(promotedPlan.items.find((item) => item.id === checkout.id).generation.status, "promoted");
  } finally {
    server.kill();
  }
});

test("tapp init discovers, validates, and fault-checks a grounded cross-actor contract from a contract-free repository", { skip: skipRealBrowser || !hasSocialDemo }, async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-cross-actor-discovery-cli-"));
  for (const file of ["package.json", "index.html", "app.js", "styles.css", "server.js"]) fs.copyFileSync(path.join(root, "SocialDemo", file), path.join(project, file));
  fs.mkdirSync(path.join(project, ".tapp"), { recursive: true });
  fs.cpSync(path.join(root, "SocialDemo", ".tapp", "tasks"), path.join(project, ".tapp", "tasks"), { recursive: true });
  fs.copyFileSync(path.join(root, "SocialDemo", ".tapp", "project.json"), path.join(project, ".tapp", "project.json"));
  const actorEnv = { ...process.env, ALICE_EMAIL: "alice@example.test", ALICE_PASSWORD: "demo", BOB_EMAIL: "bob@example.test", BOB_PASSWORD: "demo", OCQA_TEST_EMAIL: "alice@example.test", OCQA_TEST_PASSWORD: "demo", TAPP_HOME: path.join(project, "tapp-home") };
  const initPath = path.join(project, "init.json");
  const initialized = execFileSync("node", [tappBin, "init", project, "--explore", "--platform", "web", "--actions", "15", "--timeout", "120", "--email", "alice@example.test", "--password", "demo", "--json-out", initPath], { cwd: root, encoding: "utf8", env: actorEnv });
  assert.match(initialized, /UI Map: observed · 3 states · 2 transitions/);
  const planPath = path.join(project, ".tapp", "release-plan.json");
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
    const contractPath = path.join(project, ".tapp", "contracts", "post-propagates-across-actors.contract.ts");
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
    assert.equal(report.findingCounts.total, 0, "single-user exploration surfaced no findings; only the cross-account contract failed");
    assert.equal(report.contracts[0].passed, false);
    assert.equal(report.contracts[0].steps.find((step) => step.status === "fail").actor, "bob");
    assert.equal(report.gate.failed, true);
    assert.match(report.gate.reasons.join("; "), /release contract/);
  } finally {
    await stopServer(server);
  }
});

test("tapp init discovers, validates, and fault-checks a durable checkout contract from a contract-free repository", { skip: skipRealBrowser || !hasCommerceDemo }, () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-durable-checkout-discovery-cli-"));
  for (const file of ["package.json", "index.html", "app.js", "styles.css", "server.js"]) fs.copyFileSync(path.join(root, "CommerceDemo", file), path.join(project, file));
  fs.mkdirSync(path.join(project, ".tapp"), { recursive: true });
  fs.cpSync(path.join(root, "CommerceDemo", ".tapp", "tasks"), path.join(project, ".tapp", "tasks"), { recursive: true });
  fs.copyFileSync(path.join(root, "CommerceDemo", ".tapp", "project.json"), path.join(project, ".tapp", "project.json"));
  const runtimeEnv = { ...process.env, TAPP_HOME: path.join(project, "tapp-home") };
  const initPath = path.join(project, "init.json");
  const initialized = execFileSync("node", [tappBin, "init", project, "--explore", "--platform", "web", "--actions", "14", "--timeout", "120", "--json-out", initPath], { cwd: root, encoding: "utf8", env: runtimeEnv });
  assert.match(initialized, /UI Map: observed · 5 states · 4 transitions/);
  const planPath = path.join(project, ".tapp", "release-plan.json");
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
  const contractPath = path.join(project, ".tapp", "contracts", "checkout-creates-durable-order.contract.ts");
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
  assert.equal(report.findingCounts.total, 0, "generic crawling surfaced no findings; only the durable-state contract failed");
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
  assert.equal(maintenance.operations[0].taskPath, ".tapp/tasks/complete-checkout.yml");
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
  fs.mkdirSync(path.join(project, ".tapp", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(project, ".tapp", "tasks", "open-home.json"), JSON.stringify({ kind: "task", version: 1, name: "openHome", implementations: { web: [{ tap: "Home" }] }, postconditions: [{ screen: "Home" }] }));
  execFileSync("node", [tappBin, "init", project, "--url", "http://127.0.0.1:4173"], { cwd: root, encoding: "utf8" });
  const planPath = path.join(project, ".tapp", "release-plan.json");
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
    const validationRun = spawnSync("node", [tappBin, "plan", "validate", planPath, "--project-dir", project, "--platform", "web", "--url", `http://127.0.0.1:${port}`], { cwd: root, encoding: "utf8" });
    assert.equal(validationRun.status, 0, validationRun.stderr || validationRun.stdout);
    const validated = validationRun.stdout;
    assert.match(validated, /RELEASE CONTRACT PASSED/);
    assert.match(validated, /1 passed · 0 failed on web/);
    assert.doesNotMatch(validationRun.stderr, /RELEASE CONTRACT PASSED/, "interactive validation must not duplicate the execution transcript across stdout and stderr");
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
    assert.equal(init.result.serverInfo.name, "tapp");
    assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "handshake reports a real version");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = await waitFor(2);
    const names = tools.result.tools.map((t) => t.name);
    assert.ok(names.length >= 15, `expected a full toolset, got ${names.length}`);
    for (const required of ["tapp_explore", "tapp_build", "tapp_open_app", "tapp_session_act", "tapp_scenario_run", "tapp_init", "tapp_actor_config", "tapp_release_plan", "tapp_ci_setup", "tapp_ui_map", "tapp_task", "tapp_release_contract", "tapp_pr_plan"]) {
      assert.ok(names.includes(required), `${required} present`);
    }
    assert.ok(!names.includes("tapp_run_qa"), "the run_qa name is renamed to tapp_explore (alias still dispatches)");
    const qa = tools.result.tools.find((t) => t.name === "tapp_explore");
    assert.ok(qa.inputSchema.properties.androidAppId, "Android exploration target is public");
    assert.ok(qa.inputSchema.properties.watch, "web watch mode is public");
    const flow = tools.result.tools.find((t) => t.name === "tapp_flow_run");
    assert.ok(flow.inputSchema.properties.androidAppId, "Android Flow override is public");
    const initTool = tools.result.tools.find((t) => t.name === "tapp_init");
    assert.ok(initTool.inputSchema.properties.operation.enum.includes("explore"), "init exposes the shared real-surface exploration operation");
    for (const input of ["target", "appBundleId", "androidAppId", "apkPath", "maxActions", "timeout", "watch"]) {
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
    send({ jsonrpc: "2.0", id: 20, method: "prompts/list", params: {} });
    const prompts = await waitFor(20);
    assert.deepEqual(prompts.result.prompts.map((prompt) => prompt.name), ["test-app"]);
    assert.match(prompts.result.prompts[0].description, /real app surfaces/i);
    send({ jsonrpc: "2.0", id: 21, method: "prompts/get", params: { name: "test-app", arguments: { goal: "Verify checkout", target: "website" } } });
    const prompt = await waitFor(21);
    const promptText = prompt.result.messages[0].content.text;
    assert.match(promptText, /Verify checkout/);
    assert.match(promptText, /website/);
    assert.match(promptText, /multiple target choices/);
    assert.match(promptText, /never turn exploration into a score or ship verdict/);
    if (hasWebDemo && hasSocialDemo) {
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
      send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "tapp_init", arguments: { operation: "explore", projectDir: ".", maxActions: 1, timeout: 1 } } });
      const targetChoice = await waitFor(5);
      assert.equal(targetChoice.result.isError, true);
      assert.match(targetChoice.result.content[0].text, /Multiple application targets were detected/);
      assert.equal(targetChoice.result.structuredContent.reason, "target-selection-required");
      assert.ok(targetChoice.result.structuredContent.choices.length > 1);
      for (const choice of targetChoice.result.structuredContent.choices) {
        assert.ok(["ios", "android", "web"].includes(choice.platform));
        assert.equal(typeof choice.selector, "string");
        assert.match(choice.command, /npx -y @aarwitz\/tapp@latest init \. --explore --platform/);
      }
    }
  } finally {
    proc.kill();
  }
});

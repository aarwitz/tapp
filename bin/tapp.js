#!/usr/bin/env node
// tapp CLI — ship with proof.
//
//   Zero-config verbs (the same engine the MCP tools use, exported by mcp-server/src/index.js):
//   tapp qa <bundleId|url>   Autonomous QA → verdict + findings + evidence
//   tapp open <bundleId>     Launch app → screen summary + screenshot file
//   tapp tree <bundleId>     Accessibility tree of the current screen
//   tapp shot                Screenshot the booted simulator
//   tapp report [captureId]  Open the HTML evidence page
//   tapp ci ...              Merge-blocking release gate (passthrough to ci-gate.sh)
//
//   tapp mcp        Start the MCP server on stdio (inline screenshots + interactive sessions)
//   tapp install    Prebuild the exploration harness for the booted simulator
//   tapp doctor     Check the toolchain (Xcode, simctl, node, harness cache)
//
// All writable output (captures, harness build cache) goes to ~/.tapp (override
// with TAPP_HOME). The package directory itself is never written to.
// (Internally exported as AUTOTAP_HOME — the env name the bundled scripts read.)

import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));

// Redirect all writable output away from the (possibly read-only) package dir.
if (!process.env.AUTOTAP_HOME) {
  process.env.AUTOTAP_HOME = process.env.TAPP_HOME || path.join(os.homedir(), ".tapp");
}
fs.mkdirSync(process.env.AUTOTAP_HOME, { recursive: true });

const [, , command = "help", ...rest] = process.argv;

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return {
    code: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function ok(label, detail = "") {
  console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
}
function bad(label, detail = "") {
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
}

function bootedSims() {
  const r = run("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
  if (r.code !== 0) return [];
  try {
    const d = JSON.parse(r.stdout);
    return Object.values(d.devices || {})
      .flat()
      .filter((x) => x.state === "Booted");
  } catch {
    return [];
  }
}

function bootBestSimulator(preferredName = "iPhone 16 Pro") {
  const r = run("xcrun", ["simctl", "list", "devices", "available", "-j"]);
  if (r.code !== 0) return null;
  let candidates = [];
  try {
    const d = JSON.parse(r.stdout);
    // Newest runtime first, iPhones only, preferred name wins.
    candidates = Object.entries(d.devices || {})
      .sort(([a], [b]) => b.localeCompare(a))
      .flatMap(([, devices]) => devices)
      .filter((x) => (x.isAvailable ?? true) && x.name.startsWith("iPhone"));
  } catch {
    return null;
  }
  const pick = candidates.find((x) => x.name === preferredName) || candidates[0];
  if (!pick) return null;
  console.log(`Booting ${pick.name} (${pick.udid})…`);
  run("xcrun", ["simctl", "boot", pick.udid]);
  const status = run("xcrun", ["simctl", "bootstatus", pick.udid, "-b"]);
  return status.code === 0 ? pick : null;
}

function harnessXctestrun() {
  const dir = path.join(process.env.AUTOTAP_HOME, "harness-derived", "Build", "Products");
  try {
    const found = fs.readdirSync(dir).find((f) => f.endsWith(".xctestrun"));
    return found ? path.join(dir, found) : null;
  } catch {
    return null;
  }
}

// Flags/positionals for the zero-config verbs (qa/open/tree/shot). `--key value` or bare `--key`.
function parseVerbArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

const engineImport = () => import(path.join(packageRoot, "mcp-server", "src", "index.js"));

function requireMacFor(what) {
  if (process.platform === "darwin") return;
  console.error(`❌ ${what} requires macOS (Xcode + iOS simulator). The web beta runs anywhere: tapp qa https://localhost:3000`);
  process.exit(1);
}

function saveShot(img, outFlag, name) {
  const out = outFlag || path.join(process.env.AUTOTAP_HOME, "shots", name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(img.data, "base64"));
  return out;
}

function printEngineError(r) {
  console.error(`❌ ${r.error}`);
  if (r.details && Array.isArray(r.details.errors) && r.details.errors.length) {
    console.error(r.details.errors.map((e) => "  " + e.trim()).join("\n"));
  }
}

// Turn whatever the user gave us (nothing / repo dir / .app / bundle id) into an installed
// bundle id, narrating build/install progress on stderr.
async function resolveTargetOrExit(engine, input) {
  const resolved = await engine.resolveAppTarget(input || "", { onStatus: (s) => console.error(`⏳ ${s}`) });
  if (resolved.error) {
    printEngineError(resolved);
    process.exit(1);
  }
  if (resolved.via) console.error(`🎯 Target: ${resolved.bundleId} — ${resolved.via}`);
  return resolved.bundleId;
}

switch (command) {
  case "mcp": {
    // Agents spawn `tapp mcp`; the engine module is import-safe, so start explicitly.
    const { startMcpServer } = await engineImport();
    await startMcpServer();
    break;
  }

  // ---- Zero-config verbs: the same engine the MCP tools use (exported by index.js),
  // invokable by any agent or human with no server setup at all.

  case "qa": {
    const { flags, positionals } = parseVerbArgs(rest);
    const target = positionals[0] || "";
    let baselineFindings;
    if (flags.baseline) {
      try {
        const parsed = JSON.parse(fs.readFileSync(flags.baseline, "utf8"));
        baselineFindings = Array.isArray(parsed) ? parsed : parsed.findings;
      } catch (e) {
        console.error(`❌ Could not read baseline ${flags.baseline}: ${e.message}`);
        process.exit(2);
      }
    }
    const engine = await engineImport();
    const isWeb = /^https?:\/\//i.test(target);
    if (!isWeb) requireMacFor("iOS testing");
    const bundleId = isWeb ? null : await resolveTargetOrExit(engine, target);
    const unit = isWeb ? "pages" : "screens";
    const onProgress = (p) =>
      process.stderr.write(`\r🔍 Exploring… ${p.action}/${p.max || flags.actions || 60} actions · ${p.states} ${unit} reached   `);
    const r = isWeb
      ? await engine.runQaWeb({
          url: target,
          maxActions: flags.actions,
          timeout: flags.timeout,
          testEmail: flags.email,
          testPassword: flags.password,
          baselineFindings,
          onProgress,
        })
      : await engine.runQaIos({
          bundleId,
          maxActions: flags.actions,
          timeout: flags.timeout,
          args: { testEmail: flags.email, testPassword: flags.password, baselineFindings },
          onProgress,
        });
    process.stderr.write("\n");
    if (r.error) {
      printEngineError(r);
      process.exit(1);
    }
    console.log(r.text);
    if (flags.json && typeof flags.json === "string") {
      fs.writeFileSync(flags.json, JSON.stringify(r.structured, null, 2));
      console.log(`\n📄 Full report JSON: ${flags.json} (pass as --baseline next run to diff regressions)`);
    }
    break;
  }

  case "open": {
    requireMacFor("tapp open");
    const { flags, positionals } = parseVerbArgs(rest);
    const engine = await engineImport();
    const sim = await engine.ensureBootedSim({ autoBoot: true });
    if (sim.error) {
      console.error(`❌ ${sim.error}`);
      process.exit(1);
    }
    if (sim.autoBooted) console.error(`📱 Booted ${sim.booted.name}`);
    const bundleId = await resolveTargetOrExit(engine, positionals[0]);
    const r = await engine.openApp(bundleId, {}, 1000);
    if (r.error) {
      console.error(`❌ ${r.error}`);
      process.exit(1);
    }
    console.log(`🚀 Launched \`${bundleId}\`\n`);
    console.log(engine.formatScreen(r.screenTitle, r.elements));
    if (r.img && !r.img.error) {
      const out = saveShot(r.img, typeof flags.out === "string" ? flags.out : null, `${bundleId}-${Date.now()}.jpg`);
      console.log(`\n📸 Screenshot: ${out}`);
    }
    break;
  }

  case "tree": {
    requireMacFor("tapp tree");
    const { flags, positionals } = parseVerbArgs(rest);
    const engine = await engineImport();
    const sim = await engine.ensureBootedSim({ autoBoot: true });
    if (sim.error) {
      console.error(`❌ ${sim.error}`);
      process.exit(1);
    }
    const bundleId = await resolveTargetOrExit(engine, positionals[0]);
    const r = await engine.captureUiTree(bundleId);
    if (r.error) {
      console.error(`❌ ${r.error}`);
      process.exit(1);
    }
    if (flags.json) {
      console.log(JSON.stringify({ screenTitle: r.screenTitle, elements: r.elements }, null, 2));
    } else {
      console.log(engine.formatScreen(r.screenTitle, r.elements));
      console.log("\n(full element list: tapp tree " + bundleId + " --json)");
    }
    break;
  }

  case "shot":
  case "screenshot": {
    requireMacFor("tapp shot");
    const { flags } = parseVerbArgs(rest);
    const engine = await engineImport();
    const img = await engine.captureScreenshotImage(flags.width ? Number(flags.width) : 1000);
    if (img.error) {
      console.error(`❌ ${img.error}`);
      process.exit(1);
    }
    const out = saveShot(img, typeof flags.out === "string" ? flags.out : null, `shot-${Date.now()}.jpg`);
    console.log(`📸 ${out} (${Math.round(img.bytes / 1024)}KB)`);
    break;
  }

  case "apps": {
    requireMacFor("tapp apps");
    const engine = await engineImport();
    const sim = await engine.ensureBootedSim({ autoBoot: true });
    if (sim.error) {
      console.error(`❌ ${sim.error}`);
      process.exit(1);
    }
    const la = await engine.listInstalledUserApps();
    if (la.error) {
      printEngineError(la);
      process.exit(1);
    }
    if (!la.apps.length) {
      console.log("No user apps installed on the booted simulator. Install one: tapp build (from your app repo), or xcrun simctl install booted path/to/App.app");
      break;
    }
    console.log("📱 Installed on the booted simulator:\n");
    for (const a of la.apps) console.log(`  ${a.bundleId}  (${a.name})`);
    console.log(`\nTest one: tapp qa <bundleId>`);
    break;
  }

  case "build": {
    requireMacFor("tapp build");
    const { flags, positionals } = parseVerbArgs(rest);
    const engine = await engineImport();
    const dir = positionals[0] ? path.resolve(positionals[0]) : process.cwd();
    console.error("⏳ Building for the simulator (a first build can take a few minutes)…");
    const built = await engine.buildAppForSim({
      dir,
      scheme: typeof flags.scheme === "string" ? flags.scheme : undefined,
      configuration: typeof flags.configuration === "string" ? flags.configuration : "Debug",
    });
    if (built.error) {
      printEngineError(built);
      process.exit(1);
    }
    const sim = await engine.ensureBootedSim({ autoBoot: true });
    if (sim.error) {
      console.error(`❌ ${sim.error}`);
      process.exit(1);
    }
    const inst = await engine.installAppOnBootedSim(built.appPath);
    if (inst.error) {
      printEngineError(inst);
      process.exit(1);
    }
    console.log(`🔨 Built ${path.basename(built.appPath)} (scheme ${built.scheme}) — installed as ${inst.bundleId}`);
    console.log(`\nNext: tapp qa ${inst.bundleId}`);
    break;
  }

  case "doctor": {
    console.log(`tapp v${pkg.version} — doctor\n`);
    let healthy = true;

    if (process.platform !== "darwin") {
      bad("macOS", `tapp drives the iOS simulator and only runs on macOS (found: ${process.platform})`);
      process.exit(1);
    }
    ok("macOS", `${os.release()} (${os.arch()})`);

    const xcode = run("xcode-select", ["-p"]);
    if (xcode.code === 0 && xcode.stdout) {
      const ver = run("xcodebuild", ["-version"]).stdout.split("\n")[0];
      ok("Xcode", `${ver || xcode.stdout}`);
    } else {
      bad("Xcode", "install Xcode from the App Store, then: xcode-select --install");
      healthy = false;
    }

    const simctl = run("xcrun", ["simctl", "help"]);
    if (simctl.code === 0) {
      const booted = bootedSims();
      ok("simctl", booted.length ? `${booted.length} simulator booted (${booted[0].name})` : "available (no simulator booted yet)");
    } else {
      bad("simctl", "xcrun simctl not working — check your Xcode command-line tools");
      healthy = false;
    }

    const major = Number(process.versions.node.split(".")[0]);
    major >= 18 ? ok("Node", `v${process.versions.node}`) : (bad("Node", `v${process.versions.node} (need >= 18)`), (healthy = false));

    const python = run("python3", ["--version"]);
    python.code === 0 ? ok("python3", `${python.stdout} (used by Flows)`) : bad("python3", "not found — Flow replay needs python3 + pyyaml (everything else works)");

    const xctestrun = harnessXctestrun();
    xctestrun
      ? ok("Harness cache", xctestrun)
      : console.log(`  ⬜ Harness cache — not built yet (builds automatically on first use, or run: tapp install)`);

    console.log(`\n  Home: ${process.env.AUTOTAP_HOME}`);
    console.log(healthy ? "\nReady. Add to your agent:  claude mcp add tapp -- npx -y tapp-mcp mcp" : "\nFix the ❌ items above, then re-run: tapp doctor");
    process.exit(healthy ? 0 : 1);
  }

  case "install": {
    console.log("Preparing the iOS exploration harness…");
    let booted = bootedSims();
    if (!booted.length) {
      const sim = bootBestSimulator();
      if (!sim) {
        console.error("❌ No iOS simulator available. Install one via Xcode → Settings → Platforms.");
        process.exit(1);
      }
      booted = [sim];
    }
    const r = spawnSync("bash", [path.join(packageRoot, "scripts", "quick-capture.sh"), "build-harness"], {
      stdio: "inherit",
    });
    process.exit(r.status ?? 1);
  }

  case "ci": {
    const r = spawnSync("bash", [path.join(packageRoot, "scripts", "ci-gate.sh"), ...rest], {
      stdio: "inherit",
    });
    process.exit(r.status ?? 1);
  }

  case "report": {
    // Regenerate + open the HTML evidence page for a capture (default: the latest).
    const capturesDir = path.join(process.env.AUTOTAP_HOME, "captures");
    const repoCaptures = path.join(packageRoot, "captures");
    const roots = [capturesDir, repoCaptures].filter((d) => fs.existsSync(d));
    const runs = roots
      .flatMap((root) => fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name)))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const wanted = rest[0] && rest[0] !== "latest" ? runs.find((r) => path.basename(r) === rest[0]) : runs[0];
    if (!wanted) {
      bad("No captures found", rest[0] ? `no capture named "${rest[0]}"` : "run a QA exploration first");
      process.exit(1);
    }
    const { writeHtmlReport } = await import(path.join(packageRoot, "mcp-server", "src", "html-report.js"));
    const out = writeHtmlReport(wanted, { label: path.basename(wanted) });
    if (!out) {
      bad("Capture has no markers", wanted);
      process.exit(1);
    }
    ok("Evidence report", out);
    spawnSync("open", [out], { stdio: "ignore" });
    break;
  }

  case "version":
  case "--version":
  case "-v": {
    console.log(pkg.version);
    break;
  }

  default: {
    console.log(`tapp v${pkg.version} — ship with proof. Autonomous QA with a deterministic ship/no-ship verdict (iOS + web beta).

Zero-config verbs (agents and humans can just run these — no server, no setup):
  tapp qa [target]         Autonomous QA → verdict + findings + evidence
                           (--actions N · --email E --password P · --baseline report.json · --json out.json)
  tapp open [target]       Launch the app → screen summary + screenshot saved to a file
  tapp tree [target]       Accessibility tree of the current screen (--json for every element)
  tapp shot                Screenshot the booted simulator → file path (--out file.jpg)
  tapp build [dir]         Build the iOS app in a repo for the simulator + install it (--scheme S)
  tapp apps                List apps installed on the booted simulator (with bundle ids)
  tapp report [captureId]  Open the HTML evidence page for a capture (default: latest)
  tapp ci ...              Merge-blocking release gate — explore + flows + baseline diff (see: tapp ci --help)

  [target] is whatever you have — nothing (finds + builds the Xcode project in the current
  dir, or falls back to the app on the simulator), a repo dir, a path/to/App.app, a bundle
  id, or an http(s) URL (web beta, qa only). You never need to know a bundle id up front.

Setup:
  tapp install    Prebuild the exploration harness (~2 min; otherwise builds on first use)
  tapp doctor     Check Xcode / simulators / toolchain
  tapp mcp        Start the MCP server on stdio (adds inline screenshots + interactive sessions)

MCP hookup (optional — for inline screenshots and the tap/type/inspect session loop):
  Claude Code:   claude mcp add tapp -- npx -y tapp-mcp mcp
  Cursor/VS Code (mcp.json):
    { "servers": { "tapp": { "type": "stdio", "command": "npx", "args": ["-y", "tapp-mcp", "mcp"] } } }

Then ask your agent things like:
  "Run tapp qa on com.mycompany.app — is it ship-ready?"
  "Open the settings screen and show me the screenshot"
  "Drive the login flow and record it as a replayable test"

Docs: ${pkg.homepage}`);
    break;
  }
}

#!/usr/bin/env node
// tapp CLI — Playwright for iOS.
//
//   tapp mcp        Start the MCP server on stdio (what agents run)
//   tapp install    Prebuild the exploration harness for the booted simulator
//   tapp doctor     Check the toolchain (Xcode, simctl, node, harness cache)
//   tapp ci ...     Run the CI release gate (passthrough to ci-gate.sh)
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

switch (command) {
  case "mcp": {
    // The MCP server self-starts on import (stdio transport) — agents spawn `tapp mcp`.
    await import(path.join(packageRoot, "mcp-server", "src", "index.js"));
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

Usage:
  tapp mcp        Start the MCP server on stdio (this is what agents run)
  tapp install    Prebuild the exploration harness (~2 min; otherwise builds on first use)
  tapp doctor     Check Xcode / simulators / toolchain
  tapp report     Open the HTML evidence page for the latest capture (tapp report [captureId])
  tapp ci ...     Run the CI release gate (see: tapp ci --help)

Hook it up to your agent:
  Claude Code:   claude mcp add tapp -- npx -y tapp-mcp mcp
  Cursor/VS Code (mcp.json):
    { "servers": { "tapp": { "type": "stdio", "command": "npx", "args": ["-y", "tapp-mcp", "mcp"] } } }

Then ask your agent things like:
  "Open com.mycompany.app on the simulator and screenshot the home screen"
  "Run autonomous QA on my app and tell me if it's ship-ready"
  "Drive the login flow and record it as a replayable test"

Docs: ${pkg.homepage}`);
    break;
  }
}

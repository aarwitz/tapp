"use strict";
// Thin MCP client over a spawned `@aarwitz/tapp mcp` child process. The npm package is the
// engine; this file only bridges. Deliberately vscode-free so it can be smoke-tested
// with plain node (see smoke.js).
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFile } = require("node:child_process");

function exec(cmd, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

// The engine version this extension release is built against. PINNED on purpose: npx
// caches tag-resolved installs (`@latest` can serve a stale engine forever), and the
// tool contract (tapp_build shape, target resolution) must match what the bridge expects.
// Bump together with the extension version. TAPP_ENGINE_SPEC overrides for development.
const ENGINE_SPEC = process.env.TAPP_ENGINE_SPEC || "@aarwitz/tapp@0.17.0-rc.16";

class TappBridge {
  constructor({ cwd, command, args } = {}) {
    this.cwd = cwd || process.cwd();
    this.command = command || "npx";
    this.args = args || ["-y", ENGINE_SPEC, "mcp"];
    this.client = null;
    this.sessionActive = false;
    this.bundleId = null;
  }

  async ensure() {
    if (this.client) return this.client;
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      env: { ...process.env },
      stderr: "ignore",
    });
    const client = new Client({ name: "tapp-vscode", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async call(name, args = {}, timeoutMs = 10 * 60 * 1000) {
    const client = await this.ensure();
    return client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  }

  textOf(res) {
    return (res.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  }

  imageOf(res) {
    const img = (res.content || []).find((c) => c.type === "image");
    return img ? { data: Buffer.from(img.data, "base64"), mimeType: img.mimeType } : null;
  }

  isError(res) {
    return !!res.isError;
  }

  looksLikeBundleId(t) {
    return !!t && !t.includes("/") && t.includes(".");
  }

  async installDotApp(appPath) {
    const bid = await exec("/usr/libexec/PlistBuddy", ["-c", "Print CFBundleIdentifier", path.join(appPath, "Info.plist")]);
    const bundleId = bid.stdout.trim();
    if (!bundleId) return { error: `Could not read CFBundleIdentifier from ${appPath}` };
    await exec("xcrun", ["simctl", "terminate", "booted", bundleId]);
    await exec("xcrun", ["simctl", "uninstall", "booted", bundleId]);
    const inst = await exec("xcrun", ["simctl", "install", "booted", appPath], 3 * 60 * 1000);
    if (inst.code !== 0) return { error: `Install failed: ${inst.stderr.trim().slice(0, 300)}` };
    return { bundleId };
  }

  // target: undefined | bundle id | .app path | project dir → an installed bundle id
  async resolveBundleId(target, workspaceDir) {
    const t = (target || "").trim();
    // A common bundle id is literally `com.example.app`, so the `.app` suffix alone
    // cannot distinguish it from a simulator bundle path. Only prefer the path form
    // when that path actually exists.
    if (t.endsWith(".app")) {
      const appPath = path.resolve(workspaceDir, t);
      if (fs.existsSync(appPath)) return this.installDotApp(appPath);
    }
    if (this.looksLikeBundleId(t)) return { bundleId: t };
    const dir = t ? path.resolve(workspaceDir, t) : workspaceDir;
    const b = await this.call("tapp_build", { projectDir: dir }, 25 * 60 * 1000);
    if (this.isError(b)) return { error: this.textOf(b) };
    const text = this.textOf(b);
    // Belt and suspenders: structuredContent first, then the text ("installed … as `id`"),
    // then Info.plist of the reported .app.
    let bundleId = (b.structuredContent && b.structuredContent.bundleId) || null;
    if (!bundleId) bundleId = (text.match(/as `([^`]+)`/) || [])[1] || null;
    if (!bundleId && b.structuredContent && b.structuredContent.appPath) {
      const bid = await exec("/usr/libexec/PlistBuddy", ["-c", "Print CFBundleIdentifier", path.join(b.structuredContent.appPath, "Info.plist")]);
      bundleId = bid.stdout.trim() || null;
    }
    if (!bundleId) return { error: `Build finished but no bundle id was returned — engine/extension version mismatch? Build output:\n${text.slice(0, 400)}` };
    return { bundleId, buildText: text };
  }

  async openTarget(target, workspaceDir) {
    const r = await this.resolveBundleId(target, workspaceDir);
    if (r.error) return { error: r.error };
    if (this.sessionActive) {
      try { await this.call("tapp_session_end", {}, 60_000); } catch { /* stale session */ }
      this.sessionActive = false;
    }
    const s = await this.call("tapp_session_start", { appBundleId: r.bundleId }, 5 * 60 * 1000);
    if (this.isError(s)) return { error: this.textOf(s) };
    this.sessionActive = true;
    this.bundleId = r.bundleId;
    return { text: this.textOf(s), bundleId: r.bundleId };
  }

  async act(cmd) {
    if (!this.sessionActive) return { error: "No app is open — call tapp_open_ios_app first." };
    const res = await this.call("tapp_session_act", cmd, 2 * 60 * 1000);
    if (this.isError(res)) return { error: this.textOf(res) };
    return { text: this.textOf(res) };
  }

  async readScreen() {
    return this.act({ action: "tree" });
  }

  async login(email, password) {
    return this.act({ action: "login", email, password });
  }

  async screenshot() {
    const res = await this.call("tapp_screenshot", {}, 60_000);
    if (this.isError(res)) return { error: this.textOf(res) };
    return { text: this.textOf(res), image: this.imageOf(res) };
  }

  // opts: { testEmail, testPassword, inputOverrides, onAwaitInput(request, bundleId) →
  // Promise<{action, values?}> }. With onAwaitInput set, the engine runs the exploration in
  // interactive mode: the harness pauses at input screens, the engine mirrors each request to
  // <responsePath>.request, we prompt the human, and write the response the harness polls.
  async explore(target, maxActions, workspaceDir, opts = {}) {
    const r = await this.resolveBundleId(target, workspaceDir);
    if (r.error) return { error: r.error };
    if (this.sessionActive) {
      try { await this.call("tapp_session_end", {}, 60_000); } catch { /* stale session */ }
      this.sessionActive = false;
    }
    const args = { appBundleId: r.bundleId };
    if (maxActions) args.maxActions = maxActions;
    if (opts.testEmail) args.testEmail = opts.testEmail;
    if (opts.testPassword) args.testPassword = opts.testPassword;
    if (opts.inputOverrides && Object.keys(opts.inputOverrides).length) args.inputOverrides = opts.inputOverrides;

    let poller = null;
    let responsePath = null;
    if (typeof opts.onAwaitInput === "function") {
      responsePath = path.join(os.tmpdir(), `tapp-input-${Date.now().toString(36)}.json`);
      args.interactive = true;
      args.interactiveResponsePath = responsePath;
      const requestPath = responsePath + ".request";
      let lastRequestId = null;
      let busy = false;
      poller = setInterval(async () => {
        if (busy) return;
        let req;
        try { req = JSON.parse(fs.readFileSync(requestPath, "utf8")); } catch { return; }
        if (!req || !req.requestId || req.requestId === lastRequestId) return;
        lastRequestId = req.requestId;
        busy = true;
        try {
          const resp = (await opts.onAwaitInput(req, r.bundleId)) || { action: "defaults" };
          fs.writeFileSync(
            responsePath,
            JSON.stringify({ requestId: req.requestId, action: resp.action || "defaults", values: resp.values || {} }),
            { mode: 0o600 }
          );
        } catch {
          try { fs.writeFileSync(responsePath, JSON.stringify({ requestId: req.requestId, action: "defaults" }), { mode: 0o600 }); } catch { /* harness falls back on its own timeout */ }
        } finally {
          busy = false;
        }
      }, 700);
    }
    try {
      const res = await this.call("tapp_explore", args, 45 * 60 * 1000);
      if (this.isError(res)) return { error: this.textOf(res) };
      return { text: this.textOf(res) };
    } finally {
      if (poller) clearInterval(poller);
      if (responsePath) {
        for (const p of [responsePath, responsePath + ".request"]) {
          try { fs.rmSync(p, { force: true }); } catch { /* tmp cleanup */ }
        }
      }
    }
  }

  async build(projectDir, scheme) {
    const args = { projectDir };
    if (scheme) args.scheme = scheme;
    const res = await this.call("tapp_build", args, 25 * 60 * 1000);
    if (this.isError(res)) return { error: this.textOf(res) };
    return { text: this.textOf(res), bundleId: (res.structuredContent || {}).bundleId };
  }

  async dispose() {
    if (this.sessionActive) {
      try { await this.call("tapp_session_end", {}, 30_000); } catch { /* shutting down */ }
    }
    if (this.client) {
      try { await this.client.close(); } catch { /* shutting down */ }
      this.client = null;
    }
  }
}

module.exports = { TappBridge, exec };

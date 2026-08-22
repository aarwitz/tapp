"use strict";
// Tapp for VS Code — contributes the cross-platform Tapp Agent Skill plus focused
// iOS Language Model Tools and an embedded simulator-mirror panel. All engine work
// happens in the spawned Tapp child.
const vscode = require("vscode");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { TappBridge, exec } = require("./bridge");

let bridge = null;
let out = null;

function log(msg) {
  if (out) out.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function wsDir() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri.fsPath : null;
}

const NO_WORKSPACE =
  "No folder is open in VS Code — open your app's repo as the workspace folder, or pass an explicit `target` (project dir, .app path, or bundle id).";

function getBridge() {
  if (!bridge) bridge = new TappBridge({ cwd: wsDir() || undefined });
  return bridge;
}

function textResult(text) {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

function resultWithImage(text, image) {
  const parts = [new vscode.LanguageModelTextPart(text)];
  try {
    if (image && vscode.LanguageModelDataPart && typeof vscode.LanguageModelDataPart.image === "function") {
      parts.push(vscode.LanguageModelDataPart.image(new Uint8Array(image.data), image.mimeType));
    }
  } catch {
    /* older VS Code: text-only result; the simulator panel still shows the screen */
  }
  return new vscode.LanguageModelToolResult(parts);
}

// ---- Simulator mirror panel (the "browser opened on the left" equivalent) ----

class SimulatorPanel {
  static current = null;

  static show() {
    if (SimulatorPanel.current) {
      SimulatorPanel.current.panel.reveal(undefined, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "tappSimulator",
      "iOS Simulator (Tapp)",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    SimulatorPanel.current = new SimulatorPanel(panel);
  }

  constructor(panel) {
    this.panel = panel;
    this.panel.webview.html = `<!DOCTYPE html><html><body style="margin:0;background:#111;color:#ddd;display:flex;align-items:center;justify-content:center;min-height:100vh;font:13px system-ui">
<div id="status">Waiting for the app…</div><img id="s" style="display:none;max-width:100%;max-height:100vh;object-fit:contain" alt="Settled app preview"/>
<script>window.addEventListener("message",(e)=>{const d=e.data||{},s=document.getElementById("s"),status=document.getElementById("status");if(d.type==="frame"){s.src=d.src;s.style.display="block";status.style.display="none";}if(d.type==="pause"){s.style.display="none";status.textContent=d.message||"Preparing the app…";status.style.display="block";}});</script>
</body></html>`;
    this.timer = setInterval(() => this.refresh(), 1500);
    this.busy = false;
    this.panel.onDidDispose(() => {
      clearInterval(this.timer);
      SimulatorPanel.current = null;
    });
    this.refresh();
  }

  static pause(message = "Building, installing, and opening the app…") {
    if (!SimulatorPanel.current) return;
    SimulatorPanel.current.paused = true;
    SimulatorPanel.current.panel.webview.postMessage({ type: "pause", message });
  }

  static resume() {
    if (!SimulatorPanel.current) SimulatorPanel.show();
    if (!SimulatorPanel.current) return;
    SimulatorPanel.current.paused = false;
    SimulatorPanel.current.refresh();
  }

  async refresh() {
    if (this.paused || this.busy || !this.panel.visible) return;
    this.busy = true;
    try {
      const stamp = Date.now().toString(36);
      const png = path.join(os.tmpdir(), `tapp-panel-${stamp}.png`);
      const jpg = path.join(os.tmpdir(), `tapp-panel-${stamp}.jpg`);
      const shot = await exec("xcrun", ["simctl", "io", "booted", "screenshot", png], 15_000);
      if (!this.paused && shot.code === 0 && fs.existsSync(png)) {
        await exec("sips", ["-Z", "520", "-s", "format", "jpeg", "-s", "formatOptions", "70", png, "--out", jpg], 15_000);
        const file = fs.existsSync(jpg) ? jpg : png;
        const mime = file === jpg ? "image/jpeg" : "image/png";
        const b64 = fs.readFileSync(file).toString("base64");
        this.panel.webview.postMessage({ type: "frame", src: `data:${mime};base64,${b64}` });
      }
      for (const p of [png, jpg]) {
        try { fs.rmSync(p, { force: true }); } catch { /* tmp cleanup */ }
      }
    } finally {
      this.busy = false;
    }
  }
}

// ---- Tool registrations ----

function registerTool(ctx, name, handler, prepare) {
  ctx.subscriptions.push(
    vscode.lm.registerTool(name, {
      // Playwright-style action chips: "📱 Opening the app on the simulator" while running,
      // proper past tense once done.
      prepareInvocation: async (options) => {
        try {
          const msg = prepare ? prepare(options.input || {}) : null;
          if (!msg) return undefined;
          // `pastTenseMessage` is still behind VS Code's private
          // `chatParticipantPrivate` proposal. Marketplace extensions cannot use
          // that API, so keep tool preparation on the stable contract.
          return { invocationMessage: msg };
        } catch {
          return undefined;
        }
      },
      invoke: async (options, _token) => {
        const input = options.input || {};
        const safe = { ...input };
        if (safe.password) safe.password = "•••";
        log(`→ ${name} ${JSON.stringify(safe)}`);
        try {
          const result = await handler(input);
          try {
            const first = result.content && result.content[0];
            log(`← ${name} ${first && first.value ? String(first.value).slice(0, 300).replace(/\n/g, " ⏎ ") : "(non-text result)"}`);
          } catch { /* logging only */ }
          return result;
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          log(`✗ ${name} threw: ${msg}`);
          return textResult(`❌ ${msg}`);
        }
      },
    })
  );
}

// ---- Saved values (VS Code SecretStorage → OS keychain; never plaintext, never in model
// context, never logged). Shape per bundle id: { email?, password?, overrides?: {key: value} }.

let extCtx = null;

async function getSaved(bundleId) {
  if (!extCtx || !bundleId) return {};
  try {
    const raw = await extCtx.secrets.get(`tapp.saved.${bundleId}`);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function setSaved(bundleId, data) {
  if (!extCtx || !bundleId) return;
  await extCtx.secrets.store(`tapp.saved.${bundleId}`, JSON.stringify(data));
}

// Non-blocking "never type it twice" offer — shown after a value already worked, so saying
// nothing costs nothing and the tool result is never delayed.
function offerToSave(bundleId, what, apply) {
  vscode.window
    .showInformationMessage(`Tapp: save ${what} for ${bundleId} so future runs use ${what.includes("credential") ? "them" : "it"} automatically?`, "Always use", "Not now")
    .then(async (choice) => {
      if (choice !== "Always use") return;
      const saved = await getSaved(bundleId);
      await setSaved(bundleId, apply(saved));
      log(`saved ${what} for ${bundleId} (SecretStorage)`);
    });
}

// The mid-run pause prompt — mirrors the desktop app's three resolutions:
// enter values (submit) / use defaults for this screen / don't ask again this run.
async function promptForInputRequest(req, bundleId) {
  const fieldNames = (req.fields || []).map((f) => f.label || f.key).join(", ");
  const pick = await vscode.window.showQuickPick(
    [
      { label: "$(edit) Enter values…", description: fieldNames, action: "submit" },
      { label: "$(circle-slash) Use safe defaults for this screen", action: "defaults" },
      { label: "$(mute) Use defaults for the rest of the run", action: "dont_ask" },
    ],
    { title: `Tapp — “${req.screen}” is asking for input`, ignoreFocusOut: true }
  );
  if (!pick) return { action: "defaults" };
  if (pick.action !== "submit") return { action: pick.action };

  const values = {};
  for (const f of req.fields || []) {
    const v = await vscode.window.showInputBox({
      title: `Tapp — ${req.screen}`,
      prompt: f.label || f.key,
      placeHolder: f.placeholder || undefined,
      value: !f.secure && f.default ? f.default : undefined,
      password: !!f.secure,
      ignoreFocusOut: true,
    });
    if (v === undefined) return { action: "defaults" };
    if (v !== "") values[f.key] = v;
  }

  if (Object.keys(values).length && bundleId) {
    const rem = await vscode.window.showQuickPick(
      [
        { label: "$(save) Always use these values for this app", remember: true },
        { label: "Just this run", remember: false },
      ],
      { title: "Remember these values for future runs?", ignoreFocusOut: true }
    );
    if (rem && rem.remember) {
      const saved = await getSaved(bundleId);
      saved.overrides = { ...(saved.overrides || {}) };
      for (const f of req.fields || []) {
        const v = values[f.key];
        if (!v) continue;
        // Store under both selector forms the harness matches, plus promote email/password
        // fields to top-level creds so the login preamble skips the pause entirely next run.
        saved.overrides[`id:${f.key}`] = v;
        if (f.label) saved.overrides[`label:${f.label}`] = v;
        const hint = `${f.key} ${f.label || ""}`.toLowerCase();
        if (f.secure) saved.password = v;
        else if (hint.includes("email") || hint.includes("user")) saved.email = v;
      }
      await setSaved(bundleId, saved);
      log(`saved input values for ${bundleId} (SecretStorage)`);
    }
  }
  return { action: "submit", values };
}

function activate(ctx) {
  extCtx = ctx;
  out = vscode.window.createOutputChannel("Tapp");
  log(`Tapp extension activated (workspace: ${wsDir() || "none"})`);
  ctx.subscriptions.push(vscode.commands.registerCommand("tapp.showSimulator", () => SimulatorPanel.show()));
  ctx.subscriptions.push(
    vscode.commands.registerCommand("tapp.forgetSaved", async () => {
      const bundleId = await vscode.window.showInputBox({
        title: "Tapp — forget saved values",
        prompt: "Bundle id to forget saved credentials/values for",
        value: (bridge && bridge.bundleId) || "",
        ignoreFocusOut: true,
      });
      if (!bundleId) return;
      await extCtx.secrets.delete(`tapp.saved.${bundleId}`);
      vscode.window.showInformationMessage(`Tapp: forgot saved values for ${bundleId}.`);
    })
  );

  registerTool(ctx, "tapp_open_ios_app", async (input) => {
    const ws = wsDir();
    if (!ws && !input.target) return textResult(`❌ ${NO_WORKSPACE}`);
    SimulatorPanel.show();
    SimulatorPanel.pause("Building, installing, and opening the app…");
    const r = await getBridge().openTarget(input.target, ws || process.cwd(), input.focus);
    if (r.error) return textResult(`❌ ${r.error}`);
    SimulatorPanel.resume();
    return textResult(r.text);
  }, (input) => `📱 Opening ${input.target || "the iOS app"} on the simulator`);

  registerTool(ctx, "tapp_ios_focus", async (input) => {
    if (!input.query) return textResult("❌ `query` is required — name the screen, control, or focused UI task.");
    const r = await getBridge().focus(input.query, wsDir() || process.cwd());
    return textResult(r.error ? `❌ ${r.error}` : r.text);
  }, (input) => `⚡ Navigating directly to “${input.query || "the requested screen"}”`);

  registerTool(ctx, "tapp_read_ios_screen", async () => {
    const r = await getBridge().readScreen();
    return textResult(r.error ? `❌ ${r.error}` : r.text);
  }, () => "🌳 Reading the current screen");

  registerTool(ctx, "tapp_ios_screenshot", async () => {
    const r = await getBridge().screenshot();
    if (r.error) return textResult(`❌ ${r.error}`);
    SimulatorPanel.show();
    // Persist every screenshot so the session leaves a trail (chat thumbnails are ephemeral).
    let saved = "";
    try {
      if (r.image) {
        const dir = path.join(os.homedir(), ".tapp", "shots");
        fs.mkdirSync(dir, { recursive: true });
        const p = path.join(dir, `session-${Date.now()}.jpg`);
        fs.writeFileSync(p, r.image.data);
        saved = `\n💾 Saved: ${p}`;
      }
    } catch { /* persistence is best-effort */ }
    return resultWithImage(r.text + saved, r.image);
  }, () => "📸 Screenshotting the simulator");

  registerTool(ctx, "tapp_ios_login", async (input) => {
    const b = getBridge();
    const bundleId = b.bundleId;
    let email = input.email ? String(input.email) : null;
    let password = input.password ? String(input.password) : null;
    const agentProvided = !!(email && password);
    let usedSaved = false;

    // No credentials from the agent → saved values first ("never type it twice"), else
    // prompt the human directly. Values go straight to the app; the model never sees them.
    if (!email || !password) {
      const saved = await getSaved(bundleId);
      if (saved.email && saved.password) {
        email = saved.email;
        password = saved.password;
        usedSaved = true;
        vscode.window.showInformationMessage(`Tapp: signing in with saved credentials for ${bundleId} (${saved.email}). Run “Tapp: Forget saved values” to clear.`);
      }
    }
    if (!email) {
      email = await vscode.window.showInputBox({ title: "Tapp — sign in", prompt: "Email / username for the app's login", ignoreFocusOut: true });
      if (!email) return textResult("🙅 The user cancelled the credential prompt — do not retry; ask them how to proceed.");
    }
    if (!password) {
      password = await vscode.window.showInputBox({ title: "Tapp — sign in", prompt: `Password for ${email}`, password: true, ignoreFocusOut: true });
      if (!password) return textResult("🙅 The user cancelled the credential prompt — do not retry; ask them how to proceed.");
    }

    const r = await getBridge().login(email, password);
    // Only offer to remember values that just WORKED, and never re-offer saved ones.
    if (!r.error && !usedSaved && bundleId) {
      const em = email;
      const pw = password;
      offerToSave(bundleId, "these credentials", (saved) => ({ ...saved, email: em, password: pw }));
    }
    const suffix = agentProvided || usedSaved ? "" : "\n\n(Credentials were entered by the user directly — they were not shown to you.)";
    return textResult((r.error ? `❌ ${r.error}` : r.text) + suffix);
  }, (input) => (input.email ? `🔐 Signing in as ${input.email}` : "🔐 Signing in (saved or user-provided credentials)"));

  registerTool(ctx, "tapp_ios_fill_field", async (input) => {
    if (!input.id) return textResult("❌ `id` is required — which field to fill.");
    const value = await vscode.window.showInputBox({
      title: "Tapp — the agent needs a value",
      prompt: input.prompt ? String(input.prompt) : `Value for “${input.id}”`,
      password: !!input.secure,
      ignoreFocusOut: true,
    });
    if (value === undefined || value === "") {
      return textResult("🙅 The user cancelled the input prompt — do not retry; ask them how to proceed.");
    }
    const b = getBridge();
    const r = await b.act({ action: "type", id: String(input.id), text: value });
    if (r.error) return textResult(`❌ ${r.error}`);
    if (b.bundleId && !input.secure) {
      const fieldId = String(input.id);
      offerToSave(b.bundleId, `this value for “${fieldId}”`, (saved) => ({
        ...saved,
        overrides: { ...(saved.overrides || {}), [`id:${fieldId}`]: value, [`label:${fieldId}`]: value },
      }));
    }
    // Strip nothing from the harness text (it never echoes typed values), just add provenance.
    return textResult(r.text + "\n\n(Value entered by the user directly — it was not shown to you.)");
  }, (input) => `🙋 Asking you for ${input.prompt ? `“${input.prompt}”` : `a value for “${input.id || "a field"}”`}`);

  registerTool(ctx, "tapp_ios_tap", async (input) => {
    if (!input.id) return textResult("❌ `id` is required — the accessibility id or visible label to tap.");
    const r = await getBridge().act({ action: "tap", id: String(input.id) });
    return textResult(r.error ? `❌ ${r.error}` : r.text);
  }, (input) => `👆 Tapping “${input.id || "?"}”`);

  registerTool(ctx, "tapp_ios_type", async (input) => {
    if (!input.text) return textResult("❌ `text` is required.");
    const b = getBridge();
    const r = await b.act({ action: "type", text: String(input.text), ...(input.id ? { id: String(input.id) } : {}) });
    return textResult(r.error ? `❌ ${r.error}` : r.text);
  }, (input) => `⌨️ Typing into ${input.id || "the focused field"}`);

  registerTool(ctx, "tapp_explore_ios", async (input) => {
    const ws = wsDir();
    if (!ws && !input.target) return textResult(`❌ ${NO_WORKSPACE}`);
    SimulatorPanel.show();
    SimulatorPanel.pause("Building and opening the app for exploration…");
    const b = getBridge();
    // Interactive QA: saved values flow in silently (no pause), and when the app asks for
    // something new the run pauses and VS Code prompts — the desktop app's mid-run input,
    // Copilot-native. User wait time doesn't count against the exploration budget.
    const preSaved = b.bundleId ? await getSaved(b.bundleId) : {};
    if (preSaved.email || (preSaved.overrides && Object.keys(preSaved.overrides).length)) {
      vscode.window.showInformationMessage(`Tapp: using saved values for ${b.bundleId} (${[preSaved.email && "credentials", preSaved.overrides && Object.keys(preSaved.overrides).length && `${Object.keys(preSaved.overrides).length} field value(s)`].filter(Boolean).join(", ")}).`);
    }
    const r = await b.explore(input.target, input.maxActions, ws || process.cwd(), {
      testEmail: preSaved.email,
      testPassword: preSaved.password,
      inputOverrides: preSaved.overrides,
      onVisualReady: () => SimulatorPanel.resume(),
      onAwaitInput: async (req, bundleId) => {
        // Re-check saved values at pause time (the bundle id is definitely known here).
        const saved = await getSaved(bundleId);
        const fromSaved = {};
        for (const f of req.fields || []) {
          const v = (saved.overrides || {})[`id:${f.key}`] || (f.label && (saved.overrides || {})[`label:${f.label}`]) || (f.secure ? saved.password : null);
          if (v) fromSaved[f.key] = v;
        }
        if (Object.keys(fromSaved).length === (req.fields || []).length && (req.fields || []).length > 0) {
          vscode.window.showInformationMessage(`Tapp: “${req.screen}” filled from saved values.`);
          return { action: "submit", values: fromSaved };
        }
        return promptForInputRequest(req, bundleId);
      },
    });
    return textResult(r.error ? `❌ ${r.error}` : r.text);
  }, (input) => `🔭 Exploring${input.target ? ` ${input.target}` : " the iOS app"}`);

  registerTool(ctx, "tapp_build_ios_app", async (input) => {
    const ws = wsDir();
    if (!ws && !input.projectDir) return textResult(`❌ ${NO_WORKSPACE}`);
    const dir = input.projectDir ? path.resolve(ws || process.cwd(), String(input.projectDir)) : ws;
    SimulatorPanel.pause("Building and installing the app…");
    const r = await getBridge().build(dir, input.scheme ? String(input.scheme) : undefined);
    return textResult(r.error ? `❌ ${r.error}` : r.text);
  }, () => "🔨 Building the iOS app for the simulator");
}

function deactivate() {
  if (bridge) return bridge.dispose();
}

module.exports = { activate, deactivate };

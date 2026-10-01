"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { TappBridge } = require("../bridge");

function extensionFixture({ actors = [], saved = {}, savedError = false, prompt = "test-secret" } = {}) {
  const tools = new Map();
  const state = { logins: [], savedReads: 0, instances: 0 };
  class Bridge {
    constructor() { state.instances++; this.sessionActive = false; }
    async openTarget() { this.sessionActive = true; this.bundleId = "test.app"; return { text: "Session started" }; }
    async actors() { return actors; }
    async login(email, password, actor) { state.logins.push({ email, password, actor }); return { text: "Signed in — ok" }; }
  }
  const vscode = {
    workspace: { workspaceFolders: [{ uri: { fsPath: "/tmp" } }] },
    ViewColumn: { Beside: 2 },
    LanguageModelToolResult: class { constructor(content) { this.content = content; } },
    LanguageModelTextPart: class { constructor(value) { this.value = value; } },
    lm: { registerTool: (name, tool) => { tools.set(name, tool); return {}; } },
    commands: { registerCommand: () => ({}) },
    window: {
      createOutputChannel: () => ({ appendLine() {} }),
      createWebviewPanel: () => ({ visible: false, webview: { postMessage() {} }, onDidDispose() {}, reveal() {} }),
      showInformationMessage: async () => "Not now",
      showInputBox: async () => prompt,
      showQuickPick: async (choices) => choices[0],
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8"), {
    module, require: (id) => id === "vscode" ? vscode : id === "./bridge" ? { TappBridge: Bridge, exec: async () => ({ code: 1 }) } : require(id),
    setInterval: () => 0, clearInterval() {}, process,
  });
  module.exports.activate({ subscriptions: [], secrets: {
    get: async () => { state.savedReads++; if (savedError) throw new Error("locked"); return JSON.stringify(saved); },
    store: async () => {}, delete: async () => {},
  } });
  return { state, invoke: async (name, input = {}) => (await tools.get(name).invoke({ input })).content[0].value };
}

test("extension open then login retains the bridge and prioritizes a configured actor over stale saved values", async () => {
  const fixture = extensionFixture({ actors: ["coach"], saved: { email: "stale@example.com", password: "stale" } });
  assert.match(await fixture.invoke("tapp_open_ios_app", { target: "test.app" }), /Session started/);
  assert.match(await fixture.invoke("tapp_ios_login"), /Signed in/);
  assert.equal(fixture.state.instances, 1);
  assert.equal(fixture.state.savedReads, 0);
  assert.deepEqual(fixture.state.logins, [{ email: null, password: null, actor: "coach" }]);
});

test("partial explicit login credentials survive and never mix with a saved identity", async () => {
  const fixture = extensionFixture({ saved: { email: "stale@example.com", password: "stale" } });
  await fixture.invoke("tapp_open_ios_app", { target: "test.app" });
  await fixture.invoke("tapp_ios_login", { email: "new@example.com" });
  assert.equal(fixture.state.savedReads, 0);
  assert.deepEqual(fixture.state.logins, [{ email: "new@example.com", password: "test-secret", actor: undefined }]);
});

test("failed credential storage lookup does not mutate or submit a login form", async () => {
  const fixture = extensionFixture({ savedError: true });
  await fixture.invoke("tapp_open_ios_app", { target: "test.app" });
  const result = await fixture.invoke("tapp_ios_login");
  assert.match(result, /Saved credentials could not be read/);
  assert.equal(fixture.state.logins.length, 0);
});

test("concurrent connection requests share one persistent MCP client", async () => {
  const bridge = new TappBridge();
  let connections = 0;
  const client = {};
  bridge.connectClient = async () => { connections++; await new Promise((r) => setTimeout(r, 10)); return client; };
  const clients = await Promise.all([bridge.ensure(), bridge.ensure(), bridge.ensure()]);
  assert.equal(connections, 1);
  assert.ok(clients.every((c) => c === client));
  bridge.sessionActive = true;
  client.onclose();
  assert.equal(bridge.client, null);
  assert.equal(bridge.sessionActive, false);
  assert.match((await bridge.login("qa@example.com", "test")).error, /connection closed/);
});

test("login waits for open and concurrent native commands remain ordered", async () => {
  const bridge = new TappBridge();
  const calls = [];
  let inFlight = 0;
  bridge.connectClient = async () => ({ callTool: async ({ name, arguments: args }) => {
    assert.equal(inFlight++, 0, "only one command may use the native command channel");
    calls.push({ name, args });
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    return { content: [{ type: "text", text: name === "tapp_session_start" ? "Session started" : "Signed in — ok" }] };
  } });
  const open = bridge.openTarget("com.example.app", "/tmp");
  const login = bridge.login("qa@example.com", "test-secret", "coach");
  const read = bridge.readScreen();
  const results = await Promise.all([open, login, read]);
  assert.ok(results.every((r) => !r.error));
  assert.deepEqual(calls.map((c) => c.name), ["tapp_session_start", "tapp_session_act", "tapp_session_act"]);
  assert.deepEqual(calls[1].args, { action: "login", email: "qa@example.com", password: "test-secret", actor: "coach" });
});

test("target classification distinguishes bundle ids from paths", () => {
  const bridge = new TappBridge({ cwd: "/tmp" });
  assert.equal(bridge.looksLikeBundleId("com.example.app"), true);
  assert.equal(bridge.looksLikeBundleId("./Build/App.app"), false);
  assert.equal(bridge.looksLikeBundleId("/tmp/project"), false);
  assert.equal(bridge.looksLikeBundleId("App.app"), true);
});

test("an existing .app path wins over the bundle-id heuristic", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-extension-test-"));
  const appPath = path.join(dir, "Demo.app");
  fs.mkdirSync(appPath);
  const bridge = new TappBridge({ cwd: dir });
  bridge.installDotApp = async (resolved) => ({ bundleId: `installed:${resolved}` });
  const result = await bridge.resolveBundleId("Demo.app", dir);
  assert.equal(result.bundleId, `installed:${appPath}`);
});

test("MCP results expose text, images, and error state", () => {
  const bridge = new TappBridge({ cwd: "/tmp" });
  const result = {
    isError: true,
    content: [
      { type: "text", text: "first" },
      { type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" },
      { type: "text", text: "second" },
    ],
  };
  assert.equal(bridge.textOf(result), "first\nsecond");
  assert.deepEqual(bridge.imageOf(result), { data: Buffer.from("png"), mimeType: "image/png" });
  assert.equal(bridge.isError(result), true);
});

test("interactive actions are rejected until an app session is open", async () => {
  const bridge = new TappBridge({ cwd: "/tmp" });
  assert.deepEqual(await bridge.act({ action: "tree" }), {
    error: "No app is open — call tapp_open_ios_app first.",
  });
});

test("bundle-id targets bypass builds and start a session", async () => {
  const calls = [];
  const bridge = new TappBridge({ cwd: "/tmp" });
  bridge.call = async (name, args) => {
    calls.push({ name, args });
    return { content: [{ type: "text", text: "Home\nButton: Continue" }] };
  };

  const result = await bridge.openTarget("com.example.app", "/tmp/project");
  assert.equal(result.bundleId, "com.example.app");
  assert.match(result.text, /Home/);
  assert.deepEqual(calls, [
    { name: "tapp_session_start", args: { appBundleId: "com.example.app" } },
  ]);
  assert.equal(bridge.sessionActive, true);
});

test("focused open forwards the source-connected goal and workspace in one session call", async () => {
  const calls = [];
  const bridge = new TappBridge({ cwd:"/tmp/project" });
  bridge.call = async (name, args) => {
    calls.push({ name, args });
    return { content:[{ type:"text", text:"Storefront Settings" }] };
  };
  await bridge.openTarget("com.example.app", "/tmp/project", "Save storefront settings visible above keyboard");
  assert.deepEqual(calls, [{ name:"tapp_session_start", args:{
    appBundleId:"com.example.app",
    focus:"Save storefront settings visible above keyboard",
    projectDir:"/tmp/project",
  } }]);
});

test("exploration forwards the action budget and saved inputs to the current MCP tool", async () => {
  const calls = [];
  const bridge = new TappBridge({ cwd: "/tmp" });
  bridge.call = async (name, args) => {
    calls.push({ name, args });
    return { content: [{ type: "text", text: "EXPLORED · observation only" }] };
  };

  const result = await bridge.explore("com.example.app", 25, "/tmp/project", {
    testEmail: "qa@example.com",
    testPassword: "secret",
    inputOverrides: { "id:Code": "1234" },
  });

  assert.equal(result.text, "EXPLORED · observation only");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "tapp_explore");
  assert.match(calls[0].args.visualReadyPath, /tapp-visual-ready-/);
  assert.deepEqual({ ...calls[0].args, visualReadyPath: "<temp>" }, {
    appBundleId: "com.example.app",
    maxActions: 25,
    testEmail: "qa@example.com",
    testPassword: "secret",
    inputOverrides: { "id:Code": "1234" },
    visualReadyPath: "<temp>",
  });
});

test("VS Code preview waits for the settled visual-ready handshake", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "extension.js"), "utf8");
  assert.match(source, /SimulatorPanel\.pause\("Building and opening the app for exploration/);
  assert.match(source, /onVisualReady: \(\) => SimulatorPanel\.resume\(\)/);
  assert.match(source, /if \(this\.paused \|\| this\.busy/);
  assert.match(source, /if \(!this\.paused && shot\.code/);
});

test("tool preparation stays on the stable VS Code API", () => {
  const extensionSource = fs.readFileSync(path.join(__dirname, "..", "extension.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

  assert.doesNotMatch(extensionSource, /\bpastTenseMessage\s*:/);
  assert.deepEqual(manifest.enabledApiProposals || [], []);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TappBridge } = require("../bridge");

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
  assert.deepEqual(calls, [{
    name: "tapp_explore",
    args: {
      appBundleId: "com.example.app",
      maxActions: 25,
      testEmail: "qa@example.com",
      testPassword: "secret",
      inputOverrides: { "id:Code": "1234" },
    },
  }]);
});

test("tool preparation stays on the stable VS Code API", () => {
  const extensionSource = fs.readFileSync(path.join(__dirname, "..", "extension.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

  assert.doesNotMatch(extensionSource, /\bpastTenseMessage\s*:/);
  assert.deepEqual(manifest.enabledApiProposals || [], []);
});

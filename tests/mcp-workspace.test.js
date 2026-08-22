import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildUiMapFromMarkers } from "../mcp-server/src/ui-map.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tappBin = path.join(packageRoot, "bin", "tapp.js");
const skipRealBrowser = process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1";

function startMcp(cwd) {
  const proc = spawn("node", [tappBin, "mcp"], {
    cwd,
    env: { ...process.env, TAPP_HOME: path.join(cwd, ".test-tapp-home") },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const responses = new Map();
  let buffer = "";
  proc.stdout.on("data", (data) => {
    buffer += String(data);
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const parsed = JSON.parse(line);
        if (parsed.id !== undefined) responses.set(parsed.id, parsed);
      } catch { /* ignore non-protocol output */ }
    }
  });
  const send = (message) => proc.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = (id, timeoutMs = 15_000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (responses.has(id)) return resolve(responses.get(id));
      if (Date.now() - started > timeoutMs) return reject(new Error(`no MCP response for id ${id}`));
      setTimeout(poll, 25);
    };
    poll();
  });
  return { proc, send, waitFor };
}

test("installed MCP repository tools are rooted in the client workspace, not the package cache", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-mcp-workspace-"));
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({
    name: "workspace-app",
    private: true,
    scripts: { start: "node server.js" },
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "index.html"), "<!doctype html><title>Workspace App</title>");
  fs.writeFileSync(path.join(workspace, "server.js"), "require('node:http').createServer((_, r) => r.end('ok')).listen(3000);\n");
  fs.writeFileSync(path.join(workspace, "Settings.tsx"), "export const Settings = () => <button>Save storefront settings</button>;\n");

  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type":"text/html" });
    response.end(request.url === "/settings"
      ? '<!doctype html><h1>Settings</h1><button id="save" onclick="document.querySelector(\'#result\').textContent=\'Saved\'">Save settings</button><p id="result"></p>'
      : '<!doctype html><h1>Home</h1><a href="/settings">Settings</a>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const { proc, send, waitFor } = startMcp(workspace);
  try {
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "workspace-test", version: "0" } },
    });
    await waitFor(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tapp_health", arguments: {} } });
    const health = await waitFor(2);
    const workspaceCheck = health.result.structuredContent.checks.find((check) => check.check === "workspace");
    assert.equal(workspaceCheck.ok, true);
    assert.equal(workspaceCheck.value, fs.realpathSync(workspace));

    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tapp_init", arguments: { operation: "write", projectDir: ".", platform: "web" } } });
    const initialized = await waitFor(3);
    assert.notEqual(initialized.result.isError, true, initialized.result.content?.[0]?.text);
    assert.equal(initialized.result.structuredContent.model.application.name, "workspace-app");
    assert.ok(initialized.result.structuredContent.written.modelPath.startsWith(`${fs.realpathSync(workspace)}${path.sep}`));
    assert.ok(fs.existsSync(path.join(workspace, ".tapp", "application-model.json")));

    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "tapp_actor_config", arguments: { operation: "read" } } });
    const actors = await waitFor(4);
    assert.notEqual(actors.result.isError, true, actors.result.content?.[0]?.text);
    assert.ok(actors.result.structuredContent.path.startsWith(`${fs.realpathSync(workspace)}${path.sep}`));

    send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "tapp_init", arguments: { operation: "inspect", projectDir: ".." } } });
    const escaped = await waitFor(5);
    assert.equal(escaped.result.isError, true);
    assert.match(escaped.result.content[0].text, /inside the workspace/);

    send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "tapp_focus", arguments: { query:"Save storefront settings" } } });
    const focused = await waitFor(6);
    assert.notEqual(focused.result.isError, true, focused.result.content?.[0]?.text);
    assert.equal(focused.result.structuredContent.status, "source-located");
    assert.equal(focused.result.structuredContent.sourceMatches[0].path, "Settings.tsx");
    assert.equal(focused.result.structuredContent.execution.status, "not-started");

    send({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });
    const tools = await waitFor(7);
    const sessionStart = tools.result.tools.find((tool) => tool.name === "tapp_session_start");
    assert.ok(sessionStart.inputSchema.properties.url, "the source-connected session contract must include web URLs");
    assert.match(sessionStart.description, /iOS\/Android app or a web URL/);

    if (!skipRealBrowser) {
      const markersPath = path.join(workspace, "focus-markers.txt");
      fs.writeFileSync(markersPath, [
        `OCQA_STATE:{"screen":"Home","url":"${url}/","controls":[{"kind":"link","label":"Settings"}]}`,
        'OCQA_ACTION:{"type":"tap","target":"Settings","screen":"Home"}',
        'OCQA_TRANSITION:{"from":"Home","to":"Settings","action":"Settings","changed":true}',
        `OCQA_STATE:{"screen":"Settings","url":"${url}/settings","controls":[{"kind":"button","label":"Save settings","cssId":"save"}]}`,
      ].join("\n") + "\n");
      fs.writeFileSync(path.join(workspace, ".tapp", "ui-map.json"), JSON.stringify(buildUiMapFromMarkers({
        markersPath, platform:"web", target:url, runId:"mcp-workspace-focus",
      })));

      send({ jsonrpc:"2.0", id:8, method:"tools/call", params:{ name:"tapp_session_start", arguments:{ url, focus:"Settings page" } } });
      const started = await waitFor(8);
      assert.notEqual(started.result.isError, true, started.result.content?.[0]?.text);
      assert.equal(started.result.structuredContent.screenTitle, "Settings");
      assert.equal(started.result.structuredContent.url, `${url}/settings`);
      assert.equal(started.result.structuredContent.focus.execution.status, "reached");
      assert.equal(started.result.structuredContent.focus.elements, undefined, "the focused tree is returned only once");

      send({ jsonrpc:"2.0", id:9, method:"tools/call", params:{ name:"tapp_session_act", arguments:{ action:"tap", id:"Save settings" } } });
      const acted = await waitFor(9);
      assert.equal(acted.result.structuredContent.status, "ok");
      assert.equal(acted.result.structuredContent.elements.some((element) => element.label === "Saved"), true);

      send({ jsonrpc:"2.0", id:10, method:"tools/call", params:{ name:"tapp_session_end", arguments:{} } });
      await waitFor(10);
    }
  } finally {
    try {
      send({ jsonrpc:"2.0", id:99, method:"tools/call", params:{ name:"tapp_session_end", arguments:{} } });
      await Promise.race([waitFor(99, 2_000), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    } catch { /* the MCP process may already be gone */ }
    proc.kill();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

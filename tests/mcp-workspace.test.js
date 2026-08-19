import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tappBin = path.join(packageRoot, "bin", "tapp.js");

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
  } finally {
    proc.kill();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

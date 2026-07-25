// End-user surface smoke: the CLI answers, and the MCP server completes a real
// initialize → tools/list handshake over stdio (hand-rolled client, no SDK dependency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tappBin = path.join(root, "bin", "tapp.js");

test("tapp version prints the package version", () => {
  const out = execFileSync("node", [tappBin, "version"], { encoding: "utf8" }).trim();
  assert.match(out, /^\d+\.\d+\.\d+$/);
});

test("tapp help leads with the zero-config verbs", () => {
  const out = execFileSync("node", [tappBin], { encoding: "utf8" });
  assert.match(out, /Zero-config verbs/);
  assert.match(out, /tapp qa \[target\]/);
  assert.match(out, /never need to know a bundle id/);
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
    for (const required of ["tapp_run_qa", "tapp_build", "tapp_open_app", "tapp_session_act"]) {
      assert.ok(names.includes(required), `${required} present`);
    }
  } finally {
    proc.kill();
  }
});

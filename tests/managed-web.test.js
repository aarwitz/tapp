import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { managedWebDefaultPort, startManagedWebTarget, stopManagedWebTarget } from "../mcp-server/src/index.js";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

test("managed web prefers conventional framework origins before an ephemeral port", () => {
  assert.equal(managedWebDefaultPort({ vite:"6" }), 5173);
  assert.equal(managedWebDefaultPort({ next:"15" }), 3000);
  assert.equal(managedWebDefaultPort({}), 0);
});

test("a project.json web.port pin wins, and a busy or contradicted pin fails loudly", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-managed-pinned-port-"));
  const pinned = await freePort();
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({
    name: "pinned-port-site",
    scripts: { start: "python3 -m http.server $PORT --bind 127.0.0.1" },
  }));
  fs.writeFileSync(path.join(project, "index.html"), "<main>pinned port</main>");
  fs.mkdirSync(path.join(project, ".tapp"));
  fs.writeFileSync(path.join(project, ".tapp", "project.json"), JSON.stringify({ kind: "tapp-project-config", schemaVersion: 1, web: { port: pinned } }));
  const runtime = await startManagedWebTarget({ root: project, timeout: 30 });
  try {
    assert.equal(runtime.error, undefined);
    assert.equal(runtime.url, `http://127.0.0.1:${pinned}`);
  } finally {
    await stopManagedWebTarget(runtime);
  }

  // A CORS allowlist needs the exact pinned origin: a busy pin must refuse, not fall back.
  const blocker = net.createServer();
  await new Promise((resolve, reject) => blocker.listen(pinned, "127.0.0.1", resolve).once("error", reject));
  try {
    const busy = await startManagedWebTarget({ root: project, timeout: 30 });
    assert.match(busy.error || "", /already in use/);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }

  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({
    name: "pinned-port-site",
    scripts: { start: `python3 -m http.server ${pinned + 1} --bind 127.0.0.1` },
  }));
  const contradicted = await startManagedWebTarget({ root: project, timeout: 30 });
  assert.match(contradicted.error || "", /declares port/);
});

test("managed web targets honor a fixed port declared by the repository start script", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-managed-fixed-port-"));
  const port = await freePort();
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({
    name: "fixed-port-site",
    scripts: { start: `python3 -m http.server ${port} --bind 127.0.0.1` },
  }));
  fs.writeFileSync(path.join(project, "index.html"), "<main>fixed port</main>");
  const runtime = await startManagedWebTarget({ root: project, timeout: 30 });
  try {
    assert.equal(runtime.error, undefined);
    assert.equal(runtime.url, `http://127.0.0.1:${port}`);
    assert.equal((await fetch(runtime.url)).status, 200);
  } finally {
    await stopManagedWebTarget(runtime);
  }
  await assert.rejects(fetch(`http://127.0.0.1:${port}`), /fetch failed|ECONNREFUSED/i);
});

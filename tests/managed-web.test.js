import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startManagedWebTarget, stopManagedWebTarget } from "../mcp-server/src/index.js";

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

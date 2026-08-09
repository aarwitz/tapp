import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  actInteractiveSession,
  captureInteractiveSessionFrame,
  endInteractiveSession,
  saveInteractiveSessionFlow,
  startWebInteractiveSession,
} from "../mcp-server/src/index.js";
import { loadFlowFile } from "../mcp-server/src/flow-runtime.js";
import { runWebFlow } from "../mcp-server/src/web-flow.js";

let chromium;
try { ({ chromium } = await import("playwright")); } catch {}
const skipRealBrowser = process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1";

test("shared interactive session drives and captures a real web application", { skip:skipRealBrowser || !chromium, timeout:30_000 }, async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type":"text/html" });
    response.end(`<!doctype html><h1>Home</h1><label>Name <input id="name"></label><button id="next" onclick="document.querySelector('h1').textContent='Second screen'">Continue</button>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-web-session-flow-"));
  const url = `http://127.0.0.1:${port}`;
  try {
    const started = await startWebInteractiveSession(url, { testEmail:"private@example.test" });
    assert.equal(started.ok, true, started.error);
    assert.equal(started.screenTitle, "Home");
    assert.equal(started.elements.some((element) => element.id === "next" && element.hittable), true);

    const typed = await actInteractiveSession({ action:"type", id:"name", text:"private@example.test" });
    assert.equal(typed.status, "ok", typed.detail);
    const tapped = await actInteractiveSession({ action:"tap", id:"next" });
    assert.equal(tapped.status, "ok", tapped.detail);
    assert.equal(tapped.screenTitle, "Second screen");
    assert.ok(tapped.recordedSteps >= 2);

    const frame = await captureInteractiveSessionFrame();
    assert.equal(frame.mimeType, "image/jpeg");
    assert.ok(Buffer.from(frame.data, "base64").length > 1000);

    const saved = await saveInteractiveSessionFlow({ projectDir:project, name:"Recorded browser journey", url });
    assert.equal(saved.path, ".tapp/flows/recorded-browser-journey.yml");
    assert.match(saved.yaml, /platform: web/);
    assert.match(saved.yaml, /\$TEST_EMAIL/);
    assert.doesNotMatch(saved.yaml, /private@example\.test/);
    await assert.rejects(
      saveInteractiveSessionFlow({ projectDir:project, name:"Recorded browser journey", url }),
      (error) => error.code === "TAPP_FLOW_EXISTS",
    );

    await endInteractiveSession();
    const flow = loadFlowFile(path.join(project, saved.path));
    const replay = await runWebFlow({ flow, url });
    assert.equal(replay.passed, true);
  } finally {
    await endInteractiveSession();
    await new Promise((resolve) => server.close(resolve));
  }
});

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
  focusInteractiveSession,
  saveInteractiveSessionFlow,
  startWebInteractiveSession,
  isStableFlowCheckpoint,
} from "../mcp-server/src/index.js";
import { buildUiMapFromMarkers } from "../mcp-server/src/ui-map.js";
import { loadFlowFile } from "../mcp-server/src/flow-runtime.js";
import { runWebFlow } from "../mcp-server/src/web-flow.js";

let chromium;
try { ({ chromium } = await import("playwright")); } catch {}
const skipRealBrowser = process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1";

test("recorded Flow checkpoints reject loading labels and current-date headings", () => {
  assert.equal(isStableFlowCheckpoint("Loading…"), false);
  assert.equal(isStableFlowCheckpoint("Friday, August 21"), false);
  assert.equal(isStableFlowCheckpoint("August 21, 2026"), false);
  assert.equal(isStableFlowCheckpoint("Dashboard"), true);
});

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

test("focused session reaches a source-located web surface by its observed route in one call", { skip:skipRealBrowser || !chromium, timeout:30_000 }, async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type":"text/html" });
    response.end(request.url === "/settings"
      ? '<!doctype html><h1>Storefront Settings</h1><button id="save-storefront" onclick="document.querySelector(\'#result\').textContent=\'Settings saved\'">Save storefront settings</button><p id="result"></p>'
      : '<!doctype html><h1>Home</h1><a href="/settings">Storefront</a>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-web-focus-"));
  fs.mkdirSync(path.join(project, "src"), { recursive:true });
  fs.writeFileSync(path.join(project, "src", "StorefrontSettings.tsx"), 'export const StorefrontSettings = () => <button>Save storefront settings</button>;\n');
  fs.mkdirSync(path.join(project, ".tapp"));
  const markersPath = path.join(project, "markers.txt");
  fs.writeFileSync(markersPath, [
    `OCQA_STATE:{"screen":"Home","url":"${url}/","controls":[{"kind":"link","label":"Storefront"}]}`,
    'OCQA_ACTION:{"type":"tap","target":"Storefront","screen":"Home"}',
    'OCQA_TRANSITION:{"from":"Home","to":"Storefront Settings","action":"Storefront","changed":true}',
    `OCQA_STATE:{"screen":"Storefront Settings","url":"${url}/settings","controls":[{"kind":"button","label":"Save storefront settings","cssId":"save-storefront"}]}`,
  ].join("\n") + "\n");
  const map = buildUiMapFromMarkers({ markersPath, platform:"web", target:url, runId:"focus-web" });
  fs.writeFileSync(path.join(project, ".tapp", "ui-map.json"), JSON.stringify(map));
  try {
    const started = await startWebInteractiveSession(url);
    assert.equal(started.ok, true, started.error);
    const focused = await focusInteractiveSession({ projectDir:project, query:"verify Save storefront settings is visible", platform:"web" });
    assert.equal(focused.execution.status, "reached", focused.execution.reason);
    assert.equal(focused.screenTitle, "Storefront Settings");
    assert.equal(focused.execution.steps.length, 1);
    assert.equal(focused.execution.steps[0].target, "/settings");
    const clicked = await actInteractiveSession({ action:"tap", id:"Save storefront settings" });
    assert.equal(clicked.status, "ok", clicked.detail);
    assert.equal(clicked.elements.some((element) => element.role === "text" && element.label === "Settings saved"), true);
  } finally {
    await endInteractiveSession();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("one-call login is recorded without secrets and replays from a cold web session", { skip:skipRealBrowser || !chromium, timeout:30_000 }, async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type":"text/html" });
    response.end(`<!doctype html><h1>Sign In</h1><label>Email <input type="email"></label><label>Password <input type="password"></label><button onclick="document.querySelector('h1').textContent='Dashboard';document.querySelectorAll('label,button').forEach((e)=>e.remove())">Sign in</button>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-web-login-flow-"));
  try {
    const started = await startWebInteractiveSession(url, { testEmail:"private@example.test", testPassword:"private-password" });
    assert.equal(started.ok, true, started.error);
    const loggedIn = await actInteractiveSession({ action:"login" });
    assert.equal(loggedIn.status, "ok", loggedIn.detail);
    assert.equal(loggedIn.screenTitle, "Dashboard");
    assert.ok(loggedIn.durationMs >= 0);
    const saved = await saveInteractiveSessionFlow({ projectDir:project, name:"Recorded login", url });
    assert.match(saved.yaml, /login:/);
    assert.match(saved.yaml, /\$TEST_EMAIL/);
    assert.match(saved.yaml, /\$TEST_PASSWORD/);
    assert.doesNotMatch(saved.yaml, /private@example|private-password/);
    await endInteractiveSession();
    const replay = await runWebFlow({ flow:loadFlowFile(path.join(project, saved.path)), url });
    assert.equal(replay.passed, true);
  } finally {
    await endInteractiveSession();
    await new Promise((resolve) => server.close(resolve));
  }
});

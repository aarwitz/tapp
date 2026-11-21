import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import { studioConfig, listStudioJourneys, runStudioJourney, formatJourneyStatus } from "../mcp-server/src/studio-client.js";

test("a Studio is two values, and both are checked before anything is sent", () => {
  assert.equal(studioConfig({}, {}), null, "no Studio means work locally");
  assert.deepEqual(studioConfig({ studio: "https://app.runtapp.com/", token: "tapp_abc" }, {}), { origin: "https://app.runtapp.com", token: "tapp_abc" });
  assert.deepEqual(studioConfig({}, { TAPP_STUDIO: "https://app.runtapp.com", TAPP_TOKEN: "tapp_env" }), { origin: "https://app.runtapp.com", token: "tapp_env" });
  assert.throws(() => studioConfig({ studio: "app.runtapp.com", token: "tapp_x" }, {}), /not a Studio URL/);
  assert.throws(() => studioConfig({ studio: "https://app.runtapp.com" }, {}), /needs a token/);
  assert.throws(() => studioConfig({ studio: "https://app.runtapp.com", token: "ghp_notours" }, {}), /start with tapp_/);
});

test("the agent reads journeys and runs one, carrying the token and nothing else", async () => {
  const seen = [];
  const config = { origin: "https://app.runtapp.com", token: "tapp_secret" };
  globalThis.fetch = async (url, options = {}) => {
    seen.push({ url, method: options.method || "GET", auth: options.headers?.authorization, body: options.body });
    if (url.endsWith("/api/journeys")) return new Response(JSON.stringify({ journeys: [{ name: "Coach books", slug: "coach-books", steps: 6, status: { passed: true, at: "2026-10-22T12:00:00Z" } }] }), { status: 200 });
    if (url.endsWith("/api/operations/run-flow")) return new Response(JSON.stringify({ job: { id: "abc" } }), { status: 202 });
    return new Response(JSON.stringify({ status: "completed", progress: [{ text: "Reached Dashboard" }, { text: "On Settings" }], result: { kind: "journey", name: "Coach books", passed: true, executed: 6, total: 6 } }), { status: 200 });
  };
  try {
    const journeys = await listStudioJourneys(config);
    assert.equal(journeys[0].name, "Coach books");
    assert.equal(formatJourneyStatus(journeys[0]), "✓ Coach books — 6 steps · passing · 2026-10-22 12:00");
    assert.equal(formatJourneyStatus({ name: "New", steps: 2 }), "· New — 2 steps · never run");
    assert.equal(formatJourneyStatus({ name: "Broken", steps: 3, status: { passed: false, at: "2026-10-22T12:00:00Z" } }), "✗ Broken — 3 steps · FAILING · 2026-10-22 12:00");

    const lines = [];
    const result = await runStudioJourney(config, "coach-books", { onProgress: (line) => lines.push(line), sleep: async () => {} });
    assert.equal(result.passed, true);
    assert.deepEqual(lines, ["Reached Dashboard", "On Settings"], "the agent sees the same narration a person would");
    for (const request of seen) assert.equal(request.auth, "Bearer tapp_secret");
    assert.equal(seen.find((r) => r.method === "POST").body, JSON.stringify({ name: "coach-books" }));
  } finally { delete globalThis.fetch; }
});

test("a journey that needs a device, a revoked token, and an unreachable Studio each say so", async () => {
  const config = { origin: "https://app.runtapp.com", token: "tapp_secret" };
  globalThis.fetch = async () => new Response(JSON.stringify({ kind: "self-host", message: "runs on an iOS simulator", command: "npx -y @aarwitz/tapp@latest run x.yml" }), { status: 200 });
  const device = await runStudioJourney(config, "mobile-journey", { sleep: async () => {} });
  assert.equal(device.kind, "self-host");
  assert.match(device.message, /iOS simulator/);

  globalThis.fetch = async () => new Response(JSON.stringify({ error: "nope" }), { status: 401 });
  await assert.rejects(listStudioJourneys(config), /revoked/);

  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(listStudioJourneys(config), /Could not reach the Studio/);
  delete globalThis.fetch;
});

test("the CLI reports where the Studio does: from the machine's link, or the environment, with the runner's own verdict", async () => {
  const { studioLinkFor, flowResultFromLog } = await import("../mcp-server/src/studio-client.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-cli-link-"));
  assert.equal(studioLinkFor({ TAPP_HOME: home }), null, "nothing linked, nothing reported");
  fs.writeFileSync(path.join(home, "studio-link.json"), JSON.stringify({ origin: "https://app.runtapp.com", token: "tapp_abc", email: "o@example.test" }));
  assert.deepEqual(studioLinkFor({ TAPP_HOME: home }), { origin: "https://app.runtapp.com", token: "tapp_abc", email: "o@example.test" });
  // The environment wins, so one shell can report to a different Studio than the machine's link.
  assert.deepEqual(studioLinkFor({ TAPP_HOME: home, TAPP_STUDIO: "https://studio.example.test/", TAPP_TOKEN: "tapp_env" }), { origin: "https://studio.example.test", token: "tapp_env", email: "" });
  assert.equal(studioLinkFor({ TAPP_HOME: home, TAPP_STUDIO: "not a url", TAPP_TOKEN: "tapp_env" }), null, "a bad environment is not a reason to fail a run");
  // The verdict is the runner's last result line, as every platform's runner writes it.
  const log = ["OCQA_FLOW_RESULT:started total=3 name=x kind=flow", "OCQA_FLOW_STEP:{\"index\":1}", 'OCQA_FLOW_RESULT:{"passed":false,"name":"x","total":3,"executed":2,"failed":1}', ""].join("\n");
  assert.deepEqual(flowResultFromLog(log), { passed: false, name: "x", total: 3, executed: 2, failed: 1 });
  assert.equal(flowResultFromLog("nothing here"), null);
});

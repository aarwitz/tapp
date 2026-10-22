import test from "node:test";
import assert from "node:assert/strict";

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

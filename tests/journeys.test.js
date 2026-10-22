import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { journeyFromCapture, flowToYaml, JourneyStore, slugify } from "../mcp-server/src/journeys.js";
import { loadFlowFile, validateFlowSteps, inferFlowPlatform } from "../mcp-server/src/flow-runtime.js";

// A capture the way web-explorer writes one: the run opened the site, met a sign-in, was given
// a test account, went inside, tapped around, and followed a navigation link.
function plantCapture({ target = "http://127.0.0.1:8850/", signedIn = true, taps = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-journey-capture-"));
  fs.writeFileSync(path.join(dir, "provenance.json"), JSON.stringify({ kind: "explore", platform: "web", target, createdAt: "2026-10-22T15:00:00.000Z" }));
  const lines = [
    `OCQA_ACTION:${JSON.stringify({ t: 1, type: "open", target: "/", via: "/", narrative: "Opened /" })}`,
    `OCQA_STATE:${JSON.stringify({ t: 2, screen: "Sign in", url: "/" })}`,
    ...(signedIn ? [`OCQA_ACTION:${JSON.stringify({ t: 3, type: "login", target: "Sign in", screen: "Sign in", narrative: "Filled and submitted the sign-in form" })}`] : []),
    `OCQA_STATE:${JSON.stringify({ t: 4, screen: "Dashboard", url: "/" })}`,
    ...(taps ? [
      `OCQA_ACTION:${JSON.stringify({ t: 5, type: "tap", target: "Refresh", screen: "Dashboard", narrative: "Tapped \"Refresh\"" })}`,
      `OCQA_STATE:${JSON.stringify({ t: 6, screen: "Dashboard (refreshed)", url: "/" })}`,
      `OCQA_ACTION:${JSON.stringify({ t: 7, type: "open", target: "/orders", via: "Orders", narrative: "Opened /orders" })}`,
      `OCQA_STATE:${JSON.stringify({ t: 8, screen: "Orders", url: "/orders" })}`,
    ] : []),
    "OCQA_ISSUE:{\"t\":9,\"kind\":\"noise\"}",
  ];
  fs.writeFileSync(path.join(dir, "ocqa-markers.txt"), `${lines.join("\n")}\n`);
  return dir;
}

test("a signed-in exploration becomes a journey in the runner's own vocabulary, with no credentials in it", () => {
  const journey = journeyFromCapture(plantCapture(), { name: "Orders after sign-in", actor: "coach" });
  assert.ok(journey);
  assert.deepEqual(journey.flow.steps, [
    { wait_for: "Sign in" },
    { login: { email: "$TEST_EMAIL", password: "$TEST_PASSWORD" } },
    { wait_for: "Dashboard" },
    { tap: "Refresh" },
    { tap: "Orders" },
    { assert_screen: "Orders" },
  ], "a revisited screen is not waited for twice, a navigation link is a tap, and the run ends on an assertion");
  assert.equal(journey.flow.actor, "coach", "the journey knows which test account signs in");
  assert.equal(journey.signedIn, true);
  assert.deepEqual(journey.screens, ["Sign in", "Dashboard", "Orders"]);
  assert.doesNotMatch(journey.yaml, /Right-Password|coach@|password: "/, "credentials are variables, never values");
  assert.match(journey.yaml, /^name: "Orders after sign-in"\nplatform: web\nurl: "http:\/\/127\.0\.0\.1:8850\/"\nactor: "coach"\nsteps:\n/);
});

test("the journey the Studio writes is one the deterministic runner accepts as written", () => {
  const store = new JourneyStore({ root: fs.mkdtempSync(path.join(os.tmpdir(), "tapp-journeys-")) });
  const journey = journeyFromCapture(plantCapture());
  const kept = store.keep(journey);
  assert.equal(kept.slug, "127-0-0-1-8850-sign-in-to-orders", "an unnamed journey is named after where it went");
  const flow = loadFlowFile(kept.path);
  assert.equal(inferFlowPlatform(flow), "web");
  assert.deepEqual(validateFlowSteps(flow), [], "every step is in the vocabulary");
  assert.equal(flow.steps.length, 6);
  assert.equal(Object.keys(flow.steps[1])[0], "login");
  assert.throws(() => store.keep(journey), /already exists/, "a name is not silently overwritten");
  assert.doesNotThrow(() => store.keep(journey, { replace: true }));
});

test("a run that only looked is not a journey", () => {
  assert.equal(journeyFromCapture(plantCapture({ signedIn: false, taps: false })), null);
  assert.equal(journeyFromCapture(fs.mkdtempSync(path.join(os.tmpdir(), "tapp-empty-"))), null, "no capture, no journey");
});

test("a journey remembers how its last replay went, and lists without reading values", () => {
  const store = new JourneyStore({ root: fs.mkdtempSync(path.join(os.tmpdir(), "tapp-journeys-")) });
  const { slug } = store.keep(journeyFromCapture(plantCapture(), { name: "Coach signs in" }));
  assert.equal(store.list()[0].status, null, "never run yet");
  store.recordRun(slug, { passed: true, captureId: "flow-web-abc", executed: 6, total: 6 });
  const [listed] = store.list();
  assert.equal(listed.name, "Coach signs in");
  assert.equal(listed.steps, 6);
  assert.equal(listed.status.passed, true);
  assert.equal(listed.status.captureId, "flow-web-abc");
  assert.equal(listed.source, "kept");
  store.recordRun(slug, { passed: false, failed: 1, executed: 3, total: 6 });
  assert.equal(store.list()[0].status.passed, false);
  assert.equal(store.forget(slug), true);
  assert.deepEqual(store.list(), []);
});

test("names become safe file names; the per-owner roots are kept apart", () => {
  assert.equal(slugify("  Coach: books a session!  "), "coach-books-a-session");
  assert.equal(slugify("../../etc"), "etc");
  const env = { TAPP_HOME: "/tmp/tapp-home" };
  assert.equal(JourneyStore.forAccount("a".repeat(24), env).root, "/tmp/tapp-home/accounts/journeys/" + "a".repeat(24));
  assert.throws(() => JourneyStore.forAccount("../x", env), /account id/);
  assert.equal(JourneyStore.forMachine(env).root, "/tmp/tapp-home/journeys");
  assert.equal(JourneyStore.forRepository("/repo").root, "/repo/.tapp/flows");
  assert.match(flowToYaml({ name: "x", steps: [{ type: { field: "Search", value: "shoes" } }] }), /- type:\n    field: "Search"\n    value: "shoes"/);
});

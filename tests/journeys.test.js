import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { journeyFromCapture, flowToYaml, JourneyStore, slugify } from "../mcp-server/src/journeys.js";
import { loadFlowFile, validateFlowSteps, inferFlowPlatform } from "../mcp-server/src/flow-runtime.js";
import { normalizeScreenName } from "../mcp-server/src/web-flow.js";

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

test("a headline that wraps in the page source does not become an unmatchable screen name", () => {
  // Found by filming the product against a real customer app: the kept journey pinned
  // "Find the right coach.\n        Any goal. Any style. Anytime." and the replay failed on that
  // step, because a browser reports the same heading on one line.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-journey-wrapped-"));
  fs.writeFileSync(path.join(dir, "provenance.json"), JSON.stringify({ kind: "explore", platform: "web", target: "https://example.com/" }));
  fs.writeFileSync(path.join(dir, "ocqa-markers.txt"), [
    `OCQA_STATE:${JSON.stringify({ t: 1, screen: "Find the right coach.\n        Any goal. Any style. Anytime.", url: "/" })}`,
    `OCQA_ACTION:${JSON.stringify({ t: 2, type: "tap", target: "Become a Coach", screen: "Find the right coach." })}`,
    `OCQA_STATE:${JSON.stringify({ t: 3, screen: "Pricing", url: "/pricing" })}`,
  ].join("\n") + "\n");
  const journey = journeyFromCapture(dir, { name: "Browse coaches" });
  assert.ok(journey);
  assert.equal(journey.flow.steps[0].wait_for, "Find the right coach. Any goal. Any style. Anytime.");
  assert.doesNotMatch(journey.yaml, /\n\s{4,}/, "no step carries the page source's indentation");
});

test("replay compares screen names with whitespace collapsed on both sides", () => {
  // Journeys kept before this was fixed still hold the wrapped name; they must keep working.
  assert.equal(normalizeScreenName("Find the right coach.\n        Any goal."), "Find the right coach. Any goal.");
  assert.equal(normalizeScreenName("  Orders  "), "Orders");
  assert.equal(normalizeScreenName(null), "");
});

test("a journey is the path a person could walk, so it ends where the crawler teleported", () => {
  // The explorer seeds routes by address once it has exhausted a screen. Replaying a tap and then
  // expecting the page the crawler jumped to is a step nobody can reproduce, and the runner was
  // right to fail it. Keep what was demonstrated by pressing things; drop the rest.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-journey-jump-"));
  fs.writeFileSync(path.join(dir, "provenance.json"), JSON.stringify({ kind: "explore", platform: "web", target: "https://example.com/app" }));
  fs.writeFileSync(path.join(dir, "ocqa-markers.txt"), [
    `OCQA_ACTION:${JSON.stringify({ t: 1, type: "open", target: "/app", via: "https://example.com/app" })}`,
    `OCQA_STATE:${JSON.stringify({ t: 2, screen: "Sign in" })}`,
    `OCQA_ACTION:${JSON.stringify({ t: 3, type: "login", target: "Sign in" })}`,
    `OCQA_STATE:${JSON.stringify({ t: 4, screen: "Set up your profile" })}`,
    `OCQA_ACTION:${JSON.stringify({ t: 5, type: "tap", target: "Area" })}`,
    // A link somebody pressed is still part of the path.
    `OCQA_ACTION:${JSON.stringify({ t: 6, type: "open", target: "/app/hours", via: "Hours" })}`,
    `OCQA_STATE:${JSON.stringify({ t: 7, screen: "When do you coach?" })}`,
    // The crawler jumping to a route by address is not.
    `OCQA_ACTION:${JSON.stringify({ t: 8, type: "open", target: "/", via: "/" })}`,
    `OCQA_STATE:${JSON.stringify({ t: 9, screen: "Marketing home" })}`,
    `OCQA_ACTION:${JSON.stringify({ t: 10, type: "tap", target: "Pricing" })}`,
  ].join("\n") + "\n");
  const journey = journeyFromCapture(dir, { name: "Coach sets up a profile" });
  assert.deepEqual(journey.flow.steps, [
    { wait_for: "Sign in" },
    { login: { email: "$TEST_EMAIL", password: "$TEST_PASSWORD" } },
    { wait_for: "Set up your profile" },
    { tap: "Area" },
    { tap: "Hours" },
    { assert_screen: "When do you coach?" },
  ]);
  assert.doesNotMatch(journey.yaml, /Marketing home|Pricing/, "nothing after the jump is claimed as proven");
});

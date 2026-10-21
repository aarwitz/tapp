import test from "node:test";
import assert from "node:assert/strict";

import { JobLanes } from "../mcp-server/src/job-lanes.js";

// Work used to be serialized by one global, so a public Studio could only ever serve one person:
// the second visitor's audit failed with 409 naming a run that was not theirs. These assertions
// are about the bookkeeping alone, with no browser and no network, because the earlier version of
// this test drove real audits and only passed where they were slow enough to overlap.
const job = (operation) => ({ operation });

test("different visitors do not block each other", () => {
  const lanes = new JobLanes();
  assert.equal(lanes.claim("visitor-a", job("audit")).ok, true);
  assert.equal(lanes.claim("visitor-b", job("audit")).ok, true);
  assert.equal(lanes.guestsRunning, 2);
});

test("a visitor waits for their own run, and is told whose run it is", () => {
  const lanes = new JobLanes();
  lanes.claim("visitor-a", job("audit"));
  const second = lanes.claim("visitor-a", job("audit"));
  assert.equal(second.ok, false);
  assert.equal(second.statusCode, 409);
  assert.match(second.message, /'audit' is still running/);
});

test("the machine's ceiling is 'busy', not a lane conflict", () => {
  const lanes = new JobLanes({ maxConcurrentGuests: 2 });
  lanes.claim("a", job("audit"));
  lanes.claim("b", job("audit"));
  const third = lanes.claim("c", job("audit"));
  assert.equal(third.ok, false);
  assert.equal(third.statusCode, 503, "503 says the Studio is busy; 409 would falsely blame their own run");
  assert.doesNotMatch(third.message, /still running/);
});

test("the operator is serialized regardless of how many visitors are running", () => {
  // The operator's lane owns the simulator, the repository and the live session. A ceiling meant
  // for guests must never let a second operator run start, and must never block the first.
  const lanes = new JobLanes({ maxConcurrentGuests: 1 });
  assert.equal(lanes.claim("operator", job("gate")).ok, true);
  assert.equal(lanes.claim("visitor", job("audit")).ok, true);
  const again = lanes.claim("operator", job("explore"));
  assert.equal(again.ok, false);
  assert.equal(again.statusCode, 409);
});

test("releasing frees the lane, and a late finisher cannot free someone else's", () => {
  const lanes = new JobLanes();
  const first = job("audit");
  lanes.claim("visitor", first);
  lanes.release("visitor", first);
  assert.equal(lanes.running("visitor"), null);

  const second = job("audit");
  lanes.claim("visitor", second);
  lanes.release("visitor", first); // the old job completing late
  assert.equal(lanes.running("visitor"), second, "a stale completion must not free the current run");
  lanes.release("visitor", second);
  assert.equal(lanes.guestsRunning, 0);
});

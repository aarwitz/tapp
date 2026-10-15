import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Hosted iOS CI 2026-10-15: the harness finished, but `simctl io recordVideo` ignored SIGINT and an
// unbounded `wait` held the capture script — and the caller — until the 600s test budget expired.
test("stopping the simulator recorder is bounded: INT, then TERM, then KILL, never an open-ended wait", () => {
  const script = fs.readFileSync(path.join(root, "scripts", "quick-capture.sh"), "utf8");
  const stop = script.slice(script.indexOf("# Stop recording"), script.indexOf('rm -f "$RECORDING_STARTED_PATH"'));
  assert.match(stop, /kill -INT "\$RECORD_PID"/);
  assert.match(stop, /kill -TERM "\$RECORD_PID"/);
  assert.match(stop, /kill -KILL "\$RECORD_PID"/);
  assert.match(stop, /kill -0 "\$RECORD_PID"/, "polls for exit instead of blocking");
  assert.ok(stop.indexOf('wait "$RECORD_PID"') > stop.indexOf("kill -KILL"), "the only wait comes after the escalation ladder, when the recorder is dead");
});

test("the engine's exploration stream does not wait forever for a script whose grandchild holds the pipe", () => {
  const engine = fs.readFileSync(path.join(root, "mcp-server", "src", "index.js"), "utf8");
  const fn = engine.slice(engine.indexOf("async function runExploreStreaming"), engine.indexOf("return { created, timedOut, captureStderr };"));
  assert.doesNotMatch(fn, /^\s*await closed;\s*$/m, "an unconditional await on close is the hang");
  assert.match(fn, /Promise\.race\(\[closed/);
});

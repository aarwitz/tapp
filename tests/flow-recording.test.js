import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FlowLog } from "../mcp-server/src/flow-runtime.js";
import { parseFlowSteps, parseHold, sidecarPath, stepsInVideoTime, writeStepsSidecar } from "../mcp-server/src/flow-recording.js";

function loggedRun() {
  let clock = 10_000;
  const log = new FlowLog({ flow: { name: "Maya asks a question", steps: [1, 2, 3] }, now: () => clock });
  clock = 10_500; log.step({ index: 1, action: "tap", target: "Messages", status: "pass" });
  clock = 13_200; log.step({ index: 2, action: "type", target: "Ask Maya anything…", status: "pass" });
  clock = 13_600; log.step({ index: 3, action: "assert_screen", target: "Messages", status: "pass" });
  return { log, result: log.finish(), startedAtMs: 10_000 };
}

test("a flow reports when each of its steps happened", () => {
  const { result } = loggedRun();
  const steps = parseFlowSteps(result.lines.join("\n"));
  assert.deepEqual(steps.map((s) => [s.startMs, s.endMs]), [[0, 500], [500, 3200], [3200, 3600]]);
  // Windows are contiguous: a step's segment carries its own settling, which is what a cut wants.
  for (let i = 1; i < steps.length; i += 1) assert.equal(steps[i].startMs, steps[i - 1].endMs);
  assert.equal(result.durationMs, 3600);
  assert.match(result.startedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("step times are moved into the recording's own clock", () => {
  // The recorder starts before the flow does, by however long simctl takes to come up. That
  // gap is why hand-written step times ran ahead of the picture by a varying amount.
  const { result, startedAtMs } = loggedRun();
  const steps = parseFlowSteps(result.lines.join("\n"));
  const inVideo = stepsInVideoTime(steps, { flowStartedAtMs: startedAtMs, recordingStartedAtMs: startedAtMs - 1200 });
  assert.deepEqual(inVideo.map((s) => [s.start, s.end]), [[1.2, 1.7], [1.7, 4.4], [4.4, 4.8]]);

  // A recorder that started late must not push steps into negative time.
  const late = stepsInVideoTime(steps, { flowStartedAtMs: startedAtMs, recordingStartedAtMs: startedAtMs + 900 });
  assert.equal(late[0].start, 0, "a step from before the first frame belongs at the top");
  assert.ok(late[2].end > 0);
});

test("the sidecar tells an editor where the run ends, hold included", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-flow-recording-"));
  const video = path.join(dir, "take-c-maya.mp4");
  const { result, startedAtMs } = loggedRun();
  const written = writeStepsSidecar(video, parseFlowSteps(result.lines.join("\n")), {
    flowStartedAtMs: startedAtMs, recordingStartedAtMs: startedAtMs - 1000, holdMs: 3000, name: "Maya asks a question",
  });
  assert.equal(sidecarPath(video), path.join(dir, "take-c-maya.steps.json"));
  const onDisk = JSON.parse(fs.readFileSync(written.path, "utf8"));
  assert.equal(onDisk.video, "take-c-maya.mp4");
  assert.equal(onDisk.steps.length, 3);
  // The last step ends at 4.6s; a three second hold means a cut may run to 7.6s.
  assert.equal(onDisk.endsAt, 7.6);
  assert.equal(onDisk.holdSeconds, 3);
  assert.equal(onDisk.steps[0].target, "Messages");
});

test("a hold is written the way a person types it", () => {
  assert.equal(parseHold("3s"), 3000);
  assert.equal(parseHold("1500ms"), 1500);
  assert.equal(parseHold("2"), 2000);
  assert.equal(parseHold("2.5s"), 2500);
  assert.equal(parseHold(""), 0);
  assert.throws(() => parseHold("a while"), /duration like 3s/);
});

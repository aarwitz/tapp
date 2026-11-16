// TM-497: tapp owns the screen recording, and the clock it writes has to match the picture.
//
// Everything here is pinned to something measured on a real simulator on 2026-11-13, because the
// plan in the story was wrong about how `simctl io recordVideo` behaves and only a recording said
// so. The numbers in the comments are from those takes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  firstFrameAtMs, framePositions, padTail, prepareRecorder, recorderToolingError, restoreStatusBar,
  startRecording, statusBarTime, tailMsFor, videoDurationMs,
} from "../mcp-server/src/sim-recorder.js";

/** A stand-in for spawnSync that answers from a table and records what it was asked. */
function fakeRun(table) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    for (const [match, reply] of table) {
      if (new RegExp(match).test([cmd, ...args].join(" "))) return { status: 0, stdout: "", stderr: "", ...reply };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  run.calls = calls;
  return run;
}

test("the first frame is timed from the mark, not from when the recorder was spawned", () => {
  // A real take: frames at 0, 0, 1.230, 1.233, 4.350, 4.353, 7.493, 7.497. The two marks are the
  // 1.230/1.233 pair and `markAtMs` is the second of them, so a mark at wall-clock 10_000 means
  // the recording began at 10_000 - 1233.
  assert.equal(firstFrameAtMs([0, 0, 1.23, 1.233, 4.35], 10_000), 8_767);

  // THE BUG THIS SHAPE EXISTS FOR. With a single mark, a status bar that already read the mark's
  // value wrote no frame at all, and the first change in the file was the app launching twenty
  // seconds later — which silently put every step in the sidecar nineteen seconds late (caught by
  // running a real flow, not by this file). The second mark always differs from the first, so one
  // frame is all that is needed and it is the right one.
  assert.equal(firstFrameAtMs([0, 1.233, 20.5], 10_000), 8_767, "one mark frame is still the mark");

  // Spawn lag is NOT a constant to assume: 1.4s, 2.0s and 3.9s on one machine, three takes.
  assert.equal(firstFrameAtMs([0, 3.9, 3.903], 10_000), 6_097);
  // A change well past the mark window is the app, never the mark: the pair is 1.2/1.7, and the
  // frame at 30s is the harness finally launching.
  assert.equal(firstFrameAtMs([0, 1.2, 1.7, 30.0], 10_000), 8_300, "only the opening cluster counts");
  // Nothing ever changed: say so rather than invent a number that puts every step in the wrong
  // place.
  assert.equal(firstFrameAtMs([0], 10_000), null);
  assert.equal(firstFrameAtMs([], 10_000), null);
});

test("a recording with no readable duration is reported, not guessed at", () => {
  const run = fakeRun([["ffprobe", { stdout: "" }]]);
  assert.equal(videoDurationMs("/tmp/cut-off.mp4", { run }), null);
  assert.equal(videoDurationMs("/tmp/ok.mp4", { run: fakeRun([["ffprobe", { stdout: "10.613\n" }]]) }), 10_613);
});

test("frame positions come back in order, ignoring anything unreadable", () => {
  const run = fakeRun([["ffprobe", { stdout: "0.000000\n8.131667\n4.021667\n\nnot-a-number\n4.018333\n" }]]);
  assert.deepEqual(framePositions("/tmp/take.mp4", { run }), [0, 4.018333, 4.021667, 8.131667]);
});

test("--record says what it needs rather than failing obscurely later", () => {
  assert.match(recorderToolingError({ run: fakeRun([["ffprobe", { status: 1 }]]) }), /ffprobe/);
  assert.equal(recorderToolingError({ run: fakeRun([["ffprobe", { status: 0 }]]) }), "");
});

test("a simulator that shut itself down is booted, and a wedged recorder is cleared", () => {
  const run = fakeRun([
    ["simctl list devices", { stdout: JSON.stringify({ devices: { "iOS 26.4": [{ udid: "U1", state: "Shutdown" }] } }) }],
    ["recordVideo --help", { stderr: "An error was encountered processing the command: Host recording is already in progress" }],
  ]);
  const result = prepareRecorder("U1", { run });
  assert.equal(result.ok, true);
  assert.deepEqual(result.repaired, [
    "booted the simulator, which had shut itself down",
    "stopped a recorder left running by an earlier run",
  ]);
  assert.ok(run.calls.some((c) => /simctl boot U1/.test(c)), "it must actually boot the device");
  assert.ok(run.calls.some((c) => /pkill -INT -f simctl io U1 recordVideo/.test(c)), "and release the stuck recorder");
});

test("a booted simulator with a free recorder is left alone", () => {
  const run = fakeRun([["simctl list devices", { stdout: JSON.stringify({ devices: { "iOS 26.4": [{ udid: "U1", state: "Booted" }] } }) }]]);
  const result = prepareRecorder("U1", { run });
  assert.deepEqual(result.repaired, []);
  assert.ok(!run.calls.some((c) => /simctl boot/.test(c)), "nothing to repair means nothing is touched");
});

test("a device that will not boot fails the run with the reason", () => {
  const run = fakeRun([
    ["simctl list devices", { stdout: JSON.stringify({ devices: {} }) }],
    ["simctl boot", { status: 1, stderr: "Unable to boot device because it cannot be located on disk" }],
  ]);
  const result = prepareRecorder("GONE", { run });
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot be located on disk/);
});

// The hold is the part the story got wrong. `simctl io recordVideo` records CHANGES: a take left
// running four seconds past its last change came out 7.500s long with its last frame at 7.497s.
// So waiting longer adds nothing and the tail has to be added to the file.
test("holding the last screen extends the file, because waiting longer records nothing", () => {
  const run = fakeRun([["ffprobe", { stdout: "36.873\n" }], ["ffmpeg", { status: 0 }]]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-recorder-"));
  const file = path.join(dir, "take.mp4");
  fs.writeFileSync(file, "original");
  fs.writeFileSync(`${file}.padded.mp4`, "padded");   // what ffmpeg would have written
  const result = padTail(file, 3000, { run });
  assert.equal(result.padded, true);
  assert.equal(fs.readFileSync(file, "utf8"), "padded", "the padded file replaces the original");

  const ffmpeg = run.calls.find((c) => c.startsWith("ffmpeg"));
  // `-t` makes the cut: tpad alone came out short on a variable-rate input.
  assert.match(ffmpeg, /-t 39\.873/, "the finished length is set explicitly, not left to tpad");
  // THE BUG THAT MADE EVERY STEP POINT AT THE WRONG SCREEN. `-r 30` renumbers the frames it is
  // given at a fixed rate, so a 36.9s capture of 534 frames came out as 17.8s of picture. The
  // `fps` filter resamples against the timestamps instead.
  assert.match(ffmpeg, /-vf fps=30,tpad=/, "the tail is resampled by timestamp");
  assert.ok(!/ -r \d/.test(ffmpeg), "-r throws the capture's real timing away on a variable-rate file");

  assert.equal(padTail(file, 0, { run }).padded, false);
});

test("a hold that fails leaves the original recording alone and says so", () => {
  const run = fakeRun([["ffprobe", { stdout: "10.0\n" }], ["ffmpeg", { status: 1, stderr: "Unknown filter 'tpad'\n" }]]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-recorder-"));
  const file = path.join(dir, "take.mp4");
  fs.writeFileSync(file, "original");
  const result = padTail(file, 3000, { run });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown filter/);
  assert.equal(fs.readFileSync(file, "utf8"), "original", "a failed hold must not destroy the take");
});

// The tail is not just the hold: a flow that ends on a still screen leaves the file ending before
// the flow does, because nothing was changing to record.
test("the tail covers the gap the recorder left as well as the hold", () => {
  assert.equal(tailMsFor({ durationMs: 36_873, lastStepEndMs: 43_837, holdMs: 3_000 }), 9_964);
  assert.equal(tailMsFor({ durationMs: 40_000, lastStepEndMs: 30_000, holdMs: 3_000 }), 3_000,
    "a capture that already runs past the last step needs only the hold");
  assert.equal(tailMsFor({ durationMs: 40_000, lastStepEndMs: 30_000, holdMs: 0 }), 0);
});

test("the recorder marks itself on a still screen before the flow is allowed to start", async () => {
  const run = fakeRun([
    ["ffprobe .*format=duration", { stdout: "7.500\n" }],
    ["ffprobe .*packet=pts_time", { stdout: "0.000000\n1.230000\n4.350000\n7.497000\n" }],
  ]);
  const fakeChild = { stderr: null, kill() { this.killed = true; }, once(_e, fn) { setTimeout(fn, 0); } };
  const recorder = startRecording({
    udid: "U1", out: path.join(os.tmpdir(), `tapp-mark-${Date.now()}.mp4`),
    holdMs: 0, now: () => 10_000, spawnFn: () => fakeChild, run,
  });
  const markAt = await recorder.ready();
  assert.equal(markAt, 10_000);
  assert.ok(run.calls.some((c) => /simctl status_bar U1 override --time/.test(c)),
    "the mark is a status-bar change: one frame at an instant tapp knows");
  const stopped = await recorder.stop();
  assert.equal(stopped.ok, true);
  assert.equal(stopped.startedAtMs, 10_000 - 1230, "the first frame is the mark's position before the mark");
  assert.equal(stopped.frames, 4);
  assert.equal(fakeChild.killed, true);
  assert.ok(run.calls.some((c) => /simctl status_bar U1 clear/.test(c)),
    "nothing was overridden before the mark, so the mark is cleared again");
});

test("a take where nothing ever changed cannot be timed, and says which", async () => {
  const run = fakeRun([
    ["ffprobe .*format=duration", { stdout: "5.000\n" }],
    ["ffprobe .*packet=pts_time", { stdout: "0.000000\n" }],
  ]);
  const fakeChild = { stderr: null, kill() {}, once(_e, fn) { setTimeout(fn, 0); } };
  const recorder = startRecording({
    udid: "U1", out: path.join(os.tmpdir(), `tapp-still-${Date.now()}.mp4`),
    holdMs: 0, now: () => 1_000, spawnFn: () => fakeChild, run,
  });
  await recorder.ready();
  const stopped = await recorder.stop();
  assert.equal(stopped.ok, false);
  assert.match(stopped.error, /no mark to time it against/);
});

// Linux's check of 10f0a79: clearing the status bar after every take wipes a 9:41 clock somebody
// set deliberately for screenshots. What was there before the mark goes back afterwards.
test("the clock the author set survives a take", () => {
  const listing = "Current Status Bar Overrides:\n=============================\nTime: 9:41 \nCell Mode: 3, Cell Bars: 4\n";
  assert.equal(statusBarTime("U1", { run: fakeRun([["status_bar U1 list", { stdout: listing }]]) }), "9:41");
  // Nothing overridden: the listing has a header and nothing else.
  assert.equal(statusBarTime("U1", { run: fakeRun([["status_bar U1 list", { stdout: "Current Status Bar Overrides:\n=============================\n" }]]) }), "");

  const restored = fakeRun([]);
  restoreStatusBar("U1", "9:41", { run: restored });
  assert.ok(restored.calls.some((c) => /status_bar U1 override --time 9:41/.test(c)), "the author's clock goes back");
  assert.ok(!restored.calls.some((c) => /status_bar U1 clear/.test(c)), "and is not cleared out from under them");

  const cleared = fakeRun([]);
  restoreStatusBar("U1", "", { run: cleared });
  assert.ok(cleared.calls.some((c) => /status_bar U1 clear/.test(c)), "a simulator with no override is left with none");
});

test("a take remembers the clock before the mark changes it", async () => {
  const run = fakeRun([
    ["status_bar U1 list", { stdout: "Current Status Bar Overrides:\n=============================\nTime: 9:41 \n" }],
    ["ffprobe .*format=duration", { stdout: "7.500\n" }],
    ["ffprobe .*packet=pts_time", { stdout: "0.000000\n1.230000\n4.350000\n" }],
  ]);
  const fakeChild = { stderr: null, kill() {}, once(_e, fn) { setTimeout(fn, 0); } };
  const recorder = startRecording({
    udid: "U1", out: path.join(os.tmpdir(), `tapp-clock-${Date.now()}.mp4`),
    holdMs: 0, now: () => 10_000, spawnFn: () => fakeChild, run,
  });
  await recorder.ready();
  await recorder.stop();
  const listedAt = run.calls.findIndex((c) => /status_bar U1 list/.test(c));
  const markedAt = run.calls.findIndex((c) => /status_bar U1 override/.test(c));
  assert.ok(listedAt >= 0 && listedAt < markedAt, "the clock is read before the mark changes it");
  assert.ok(run.calls.some((c) => /status_bar U1 override --time 9:41/.test(c)), "and put back afterwards");
});

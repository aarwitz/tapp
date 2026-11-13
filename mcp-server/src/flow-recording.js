// Cutting a recording by step name instead of by eye.
//
// Making a narrated demo used to mean starting `simctl io recordVideo` by hand, running the
// flow, stopping the recorder, then building contact sheets and guessing where each step began.
// The wrapper's own step times came from its own clock, which runs ahead of the picture by a
// varying amount: the recorder takes a moment to start, and the simulator's file timestamps
// drift. So the times never quite matched the frames (TM-497).
//
// The fix is to put the two clocks in the same frame of reference once, here: the flow reports
// each step's window against its own start, and the recording reports when its first frame was
// captured relative to that same start. Everything after is arithmetic.
import fs from "node:fs";
import path from "node:path";

/** The step windows a finished flow log carries, in the flow's own milliseconds. */
export function parseFlowSteps(logText) {
  const steps = [];
  for (const line of String(logText || "").split("\n")) {
    if (!line.startsWith("OCQA_FLOW_STEP:")) continue;
    try {
      const step = JSON.parse(line.slice("OCQA_FLOW_STEP:".length));
      if (Number.isFinite(step.startMs) && Number.isFinite(step.endMs)) steps.push(step);
    } catch { /* a truncated final line */ }
  }
  return steps;
}

/**
 * The same steps expressed in the recording's seconds.
 *
 * `recordingStartedAtMs` is when the recorder's first frame was captured, on the same clock the
 * flow used for its own start. A recorder that began AFTER the flow gives a negative offset for
 * the earliest steps; they are clamped to zero rather than dropped, because a step that happened
 * just before the first frame still belongs at the top of the video.
 */
export function stepsInVideoTime(steps, { flowStartedAtMs, recordingStartedAtMs }) {
  const offsetMs = Number(flowStartedAtMs) - Number(recordingStartedAtMs);
  const seconds = (ms) => Math.max(0, Math.round((ms + offsetMs)) / 1000);
  return steps.map((step) => ({
    index: step.index,
    action: step.action,
    target: step.target,
    status: step.status,
    start: seconds(step.startMs),
    end: seconds(step.endMs),
  }));
}

/**
 * The sidecar an editor reads: the video's name, how long the run took, and every step in the
 * video's own seconds. Written next to the recording as `<name>.steps.json`.
 */
export function sidecarPath(videoPath) {
  const parsed = path.parse(String(videoPath));
  return path.join(parsed.dir, `${parsed.name}.steps.json`);
}

export function writeStepsSidecar(videoPath, steps, { flowStartedAtMs, recordingStartedAtMs, holdMs = 0, name = "" } = {}) {
  const inVideoTime = stepsInVideoTime(steps, { flowStartedAtMs, recordingStartedAtMs });
  const out = {
    video: path.basename(String(videoPath)),
    name,
    // What a cut should not run past: the last step's end plus whatever hold was asked for.
    endsAt: inVideoTime.length ? Number((inVideoTime[inVideoTime.length - 1].end + holdMs / 1000).toFixed(3)) : 0,
    holdSeconds: holdMs / 1000,
    steps: inVideoTime,
  };
  const target = sidecarPath(videoPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
  return { path: target, ...out };
}

/** "3s", "1500ms", "2" → milliseconds. The flag is for people, so accept what they will type. */
export function parseHold(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return 0;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?)?$/.exec(text);
  if (!match) throw new Error(`--hold expects a duration like 3s or 1500ms (got '${value}')`);
  const amount = Number(match[1]);
  return match[2] === "ms" ? Math.round(amount) : Math.round(amount * 1000);
}

// tapp owning the screen recording, instead of a wrapper script starting `simctl` by hand (TM-497).
//
// Making the 11/7 demo videos cost more on the recording side than on the app side: eight takes,
// three re-recorded because of one-time system alerts, one because the simulator had shut itself
// down and left a file with no moov atom, and every take ending on a final screen about one frame
// long. The step times came from the wrapper's own clock, which ran ahead of the picture by a
// varying amount.
//
// WHAT MEASUREMENT SHOWED, and why this is not a few lines in the CLI (2026-11-13, iPhone 17 Pro):
//
//   • `simctl io recordVideo` RECORDS CHANGES, NOT FRAMES. A still screen produces almost nothing:
//     a take over a motionless Settings screen with two status-bar changes in it came out as five
//     frames — one at 0, two at each change — over 8.1 seconds. A take over an animating map came
//     out as 345. So the file's DURATION ENDS AT THE LAST VISUAL CHANGE, not when the recorder was
//     stopped. That is the real reason a demo's final screen is one frame long, and it also means
//     `stoppedAt - duration` is wrong by however long the last screen was still.
//
//   • NOTHING IS WRITTEN UNTIL THE END. The file appears 134 ms after spawning and stays at zero
//     bytes until the recorder exits, so watching it grow cannot time the first frame either.
//
//   • THE START LAG IS REAL AND VARIES: 1.4 s, 2.0 s and 3.9 s across three takes on one machine.
//     It cannot be assumed, which is exactly what the old wrapper did.
//
// So the first frame is timed by putting a mark in the recording at a known instant: before the
// flow starts, while the screen is still, tapp changes the status bar. That forces a frame. The
// opening cluster of changes is therefore the mark, its position is read straight out of the
// container with ffprobe — no picture analysis — and everything else is arithmetic.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

/** How long to wait for the recorder to finalise the file after it is asked to stop. */
const FINALISE_TIMEOUT_MS = 15_000;

/** Let the recorder actually begin before marking it; the mark is useless if it lands first. */
const MARK_AFTER_MS = 1200;

/**
 * The mark is TWO status-bar changes, not one, and the second is the one timed against.
 *
 * One was not enough: the second recorded flow of the day put every step 19 seconds late because
 * the status bar already read 9:41 from the run before, so setting it to 9:41 changed nothing, no
 * frame was written, and the first change in the file was the app launching instead. Setting a
 * second, different value right after is guaranteed to change something whatever was there.
 */
const MARK_TIMES = ["9:41", "9:42"];
const MARK_GAP_MS = 500;

/** Frames this close to the first mark belong to the mark, not to anything the app did. */
const MARK_CLUSTER_S = 1.0;

const sh = (cmd, args, timeout = 20_000) => spawnSync(cmd, args, { encoding: "utf8", timeout });

/** Is ffprobe here? `--record` needs it to read where the mark landed; say so rather than guess. */
export function recorderToolingError({ run = sh } = {}) {
  const probe = run("ffprobe", ["-version"], 5_000);
  if (probe.status === 0) return "";
  return "--record needs ffprobe (part of ffmpeg) to time the recording against the flow: brew install ffmpeg";
}

/**
 * The status-bar time override currently in force, or "" when there is none.
 *
 * The mark changes the clock, so whatever was there has to be put back: 9:41 is the clock people
 * set deliberately for screenshots, and clearing it after every take quietly undid that (Linux's
 * check of 10f0a79). Overriding the time alone leaves the other fields — cell bars, operator —
 * exactly as they were, so only the time needs remembering.
 */
export function statusBarTime(udid, { run = sh } = {}) {
  const listed = run("xcrun", ["simctl", "status_bar", udid, "list"]);
  const match = /^\s*Time:\s*(.+?)\s*$/m.exec(String(listed.stdout || ""));
  return match ? match[1] : "";
}

/** Put the clock back the way the mark found it: the author's override, or none at all. */
export function restoreStatusBar(udid, previousTime, { run = sh } = {}) {
  if (previousTime) run("xcrun", ["simctl", "status_bar", udid, "override", "--time", previousTime]);
  else run("xcrun", ["simctl", "status_bar", udid, "clear"]);
}

/** Every frame's position in the finished file, in seconds, in order. */
export function framePositions(file, { run = sh } = {}) {
  const probe = run("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "packet=pts_time", "-of", "csv=p=0", String(file)]);
  return String(probe.stdout || "")
    .split("\n")
    // A blank line is not a frame at zero: Number("") is 0, which would add a phantom opening
    // frame to every take and shift the mark.
    .map((line) => line.trim()).filter(Boolean)
    .map(Number).filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}

/**
 * The duration ffprobe reports, in milliseconds, or null.
 *
 * null means "do not claim to know": a file with no readable duration is the broken case — a
 * recording killed before its moov atom was written — and inventing a number for it would put
 * every step in the sidecar at the wrong second.
 */
export function videoDurationMs(file, { run = sh } = {}) {
  const probe = run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", String(file)]);
  const seconds = Number(String(probe.stdout || "").trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

/**
 * When the recorder's first frame was captured, on the caller's clock.
 *
 * `markAtMs` is when tapp forced the screen to change; `frames` are the positions ffprobe reports.
 * The opening frame sits at 0 and the next one is the mark, so the first frame was that many
 * seconds before the mark. Returns null when there is no second frame to read — a take where
 * nothing ever changed — rather than guessing.
 */
export function firstFrameAtMs(frames, markAtMs) {
  const changes = frames.filter((position) => position > 0.001);
  if (!changes.length || !Number.isFinite(markAtMs)) return null;
  // The mark is two changes a known moment apart, and `markAtMs` is the second. Either both wrote
  // a frame or only the second did, so the mark is the last frame of the opening cluster.
  const cluster = changes.filter((position) => position <= changes[0] + MARK_CLUSTER_S);
  return Math.round(markAtMs - cluster[cluster.length - 1] * 1000);
}

/**
 * Hold the last screen for `holdMs` by extending the finished file, and give it a steady frame
 * rate while doing so.
 *
 * Keeping the recorder running longer does NOT do this: the recorder writes a frame when the
 * screen changes, so a still final screen produces nothing and the file still ends at the last
 * change. Measured on a take that ran four seconds past its last change: duration 7.500 s, last
 * frame 7.497 s. The tail has to be added to the file afterwards.
 *
 * Cloning the last frame is also what makes the result ordinary to edit: what simctl writes is
 * variable-rate — five frames over eight seconds on a still screen — which editors scrub badly.
 *
 * It is also what makes the step map land inside the file at all. A flow whose last step sat on a
 * motionless screen left the recording ending eleven seconds before the flow did, so the sidecar
 * correctly placed that step past the end of the video. `tailMsFor` works out what is missing.
 */
export function tailMsFor({ durationMs, lastStepEndMs, holdMs = 0 }) {
  const missing = Number.isFinite(lastStepEndMs) ? Math.max(0, Math.round(lastStepEndMs - durationMs)) : 0;
  return missing + Math.max(0, Math.round(holdMs));
}

export function padTail(file, addMs, { run = sh } = {}) {
  if (!(addMs > 0)) return { ok: true, padded: false, durationMs: videoDurationMs(file, { run }), error: "" };
  const target = path.resolve(file);
  const before = videoDurationMs(target, { run });
  if (before === null) return { ok: false, padded: false, durationMs: null, error: `cannot hold the last screen of ${target}: its duration is unreadable` };
  const totalSeconds = (before + addMs) / 1000;
  const temp = `${target}.padded.mp4`;
  const result = run("ffmpeg", [
    "-y", "-v", "error", "-i", target,
    // stop_duration is generous and `-t` makes the cut: asking tpad alone for the exact amount
    // came out short on a variable-rate input (22.97s where 28.6s was asked for), because what
    // ffmpeg takes the input's duration to be is not what the container reports.
    // `fps=30` BEFORE tpad, and never `-r 30`. As an output option `-r` renumbers the frames it is
    // given at a fixed rate, which on a variable-rate input throws the real timing away: a 36.9s
    // capture of 534 frames came out as 17.8s of picture, and every step in the map then pointed
    // at the wrong screen. The `fps` filter resamples against the timestamps instead, so a still
    // stretch is filled with repeats and the clock survives.
    "-vf", `fps=30,tpad=stop_mode=clone:stop_duration=${(addMs / 1000 + 5).toFixed(3)}`,
    "-t", totalSeconds.toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", temp,
  ], 300_000);
  if (result.status !== 0 || !fs.existsSync(temp)) {
    try { fs.unlinkSync(temp); } catch { /* nothing to clean up */ }
    return { ok: false, padded: false, durationMs: before, error: `could not hold the last screen: ${String(result.stderr || "").trim().split("\n")[0] || "ffmpeg failed"}` };
  }
  fs.renameSync(temp, target);
  // Report what the file actually came out as, never what was asked for.
  return { ok: true, padded: true, durationMs: videoDurationMs(target, { run }), error: "" };
}

/**
 * Put the simulator and the host recorder into a state a recording can start from.
 *
 * Returns what it had to repair, so the run can say so in one line — silently fixing something
 * that cost three re-records is how it stays invisible the next time.
 */
export function prepareRecorder(udid, { run = sh } = {}) {
  const repaired = [];

  // A device that shut itself down since the last run: the recorder attaches and produces a file
  // no player will open. This was one of the 11/7 re-records.
  const list = run("xcrun", ["simctl", "list", "devices", "-j"]);
  let booted = false;
  try {
    const devices = JSON.parse(list.stdout || "{}").devices || {};
    booted = Object.values(devices).flat().some((d) => d.udid === udid && d.state === "Booted");
  } catch { /* fall through to the boot attempt */ }
  if (!booted) {
    const boot = run("xcrun", ["simctl", "boot", udid], 120_000);
    const already = /current state: Booted/i.test(`${boot.stdout}${boot.stderr}`);
    if (boot.status !== 0 && !already) {
      return { ok: false, repaired, error: `the simulator ${udid} is not booted and would not boot: ${String(boot.stderr || "").trim().split("\n")[0]}` };
    }
    if (!already) repaired.push("booted the simulator, which had shut itself down");
    run("xcrun", ["simctl", "bootstatus", udid], 180_000);
  }

  // "Host recording is already in progress": a recorder from a killed run still holds the device.
  const probe = run("xcrun", ["simctl", "io", udid, "recordVideo", "--help"]);
  if (/already in progress/i.test(`${probe.stdout}${probe.stderr}`)) {
    run("pkill", ["-INT", "-f", `simctl io ${udid} recordVideo`]);
    repaired.push("stopped a recorder left running by an earlier run");
  }
  return { ok: true, repaired, error: "" };
}

/**
 * Start recording the simulator's screen. The returned handle stops it and says when its first
 * frame was captured, on the caller's clock.
 *
 * The mark is placed on a still screen before the flow starts, which is why `startRecording` is
 * called before the app is driven and not after.
 */
export function startRecording({ udid, out, holdMs = 0, now = () => Date.now(), spawnFn = spawn, run = sh }) {
  const file = path.resolve(out);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // --force: the caller named this path, and refusing to overwrite leaves a half-finished take
  // where the one just recorded should be.
  const child = spawnFn("xcrun", ["simctl", "io", udid, "recordVideo", "--codec", "h264", "--force", file], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const exited = new Promise((resolve) => child.once("exit", () => resolve()));

  // Remembered before the mark touches it, restored after the take.
  const previousTime = statusBarTime(udid, { run });

  // The mark: status-bar changes at a known instant, on a still screen, so the first change in
  // the finished file is this and nothing else.
  const marked = new Promise((resolve) => setTimeout(() => {
    run("xcrun", ["simctl", "status_bar", udid, "override", "--time", MARK_TIMES[0]]);
    setTimeout(() => {
      run("xcrun", ["simctl", "status_bar", udid, "override", "--time", MARK_TIMES[1]]);
      resolve(now());
    }, MARK_GAP_MS);
  }, MARK_AFTER_MS));

  return {
    file,
    /** Wait until the recording has been marked; the flow must not start before that. */
    ready: () => marked,
    async stop() {
      const markAtMs = await marked;
      child.kill("SIGINT");
      // Put the clock back the way it was: the mark is tapp's doing, not the simulator's state.
      // Restored rather than cleared, because clearing wipes a 9:41 somebody set for screenshots.
      // Done after the recorder stops, so it is not in the picture.
      restoreStatusBar(udid, previousTime, { run });
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, FINALISE_TIMEOUT_MS))]);
      const durationMs = videoDurationMs(file, { run });
      if (durationMs === null) {
        return {
          file, ok: false, durationMs: null, startedAtMs: null, frames: 0,
          error: `the recording at ${file} has no readable duration — it was cut off before it could be finished${stderr.trim() ? `: ${stderr.trim().split("\n")[0]}` : ""}`,
        };
      }
      const frames = framePositions(file, { run });
      const startedAtMs = firstFrameAtMs(frames, markAtMs);
      if (startedAtMs === null) {
        return {
          file, ok: false, durationMs, startedAtMs: null, frames: frames.length,
          error: "the recording never changed after it started, so there is no mark to time it against — the screen may have been frozen",
        };
      }
      // Padding is the caller's to do: how much tail is missing depends on when the flow's last
      // step ended, which only the caller knows. See `padTail`.
      return { file, ok: true, durationMs, startedAtMs, frames: frames.length, error: "" };
    },
  };
}

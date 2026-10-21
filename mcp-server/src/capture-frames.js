// Reading a finished run back: the states it observed, and the frame of the recording that
// shows each one.
//
// The engine already knows every state transition — it emits them as OCQA_STATE while the run
// happens. So this does not analyse the video to work out what changed; it reads the index the
// run wrote and seeks. A state's frame costs one seek, not a scan of several hundred frames.
//
// Everything here is read-only and works on a capture directory alone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const VIDEO_NAMES = ["exploration.webm", "replay.webm", "exploration.mp4", "replay.mp4", "exploration.mov"];

export function captureRoot() {
  return path.join(process.env.TAPP_HOME || path.join(os.homedir(), ".tapp"), "captures");
}

// A capture is addressable by id, by path, or by "latest".
export function resolveCapture(target = "") {
  const value = String(target || "").trim();
  const root = captureRoot();
  if (!value || value === "latest") {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return null; }
    const newest = entries
      .map((e) => ({ dir: path.join(root, e.name), at: fs.statSync(path.join(root, e.name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0];
    return newest ? newest.dir : null;
  }
  const direct = path.resolve(value);
  if (fs.existsSync(path.join(direct, "ocqa-markers.txt"))) return direct;
  const byId = path.join(root, value);
  if (fs.existsSync(path.join(byId, "ocqa-markers.txt"))) return byId;
  return null;
}

function readMarkers(dir) {
  let text = "";
  try { text = fs.readFileSync(path.join(dir, "ocqa-markers.txt"), "utf8"); } catch { return []; }
  const markers = [];
  for (const line of text.split("\n")) {
    const match = /^OCQA_([A-Z_]+):(.*)$/.exec(line.trim());
    if (!match) continue;
    try { markers.push({ kind: match[1], payload: JSON.parse(match[2]) }); } catch { /* a truncated final line */ }
  }
  return markers;
}

export function findRecording(dir) {
  for (const name of VIDEO_NAMES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// The screenshot a run already wrote for a state, when it named one. Older captures name it in
// the STATE marker; the rest are matched positionally by the state_N_ prefix the engine uses.
function screenshotFor(dir, state, index) {
  if (state.screenshot && fs.existsSync(path.join(dir, state.screenshot))) return state.screenshot;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const prefix = `state_${index + 1}_`;
  return names.find((name) => name.startsWith(prefix)) || null;
}

/**
 * What a finished run can show: one entry per observed state, with the time it was reached and
 * the evidence that exists for it. `t` is milliseconds on the run's own clock; `videoAtMs` is
 * the same instant expressed against the recording, when the run recorded one.
 */
export function captureIndex(dir) {
  const markers = readMarkers(dir);
  const context = markers.find((m) => m.kind === "CONTEXT")?.payload || {};
  const recording = markers.find((m) => m.kind === "RECORDING")?.payload || null;
  const video = findRecording(dir);
  const issues = markers.filter((m) => m.kind === "ISSUE").map((m) => m.payload);
  const actions = markers.filter((m) => m.kind === "ACTION").map((m) => m.payload);

  const states = markers.filter((m) => m.kind === "STATE").map((m, index) => {
    const state = m.payload;
    const t = Number.isFinite(state.t) ? state.t : null;
    return {
      index: index + 1,
      screen: state.screen || `state ${index + 1}`,
      url: state.url || "",
      t,
      // A recording starts a moment after the run's clock does; subtract that offset so the
      // seek lands on the frame that actually shows this state.
      videoAtMs: t != null && recording ? Math.max(0, t - (recording.startsAtMs || 0)) : null,
      screenshot: screenshotFor(dir, state, index),
      elements: state.elements ?? null,
      role: state.role || "",
      controls: Array.isArray(state.controls) ? state.controls : [],
      inputs: Array.isArray(state.inputs) ? state.inputs : [],
      findings: issues.filter((issue) => issue.screen === state.screen).map((issue) => ({
        type: issue.type, severity: issue.severity, title: issue.title,
        t: Number.isFinite(issue.t) ? issue.t : null,
      })),
    };
  });

  return {
    capture: path.basename(dir),
    dir,
    context,
    recording: video ? { file: path.basename(video), path: video, startsAtMs: recording?.startsAtMs ?? null, indexed: !!recording } : null,
    states,
    actions: actions.length,
    findings: issues.length,
  };
}

export function selectState(index, at) {
  const value = String(at ?? "").trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return index.states.find((s) => s.index === Number(value)) || null;
  const needle = value.toLowerCase();
  return index.states.find((s) => s.screen.toLowerCase() === needle)
    || index.states.find((s) => s.screen.toLowerCase().includes(needle))
    || null;
}

async function ffmpeg(args) {
  try {
    await run("ffmpeg", args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") throw Object.assign(new Error("ffmpeg is required to read frames out of a recording"), { code: "NO_FFMPEG" });
    throw error;
  }
}

// One frame, by seeking to a known instant. Falls back to the state's screenshot when the run
// has no recording, because the answer to "what did this screen look like" is the same.
export async function extractFrame(index, state, outFile) {
  if (state?.videoAtMs != null && index.recording) {
    await ffmpeg(["-y", "-loglevel", "error", "-ss", (state.videoAtMs / 1000).toFixed(3), "-i", index.recording.path, "-frames:v", "1", outFile]);
    if (fs.existsSync(outFile)) return { file: outFile, from: "recording", atMs: state.videoAtMs };
  }
  if (state?.screenshot) {
    const source = path.join(index.dir, state.screenshot);
    if (fs.existsSync(source)) { fs.copyFileSync(source, outFile); return { file: outFile, from: "screenshot", atMs: state.t }; }
  }
  return null;
}

/**
 * Contact sheets: many frames in one image, so a run can be scanned at a glance instead of one
 * costly frame at a time. Sampled across the recording when there is one; otherwise the
 * screenshots the run already wrote are tiled.
 */
export async function contactSheets(index, outDir, { columns = 5, rows = 5, fps = 2, width = 320 } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const pattern = path.join(outDir, "frames_%02d.png");
  if (index.recording) {
    await ffmpeg(["-y", "-loglevel", "error", "-i", index.recording.path,
      "-vf", `fps=${fps},scale=${width}:-1,tile=${columns}x${rows}`, pattern]);
  } else {
    const shots = index.states.map((s) => s.screenshot).filter(Boolean);
    if (!shots.length) return [];
    const list = path.join(outDir, "shots.txt");
    fs.writeFileSync(list, shots.map((name) => `file '${path.join(index.dir, name).replace(/'/g, "'\\''")}'`).join("\n"));
    await ffmpeg(["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
      "-vf", `scale=${width}:-1,tile=${columns}x${rows}`, pattern]);
    fs.rmSync(list, { force: true });
  }
  return fs.readdirSync(outDir).filter((n) => /^frames_\d+\.png$/.test(n)).sort().map((n) => path.join(outDir, n));
}

// A recording Playwright wrote as VP9 webm cannot be opened by QuickTime or Preview. Write an
// H.264 sibling so the evidence is playable without anyone converting it first.
export async function writePlayableCopy(videoPath) {
  const target = videoPath.replace(/\.webm$/i, ".mp4");
  if (!/\.webm$/i.test(videoPath) || fs.existsSync(target)) return fs.existsSync(target) ? target : null;
  try {
    await ffmpeg(["-y", "-loglevel", "error", "-i", videoPath, "-c:v", "libx264", "-preset", "veryfast",
      "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", target]);
    return fs.existsSync(target) ? target : null;
  } catch (error) {
    if (error?.code === "NO_FFMPEG") return null;
    throw error;
  }
}

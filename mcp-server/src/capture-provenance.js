// Which project a capture belongs to.
//
// Every capture lands in the shared ~/.tapp/captures/, so an agent working in project A can
// see project B's history and, without anything telling it otherwise, present it as evidence
// (public issue #29: a Copilot session borrowed an unrelated capture as a "fixture"). Each
// capture now records who made it and from where, every result that hands back a capture path
// hands back this record with it, and listings default to the current project.
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const VERSION = (() => { try { return require("../../package.json").version; } catch { return "0.0.0"; } })();

export const PROVENANCE_FILE = "provenance.json";

function realpath(dir) {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

// The git remote is the most stable project identity there is: it survives clones in different
// directories and is what a human means by "the project". Absent → the directory alone.
function gitRemote(dir) {
  try {
    return execFileSync("git", ["-C", dir, "config", "--get", "remote.origin.url"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 }).trim() || null;
  } catch {
    return null;
  }
}

export function describeProject(projectDir = process.cwd()) {
  const dir = realpath(projectDir);
  return { dir, name: path.basename(dir), remote: gitRemote(dir) };
}

// kind: explore | audit | flow | scenario | session. target: bundle id / app id / url / flow file.
export function writeCaptureProvenance(captureDir, { kind, platform, target = "", projectDir = process.cwd(), extra = {} } = {}) {
  const record = {
    schemaVersion: 1,
    kind: String(kind || "capture"),
    platform: String(platform || ""),
    target: String(target || ""),
    project: describeProject(projectDir),
    tool: { name: "tapp", version: VERSION },
    createdAt: new Date().toISOString(),
    ...extra,
  };
  fs.mkdirSync(captureDir, { recursive: true });
  fs.writeFileSync(path.join(captureDir, PROVENANCE_FILE), JSON.stringify(record, null, 2));
  return record;
}

export function readCaptureProvenance(captureDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(captureDir, PROVENANCE_FILE), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// Same remote, or same real directory. A capture with no record predates provenance and cannot
// be claimed by any project — callers show those separately rather than guessing.
export function captureBelongsToProject(provenance, projectDir = process.cwd()) {
  if (!provenance?.project) return false;
  const here = describeProject(projectDir);
  if (provenance.project.remote && here.remote) return provenance.project.remote === here.remote;
  return provenance.project.dir === here.dir;
}

// One line an agent can echo when it cites a capture, so the reader sees whose evidence it is.
export function provenanceLabel(provenance) {
  if (!provenance) return "provenance unknown (capture predates tapp 0.17.25)";
  const who = provenance.project?.remote || provenance.project?.dir || "unknown project";
  return `${provenance.kind || "capture"} · ${provenance.platform || "?"} · ${provenance.target || "(no target)"} · from ${who}`;
}

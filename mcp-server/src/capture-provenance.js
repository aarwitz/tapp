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

// Which tapp actually produced this run (TM-670).
//
// The version string alone cannot answer that. package.json reads 0.35.5 both in the published
// package and in this repository for the whole time 0.35.5 is being developed, so evidence from an
// unreleased working tree — eleven commits past the release when this was written — claimed a
// released version and no checker could tell. Contract v6 asks each job to carry "exact tapp
// version plus verified package integrity"; a number everyone shares is neither.
//
// An installed package has no `.git`; a source checkout does. That is the whole discriminator.
// Resolved once per process, like VERSION: a run must never pay for this twice, and must never
// fail because of it.
const BUILD = (() => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  const git = (args) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000,
  }).trim();
  try {
    if (!fs.existsSync(path.join(root, ".git"))) return { build: "package" };
    return { build: "source", commit: git(["rev-parse", "--short", "HEAD"]), dirty: git(["status", "--porcelain"]).length > 0 };
  } catch {
    // A checkout we cannot interrogate is still not a published package, and saying so is more
    // honest than implying one.
    return { build: "source" };
  }
})();

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
    tool: { name: "tapp", version: VERSION, ...BUILD },
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

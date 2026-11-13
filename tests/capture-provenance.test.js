import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeCaptureProvenance, readCaptureProvenance, captureBelongsToProject, provenanceLabel, describeProject, PROVENANCE_FILE } from "../mcp-server/src/capture-provenance.js";

function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `tapp-prov-${name}-`)); }
function gitRepo(remote) {
  const dir = tmp("repo");
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", remote]);
  return dir;
}

test("a capture records which project made it, from where, with what", () => {
  const project = gitRepo("git@github.com:acme/app.git");
  const capture = path.join(tmp("cap"), "web-20261009-120000");
  const written = writeCaptureProvenance(capture, { kind: "explore", platform: "web", target: "https://staging.acme.test", projectDir: project });
  assert.ok(fs.existsSync(path.join(capture, PROVENANCE_FILE)), "the capture directory is created if needed");
  const read = readCaptureProvenance(capture);
  assert.equal(read.schemaVersion, 1);
  assert.equal(read.kind, "explore");
  assert.equal(read.platform, "web");
  assert.equal(read.target, "https://staging.acme.test");
  assert.equal(read.project.remote, "git@github.com:acme/app.git");
  assert.equal(read.project.name, path.basename(fs.realpathSync(project)));
  assert.match(read.tool.version, /^\d+\.\d+\.\d+/);
  assert.equal(written.createdAt, read.createdAt);
});

test("ownership: same remote in a different clone is the same project; a different remote is not", () => {
  const cloneA = gitRepo("https://github.com/acme/app.git");
  const cloneB = gitRepo("https://github.com/acme/app.git");
  const other = gitRepo("https://github.com/acme/other.git");
  const capture = path.join(tmp("cap"), "ios-1");
  writeCaptureProvenance(capture, { kind: "explore", platform: "ios", target: "com.acme.app", projectDir: cloneA });
  const prov = readCaptureProvenance(capture);
  assert.equal(captureBelongsToProject(prov, cloneA), true);
  assert.equal(captureBelongsToProject(prov, cloneB), true, "clones of the same repository share captures");
  assert.equal(captureBelongsToProject(prov, other), false);
});

test("without a git remote the real directory is the identity", () => {
  const plain = tmp("plain");
  const capture = path.join(tmp("cap"), "flow-1");
  writeCaptureProvenance(capture, { kind: "flow", platform: "web", projectDir: plain });
  assert.equal(captureBelongsToProject(readCaptureProvenance(capture), plain), true);
  assert.equal(captureBelongsToProject(readCaptureProvenance(capture), tmp("elsewhere")), false);
  assert.equal(describeProject(plain).remote, null);
});

test("a capture that predates provenance belongs to nobody and says so", () => {
  const capture = tmp("old");
  assert.equal(readCaptureProvenance(capture), null);
  assert.equal(captureBelongsToProject(null, process.cwd()), false);
  assert.match(provenanceLabel(null), /predates/);
  assert.match(provenanceLabel({ kind: "audit", platform: "web", target: "https://x.test", project: { remote: "git@github.com:a/b.git" } }), /audit · web · https:\/\/x\.test · from git@github\.com:a\/b\.git/);
});

// TM-670: the version string alone cannot say which tapp produced a run. package.json reads the
// same number in the published package and in this repository for the whole time that version is
// being developed, so evidence from an unreleased working tree claimed a released version and no
// checker could tell them apart — which is what stops a project refusing a wrong engine.
test("a run's record says which build of tapp produced it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-prov-build-"));
  writeCaptureProvenance(dir, { kind: "explore", platform: "web", target: "x", projectDir: process.cwd() });
  const record = JSON.parse(fs.readFileSync(path.join(dir, "provenance.json"), "utf8"));

  assert.ok(record.tool.version, "the version is still recorded");
  assert.ok(["source", "package"].includes(record.tool.build),
    `the record must say which build produced the run, got ${JSON.stringify(record.tool)}`);

  // The discriminator is whether the package root is a checkout, so assert whichever side this
  // run is actually on. This suite runs in both: from the repository, and again from the staged
  // public tree the publication guard builds, which has no .git and is therefore a package.
  // Hardcoding "source" passed here and failed there — exactly the confusion the field exists
  // to remove.
  const root = new URL("../", import.meta.url).pathname;
  const isCheckout = fs.existsSync(path.join(root, ".git"));
  assert.equal(record.tool.build, isCheckout ? "source" : "package",
    `a run from ${isCheckout ? "a checkout" : "an installed package"} must say so`);
  if (isCheckout) {
    assert.match(String(record.tool.commit || ""), /^[0-9a-f]{7,40}$/,
      "a source build records the commit, so evidence can be traced to exact code");
    assert.equal(typeof record.tool.dirty, "boolean",
      "a source build says whether there were uncommitted changes");
  } else {
    assert.equal(record.tool.commit, undefined, "a package build has no commit to record");
  }
});

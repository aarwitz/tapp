import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { composeFeedback, feedbackIssueUrl, redactText, latestCaptureId, FEEDBACK_REPO } from "../mcp-server/src/feedback.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tappBin = path.join(root, "bin", "tapp.js");

test("feedback redacts home paths and token-shaped secrets", () => {
  const out = redactText("crashed at /Users/someone/app/x.swift with key sk-ant-abcdefghijklmnop and ghp_" + "a".repeat(36), "/Users/someone");
  assert.doesNotMatch(out, /\/Users\/someone/);
  assert.doesNotMatch(out, /sk-ant-|ghp_a/);
  assert.match(out, /~\/app\/x\.swift/);
});

test("feedback composes a public-safe issue with automatic context and labels", () => {
  const issue = composeFeedback({
    title: "explore stalls on the Account tab",
    body: "Ran tapp explore ./MyApp; it stopped after 3 actions.",
    type: "bug", version: "0.0.0-test", node: "v22.0.0", platform: "darwin arm64",
    doctor: { platforms: { ios: { available: true, xcode: "Xcode 26.4", bootedSimulator: "iPhone 17 Pro" }, android: { adb: true, devicesConnected: 0 }, web: { available: true } } },
    captureId: "ios-20260912-095129",
  });
  assert.equal(issue.title, "explore stalls on the Account tab");
  assert.match(issue.body, /stopped after 3 actions/);
  assert.match(issue.body, /tapp 0\.0\.0-test · node v22\.0\.0 · darwin arm64/);
  assert.match(issue.body, /iOS ✅ \(Xcode 26\.4, iPhone 17 Pro booted\) · Android ✅ · web ✅/);
  assert.match(issue.body, /capture: `ios-20260912-095129` \(kept locally/);
  assert.match(issue.body, /This issue is public/);
  assert.deepEqual(issue.labels, ["feedback", "bug", "agent-filed"]);
  const url = feedbackIssueUrl(issue);
  assert.ok(url.startsWith(`https://github.com/${FEEDBACK_REPO}/issues/new?`));
  assert.match(decodeURIComponent(url), /labels=feedback,bug,agent-filed/);
});

test("feedback rejects an unknown type and an empty title", () => {
  assert.throws(() => composeFeedback({ title: "x", type: "rant" }), /type must be one of/);
  assert.throws(() => composeFeedback({ title: "   " }), /needs a short title/);
});

test("latestCaptureId picks the newest capture directory and tolerates a missing home", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-fb-home-"));
  assert.equal(latestCaptureId(home), null);
  const caps = path.join(home, "captures");
  fs.mkdirSync(path.join(caps, "ios-older"), { recursive: true });
  fs.mkdirSync(path.join(caps, "web-newer"), { recursive: true });
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(caps, "ios-older"), past, past);
  assert.equal(latestCaptureId(home), "web-newer");
});

test("tapp feedback drafts by default, never submits, and emits machine-readable JSON", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-fb-cli-"));
  const out = execFileSync("node", [tappBin, "feedback", "doctor misreports android", "--body", "seen at /Users/tester/proj", "--type", "idea", "--json"], {
    cwd: root, encoding: "utf8", env: { ...process.env, TAPP_HOME: home },
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.submitted, false);
  assert.equal(parsed.title, "doctor misreports android");
  assert.doesNotMatch(parsed.body, /\/Users\/tester/);
  assert.deepEqual(parsed.labels, ["feedback", "idea", "agent-filed"]);
  assert.ok(parsed.url.startsWith("https://github.com/aarwitz/tapp/issues/new?"));
});

test("tapp feedback exits 2 on usage errors", () => {
  const noTitle = spawnSync("node", [tappBin, "feedback"], { cwd: root, encoding: "utf8" });
  assert.equal(noTitle.status, 2);
  const badType = spawnSync("node", [tappBin, "feedback", "t", "--type", "rant"], { cwd: root, encoding: "utf8" });
  assert.equal(badType.status, 2);
});

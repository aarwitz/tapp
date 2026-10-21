import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { captureIndex, resolveCapture, selectState, findRecording } from "../mcp-server/src/capture-frames.js";

// A capture directory shaped the way a run writes one: markers plus the screenshots they name.
function plantCapture({ withRecording = true, withTimestamps = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-frames-home-"));
  const dir = path.join(home, "captures", "web-20261021-fixture");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    `OCQA_CONTEXT:${JSON.stringify({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })}`,
    ...(withRecording ? [`OCQA_RECORDING:${JSON.stringify({ file: "exploration.webm", startsAtMs: 500, fps: 25 })}`] : []),
    `OCQA_ACTION:${JSON.stringify({ t: 900, type: "open", target: "/", narrative: "Opened /" })}`,
    `OCQA_STATE:${JSON.stringify({ ...(withTimestamps ? { t: 1500 } : {}), screen: "Home", url: "/", elements: 12, role: "page", controls: [], inputs: [] })}`,
    `OCQA_ISSUE:${JSON.stringify({ ...(withTimestamps ? { t: 1600 } : {}), type: "dead_control", severity: "medium", title: "Button does nothing", screen: "Home" })}`,
    `OCQA_STATE:${JSON.stringify({ ...(withTimestamps ? { t: 4200 } : {}), screen: "Checkout", url: "/checkout", elements: 20, role: "form", controls: [], inputs: [] })}`,
  ];
  fs.writeFileSync(path.join(dir, "ocqa-markers.txt"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "state_1_home.png"), "not-a-real-png");
  fs.writeFileSync(path.join(dir, "state_2_checkout.png"), "not-a-real-png");
  if (withRecording) fs.writeFileSync(path.join(dir, "exploration.webm"), "not-a-real-video");
  return { home, dir };
}

test("a capture reads back as the screens it observed, with each one's place in the recording", () => {
  const { dir } = plantCapture();
  const index = captureIndex(dir);

  assert.equal(index.states.length, 2);
  assert.equal(index.actions, 1);
  assert.equal(index.findings, 1);

  const [home, checkout] = index.states;
  assert.equal(home.screen, "Home");
  assert.equal(home.screenshot, "state_1_home.png");
  assert.equal(checkout.screen, "Checkout");
  assert.equal(checkout.screenshot, "state_2_checkout.png");

  // The recording starts after the run's clock does, so a state's video time is its marker time
  // minus that offset. Getting this wrong seeks to the wrong frame.
  assert.equal(home.t, 1500);
  assert.equal(home.videoAtMs, 1000, "1500ms into the run, 500ms into the recording");
  assert.equal(checkout.videoAtMs, 3700);

  // A finding is attached to the screen it was observed on, so "show me where this happened"
  // is a lookup rather than a search.
  assert.equal(home.findings.length, 1);
  assert.equal(home.findings[0].title, "Button does nothing");
  assert.equal(checkout.findings.length, 0);
});

test("a capture recorded before frame indexing still reads, without inventing timestamps", () => {
  const { dir } = plantCapture({ withTimestamps: false });
  const index = captureIndex(dir);
  assert.equal(index.states.length, 2);
  for (const state of index.states) {
    assert.equal(state.t, null);
    assert.equal(state.videoAtMs, null, "no timestamp must not become a guessed seek");
    assert.ok(state.screenshot, "the screenshot the run wrote is still the answer");
  }
});

test("a run with no recording still reports its screens", () => {
  const { dir } = plantCapture({ withRecording: false });
  const index = captureIndex(dir);
  assert.equal(index.recording, null);
  assert.equal(findRecording(dir), null);
  assert.equal(index.states.length, 2);
  assert.equal(index.states[0].videoAtMs, null);
});

test("a capture is addressable by id, by path, and as latest", () => {
  const { home, dir } = plantCapture();
  const previous = process.env.TAPP_HOME;
  process.env.TAPP_HOME = home;
  try {
    assert.equal(resolveCapture(dir), dir, "by path");
    assert.equal(resolveCapture("web-20261021-fixture"), dir, "by id");
    assert.equal(resolveCapture("latest"), dir, "by latest");
    assert.equal(resolveCapture(""), dir, "empty means latest");
    assert.equal(resolveCapture("no-such-capture"), null);
  } finally {
    if (previous === undefined) delete process.env.TAPP_HOME; else process.env.TAPP_HOME = previous;
  }
});

test("a screen is selectable by index or by name", () => {
  const { dir } = plantCapture();
  const index = captureIndex(dir);
  assert.equal(selectState(index, "2").screen, "Checkout");
  assert.equal(selectState(index, "Checkout").screen, "Checkout");
  assert.equal(selectState(index, "check").screen, "Checkout", "a partial name is enough");
  assert.equal(selectState(index, "nothing here"), null);
});

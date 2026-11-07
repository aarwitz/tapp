import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { flowVariables, substituteFlowValue } from "../mcp-server/src/flow-runtime.js";

const repoRoot = new URL("..", import.meta.url);
const read = (relative) => fs.readFileSync(new URL(relative, repoRoot), "utf8");

function withEnv(values, run) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) { saved[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return run(); } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test("`--var` beats the Flow's own defaults, and the rest of them survive", () => {
  withEnv({ TAPP_FLOW_VARS: JSON.stringify({ COACH_NAME: "Casey" }) }, () => {
    const vars = flowVariables({ vars: { COACH_NAME: "Victor", CITY: "Austin" } });
    assert.equal(vars.COACH_NAME, "Casey", "the command line wins");
    assert.equal(vars.CITY, "Austin", "and does not wipe the others");
    assert.equal(substituteFlowValue("Book $COACH_NAME in $CITY", vars), "Book Casey in Austin");
  });
});

test("an explicit override still beats the command line, and malformed input is ignored", () => {
  withEnv({ TAPP_FLOW_VARS: JSON.stringify({ A: "from-cli" }) }, () => {
    assert.equal(flowVariables({}, { A: "explicit" }).A, "explicit");
  });
  withEnv({ TAPP_FLOW_VARS: "{not json" }, () => {
    // A broken value must not take the whole run down before step one.
    assert.equal(flowVariables({ vars: { A: "kept" } }).A, "kept");
  });
  withEnv({ TAPP_FLOW_VARS: undefined }, () => {
    assert.equal(flowVariables({ vars: { A: "kept" } }).A, "kept");
  });
});

test("every platform runner can see `--var`, not only the web one", () => {
  // The flag was accepted everywhere and read by the web runner alone, so the same Flow
  // substituted on web and silently did not on iOS, Android or macOS — no error, just an
  // unresolved placeholder handed to the driver. Reported from the field (issue #35).
  //
  // Android and macOS go through flowVariables, covered above. iOS substitutes inside the
  // XCUITest harness, which has always read OCQA_FLOW_VARS; nothing ever set it.
  const harness = read("Harness/OCQAHarnessUITests/ExplorerTests.swift");
  assert.match(harness, /OCQA_FLOW_VARS/, "the harness reads the variables it is given");
  const runner = read("scripts/run-flow.sh");
  assert.match(runner, /TAPP_FLOW_VARS/, "and the iOS runner must actually give them to it");
  assert.match(runner, /OCQA_FLOW_VARS/);
  for (const relative of ["mcp-server/src/web-flow.js", "mcp-server/src/android-flow.js", "mcp-server/src/macos-flow.js"]) {
    assert.match(read(relative), /flowVariables\(/, `${relative} resolves variables through the shared helper`);
  }
});

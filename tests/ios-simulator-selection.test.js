import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectSimulator } from "../mcp-server/src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const A = { name: "iPhone 16", udid: "AAAA-1111", state: "Booted", booted: true };
const B = { name: "iPhone 16 Pro", udid: "BBBB-2222", state: "Booted", booted: true };
const C = { name: "iPad Air", udid: "CCCC-3333", state: "Shutdown", booted: false };
const sims = (...booted) => ({ simulators: [A, B, C], booted });

// Public issue #31: with two simulators booted, every iOS path drove whichever simctl listed
// first — a production build instead of the sandbox one, then another session's simulator.
test("one booted simulator and no choice: that one", () => {
  assert.equal(selectSimulator(sims(A)).booted, A);
});

test("several booted and no choice: refuse with the list, never guess", () => {
  const r = selectSimulator(sims(A, B));
  assert.match(r.error, /simulator-selection-required: 2 simulators are booted — iPhone 16 \(AAAA-1111\), iPhone 16 Pro \(BBBB-2222\)/);
  assert.match(r.error, /TAPP_UDID/);
  assert.equal(r.ambiguous.length, 2);
});

test("a device chooses by UDID, by exact name (case-insensitive), or by a unique booted-name prefix", () => {
  assert.equal(selectSimulator(sims(A, B), "bbbb-2222").booted, B);
  assert.equal(selectSimulator(sims(A, B), "iphone 16 pro").booted, B);
  assert.equal(selectSimulator(sims(A, B), "iPhone 16 P").booted, B, "unique prefix");
  assert.match(selectSimulator(sims(A, B), "iPhone 1").error, /No simulator matches "iPhone 1"/, "an ambiguous prefix is not a match");
  assert.match(selectSimulator(sims(A, B), "Pixel").error, /Booted: iPhone 16 \(AAAA-1111\), iPhone 16 Pro/);
});

test("a chosen simulator that exists but is shut down is reported as such, not swapped for another", () => {
  const r = selectSimulator(sims(A, B), "iPad Air");
  assert.equal(r.notBooted, C);
  assert.equal(r.booted, undefined);
});

test("TAPP_UDID is the environment default for the choice", () => {
  const before = process.env.TAPP_UDID;
  process.env.TAPP_UDID = "AAAA-1111";
  try { assert.equal(selectSimulator(sims(A, B)).booted, A); }
  finally { if (before === undefined) delete process.env.TAPP_UDID; else process.env.TAPP_UDID = before; }
});

test("both harness scripts honour TAPP_UDID instead of taking the first booted simulator", () => {
  const quick = fs.readFileSync(path.join(root, "scripts", "quick-capture.sh"), "utf8");
  const flow = fs.readFileSync(path.join(root, "scripts", "run-flow.sh"), "utf8");
  assert.match(quick, /if \[\[ -n "\$\{TAPP_UDID:-\}" \]\]; then echo "\$TAPP_UDID"; return; fi/);
  assert.match(flow, /UDID="\$\{TAPP_UDID:-\}"/);
});

test("the engine never addresses a simulator through the `booted` alias once one is chosen", () => {
  const engine = fs.readFileSync(path.join(root, "mcp-server", "src", "index.js"), "utf8");
  for (const op of ["get_app_container", "listapps", "terminate", "uninstall", "install", "io"]) {
    assert.doesNotMatch(engine, new RegExp(`"simctl", "${op}", "booted"`), `${op} must use simTarget()`);
  }
});

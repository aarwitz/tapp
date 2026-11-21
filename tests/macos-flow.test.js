import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMacosFlow } from "../mcp-server/src/macos-flow.js";

class FakeMacosDriver {
  launch() { this.launched = true; }
  settle() { return { screen: "Main" }; }
}

// open_url has no system-level link handoff to replay on a desktop app — it is refused with a
// clear reason rather than silently doing nothing or being reported as an unknown action.
test("open_url is refused on macOS with a clear reason, not treated as an unknown action", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-macos-open-url-"));
  const logPath = path.join(dir, "flow.log");
  const result = await runMacosFlow({
    flow: { name: "macOS link", app: "/Applications/Calculator.app", steps: [{ open_url: "myapp://claim?t=abc" }] },
    logPath,
    driver: new FakeMacosDriver(),
  });
  assert.equal(result.passed, false);
  const raw = fs.readFileSync(logPath, "utf8");
  assert.match(raw, /not supported on macOS/);
  assert.doesNotMatch(raw, /unknown action/);
});

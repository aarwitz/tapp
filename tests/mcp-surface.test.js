import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOOLS, LEGACY_TOOLS, dispatchTool } from "../mcp-server/src/index.js";

// ADR-0007: the local MCP server advertises exactly thirteen tools, and every pre-0.18 name
// still answers with a pointer to its replacement.
const PUBLIC = ["tapp_explore", "tapp_look", "tapp_run", "tapp_validate", "tapp_init", "tapp_plan", "tapp_map", "tapp_ci", "tapp_report", "tapp_session", "tapp_build", "tapp_doctor", "tapp_feedback"];

test("ListTools advertises exactly the thirteen ADR-0007 tools", () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), PUBLIC);
  for (const tool of TOOLS) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.inputSchema.type, "object");
  }
  assert.ok(!PUBLIC.some((name) => name in LEGACY_TOOLS), "no public tool is also a legacy alias");
  for (const [name, legacy] of Object.entries(LEGACY_TOOLS)) {
    assert.ok(PUBLIC.includes(legacy.tool), `${name} points at an unknown tool ${legacy.tool}`);
  }
});

test("every legacy tool name still answers and names its replacement", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-surface-"));
  // Arguments chosen so each handler returns quickly (usage errors or cheap reads), never a build or a simulator.
  const fastArgs = {
    tapp_build: { projectDir: empty, install: false },
    tapp_capture: {},
    tapp_parse_markers: { runId: "nope" },
    tapp_capture_summary: { runId: "nope" },
    tapp_flow_generate: {},
    tapp_flow_save: {},
    tapp_install_app: {},
    tapp_boot_simulator: {},
    tapp_session_act: {},
    tapp_task: { taskPath: "nope.yml" },
    tapp_release_contract: { contractPath: "nope.contract.ts" },
    tapp_pr_plan: {},
    tapp_release_plan: { planPath: "nope.json" },
    tapp_ui_map: { mapPath: "nope.json" },
    tapp_ci_setup: { projectDir: empty },
    tapp_scenario_run: {},
    tapp_flow_run: {},
    tapp_focus: {},
    tapp_audit: {},
    tapp_run_qa: {},
    tapp_screenshot: { maxWidth: 200 },
    tapp_ui_tree: {},
    tapp_open_app: {},
  };
  for (const [name, legacy] of Object.entries(LEGACY_TOOLS)) {
    if (["tapp_health", "tapp_list_simulators", "tapp_screenshot", "tapp_ui_tree"].includes(name)) continue; // touch simctl; covered by protocol tests
    const result = await dispatchTool(name, fastArgs[name] || {});
    assert.ok(result && Array.isArray(result.content), `${name} returned no result`);
    assert.match(result.structuredContent.deprecated, new RegExp(`^${name} is deprecated; use ${legacy.tool}`));
    assert.match(result.content[0].text, /is deprecated; use tapp_/);
  }
});

test("public tools route by discriminator to the right engine handler", async () => {
  const run = await dispatchTool("tapp_run", {});
  assert.match(run.content[0].text, /tapp_run needs one of/);
  const validate = await dispatchTool("tapp_validate", {});
  assert.match(validate.content[0].text, /tapp_validate needs one of/);
  const audit = await dispatchTool("tapp_explore", { readOnly: true });
  assert.match(audit.content[0].text, /url/i);
  const explore = await dispatchTool("tapp_explore", {});
  assert.match(explore.content[0].text, /exactly one of appBundleId/);
  const pr = await dispatchTool("tapp_plan", { action: "pr" });
  assert.match(pr.content[0].text, /changedFiles/i);
  const session = await dispatchTool("tapp_session", { action: "tap", id: "x" });
  assert.match(session.content[0].text, /No active session/);
  const unknown = await dispatchTool("tapp_nope", {});
  assert.equal(unknown.isError, true);
  for (const result of [run, validate, audit, explore, pr, session]) assert.equal(result.structuredContent?.deprecated, undefined, "public tools carry no deprecation note");
});

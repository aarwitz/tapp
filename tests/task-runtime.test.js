import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadFlowFile, normalizeFlowStep } from "../mcp-server/src/flow-runtime.js";
import { applyTaskCoverage, loadTaskFile, validateTaskAgainstUiMap, validateTaskDefinition } from "../mcp-server/src/task-runtime.js";

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-tasks-"));
  fs.mkdirSync(path.join(root, ".autotap", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".autotap", "flows"), { recursive: true });
  return root;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

test("Flow task calls compile inputs, conditions, outputs, and provenance deterministically", () => {
  const root = repository();
  writeJson(path.join(root, ".autotap", "tasks", "sign-in.json"), {
    kind: "task", version: 1, name: "signIn",
    inputs: { email: { required: true, secret: true }, password: { required: true, secret: true } },
    outputs: { authenticatedEmail: { fromInput: "email" } },
    preconditions: [{ screen: "Sign in" }], postconditions: [{ screen: "Home" }],
    implementations: { web: { steps: [
      { type: { field: "Email", value: "{{email}}" } },
      { type: { field: "Password", value: "{{password}}" } },
      { tap: "Sign in" },
      { wait_for: "Home" },
    ] } },
    coverage: { nodes: ["sign-in", "home"], edges: ["edge_signin"] },
  });
  const flowPath = writeJson(path.join(root, ".autotap", "flows", "smoke.json"), {
    name: "Task-composed smoke", platform: "web", vars: {}, steps: [{
      task: "signIn", with: { email: "$TEST_EMAIL", password: "$TEST_PASSWORD" },
      save: { authenticatedEmail: "SIGNED_IN_EMAIL" },
    }],
  });
  const flow = loadFlowFile(flowPath);
  assert.equal(flow.steps.length, 6);
  assert.equal(normalizeFlowStep(flow.steps[0]).action, "assert_screen");
  assert.equal(normalizeFlowStep(flow.steps[1]).value, "$TEST_EMAIL");
  assert.equal(normalizeFlowStep(flow.steps.at(-1)).target, "Home");
  assert.equal(normalizeFlowStep(flow.steps[2]).task, "signIn");
  assert.equal(flow.vars.SIGNED_IN_EMAIL, "$TEST_EMAIL");
  assert.equal(flow.taskPlan[0].inputs.email, "<secret>");
  assert.deepEqual(flow.taskPlan[0].coverage.edges, ["edge_signin"]);
});

test("Tasks compose other tasks and reject cycles", () => {
  const root = repository();
  writeJson(path.join(root, ".autotap", "tasks", "open-home.json"), {
    kind: "task", version: 1, name: "openHome", steps: [{ tap: "Home" }, { wait_for: "Home" }],
  });
  writeJson(path.join(root, ".autotap", "tasks", "navigate.json"), {
    kind: "task", version: 1, name: "navigateHome", steps: [{ task: "openHome" }, { assert_exists: "Dashboard" }],
  });
  const flowPath = writeJson(path.join(root, ".autotap", "flows", "nested.json"), {
    name: "Nested", platform: "ios", steps: [{ task: "navigateHome" }],
  });
  const compiled = loadFlowFile(flowPath);
  assert.equal(compiled.steps.length, 3);
  assert.equal(compiled.steps[0].__tappTask.name, "openHome");
  assert.deepEqual(compiled.steps[0].__tappTask.parents, ["navigateHome"]);

  writeJson(path.join(root, ".autotap", "tasks", "open-home.json"), {
    kind: "task", version: 1, name: "openHome", steps: [{ task: "navigateHome" }],
  });
  assert.throws(() => loadFlowFile(flowPath), /Task cycle detected/);
});

test("Task validation forbids fixed waits and AI assertions in keyless replay", () => {
  assert.deepEqual(validateTaskDefinition({ kind: "task", version: 1, name: "stableTask", steps: [{ wait: 1000 }, { assert_ai: "looks right" }] }), [
    "implementation 1 step 1 uses a fixed wait; use wait_for",
    "implementation 1 step 2 uses assert_ai; tasks must replay deterministically",
  ]);
});

test("Task validation requires reviewable named-symbol ownership", () => {
  assert.deepEqual(validateTaskDefinition({
    kind: "task", version: 1, name: "stableTask", steps: [{ tap: "Continue" }],
    coverage: { sourceSymbols: [{ path: "src/app.ts", symbols: ["validSymbol", "not a symbol"] }] },
  }), ["coverage.sourceSymbols[0].symbols must contain named code symbols"]);
});

test("Task compilation refuses plaintext secret inputs", () => {
  const root = repository();
  writeJson(path.join(root, ".autotap", "tasks", "secret.json"), {
    kind: "task", version: 1, name: "useSecret",
    inputs: { password: { required: true, secret: true } },
    steps: [{ type: { field: "Password", value: "{{password}}" } }],
  });
  const flowPath = writeJson(path.join(root, ".autotap", "flows", "secret.json"), {
    name: "Secret", platform: "web", steps: [{ task: "useSecret", with: { password: "do-not-write-me" } }],
  });
  assert.throws(() => loadFlowFile(flowPath), /must reference an environment variable/);
});

test("Task grounding checks cited UI Map nodes, edges, and observed controls", () => {
  const root = repository();
  const taskPath = writeJson(path.join(root, ".autotap", "tasks", "open-feed.json"), {
    kind: "task", version: 1, name: "openFeed", steps: [{ tap: "Feed" }, { wait_for: "Feed" }],
    coverage: { nodes: ["home"], edges: ["edge_home_feed"] },
  });
  const task = loadTaskFile(taskPath);
  const map = {
    schemaVersion: 1,
    nodes: [{ id: "screen_home", semanticKey: "home", name: "Home", controls: [{ semanticKey: "feed", label: "Feed", selectors: [{ kind: "label", value: "Feed" }] }] }],
    edges: [{ id: "edge_home_feed" }],
  };
  assert.deepEqual(validateTaskAgainstUiMap(task, map, "ios"), { errors: [], warnings: [] });
  map.coverage = { tasks: [], contracts: [], uncoveredNodeIds: ["screen_home"], uncoveredEdgeIds: ["edge_home_feed"] };
  map.nodes[0].coveredBy = { tasks: [], contracts: [] };
  map.edges[0].coveredBy = { tasks: [], contracts: [] };
  const covered = applyTaskCoverage(map, task);
  assert.deepEqual(covered.coverage.tasks, ["openFeed"]);
  assert.deepEqual(covered.coverage.uncoveredNodeIds, []);
  assert.deepEqual(covered.coverage.uncoveredEdgeIds, []);
  const bad = validateTaskAgainstUiMap({ ...task, coverage: { nodes: ["missing"], edges: ["missing"] } }, map, "ios");
  assert.equal(bad.errors.length, 2);
});

test("Task grounding accepts a stable same-title state variant identity", () => {
  const task = {
    kind: "task", version: 1, name: "completeTodoItem", steps: [{ tap: "Mark Complete" }],
    coverage: { nodes: ["todo-list--task-notes-field"] },
  };
  const map = {
    schemaVersion: 1,
    nodes: [{ id: "screen_detail", semanticKey: "todo-list--task-notes-field", name: "Todo List", controls: [] }],
    edges: [],
  };
  assert.deepEqual(validateTaskAgainstUiMap(task, map, "ios").errors, []);
});

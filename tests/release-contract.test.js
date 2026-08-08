import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyReleaseContractCoverage,
  compileReleaseContract,
  loadReleaseContractFile,
  validateReleaseContract,
  validateReleaseContractAgainstUiMap,
} from "../mcp-server/src/release-contract.js";
import { loadScenarioFile } from "../mcp-server/src/scenario-runtime.js";

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-contract-"));
  fs.mkdirSync(path.join(root, ".autotap", "contracts"), { recursive: true });
  fs.mkdirSync(path.join(root, ".autotap", "tasks"), { recursive: true });
  return root;
}

function write(file, value) {
  fs.writeFileSync(file, value);
  return file;
}

test("TypeScript release contracts compile Tasks and exact expectations to a deterministic Scenario", async () => {
  const root = repo();
  write(path.join(root, ".autotap", "tasks", "sign-in.json"), JSON.stringify({
    kind: "task", version: 1, name: "signIn",
    inputs: { email: { secret: true }, password: { secret: true } },
    steps: [{ type: { field: "Email", value: "{{email}}" } }, { type: { field: "Password", value: "{{password}}" } }, { tap: "Sign in" }],
  }));
  const contractPath = write(path.join(root, ".autotap", "contracts", "social.contract.ts"), `
    import { defineContract, type ReleaseContract } from "runtapp/contracts";
    const contract = defineContract({
      name: "socialSystem",
      title: "Alice publishes and Bob observes",
      businessValue: "Cross-account content propagation still works.",
      criticality: "critical",
      platforms: ["web"],
      url: "http://127.0.0.1:4180",
      actors: {
        alice: { session: "isolated", credentials: { email: "$ALICE_EMAIL", password: "$ALICE_PASSWORD" } },
        bob: { session: "isolated", credentials: { email: "$BOB_EMAIL", password: "$BOB_PASSWORD" } },
      },
      variables: { POST: "Contract post" },
      steps: [
        { actor: "alice", task: "signIn", with: { email: "$EMAIL", password: "$PASSWORD" } },
        { actor: "bob", task: "signIn", with: { email: "$EMAIL", password: "$PASSWORD" } },
        { actor: "bob", expect: { exists: "$POST", eventually: { timeoutMs: 9000, pollMs: 250 } } },
      ],
      coverage: { nodes: ["feed"], edges: ["edge_feed"] },
    } satisfies ReleaseContract);
    export default contract;
  `);
  const contract = await loadReleaseContractFile(contractPath);
  const compiled = compileReleaseContract(contract, { platform: "web" });
  assert.equal(compiled.kind, "scenario");
  assert.equal(compiled.releaseContract.criticality, "critical");
  assert.equal(compiled.steps.length, 7);
  assert.equal(compiled.steps[0].actor, "alice");
  assert.equal(compiled.steps[0].do.__tappTask.name, "signIn");
  assert.equal(compiled.steps.at(-1).do.action, "assert_exists");
  assert.equal(compiled.steps.at(-1).do.timeoutMs, 9000);
  assert.equal(compiled.actors.bob.vars.EMAIL, "$BOB_EMAIL");
  assert.equal(compiled.actors.bob.credentials, undefined);
});

test("legacy tapp-mcp contract imports remain loadable after the runtapp rename", async () => {
  const root = repo();
  write(path.join(root, ".autotap", "tasks", "open-home.json"), JSON.stringify({
    kind: "task", version: 1, name: "openHome", steps: [{ tap: "Home" }],
  }));
  const contractPath = write(path.join(root, ".autotap", "contracts", "legacy.contract.ts"), `
    import { defineContract } from "tapp-mcp/contracts";
    export default defineContract({
      name: "legacyImportWorks",
      title: "Legacy import works",
      businessValue: "Existing repositories keep compiling after the package rename.",
      criticality: "high",
      platforms: ["web"],
      actors: { customer: {} },
      steps: [{ actor: "customer", task: "openHome" }],
    });
  `);
  const contract = await loadReleaseContractFile(contractPath);
  assert.equal(contract.name, "legacyImportWorks");
});

test("release contracts reject raw driver actions and ambiguous expectations", () => {
  const base = {
    kind: "release-contract", version: 1, name: "checkoutWorks", title: "Checkout works",
    businessValue: "Revenue path remains open.", criticality: "critical", platforms: ["web"],
    actors: { customer: {} }, steps: [{ actor: "customer", tap: "Buy" }],
  };
  assert.match(validateReleaseContract(base).join("; "), /must call a Task/);
  assert.match(validateReleaseContract({ ...base, steps: [{ actor: "customer", expect: { exists: "A", absent: "B" } }] }).join("; "), /exactly one/);
});

test("single-actor web contracts preserve deterministic request lifecycle", () => {
  const root = repo();
  write(path.join(root, ".autotap", "tasks", "open-home.json"), JSON.stringify({
    kind: "task", version: 1, name: "openHome", steps: [{ tap: "Home" }],
  }));
  const contract = {
    kind: "release-contract", version: 1, name: "homeIsReset", title: "Home starts clean",
    businessValue: "A customer starts from controlled state.", criticality: "high", platforms: ["web"],
    actors: { customer: { session: "shared" } },
    setup: [{ request: { method: "POST", path: "/__tapp/reset", status: 200 } }],
    steps: [{ actor: "customer", task: "openHome" }],
    teardown: [{ request: { method: "POST", path: "/__tapp/reset", status: 200 } }],
  };
  const compiled = compileReleaseContract(contract, { platform: "web", sourcePath: path.join(root, ".autotap", "contracts", "home.contract.ts") });
  assert.equal(compiled.kind, "flow");
  assert.equal(compiled.setup.length, 1);
  assert.equal(compiled.teardown.length, 1);
  assert.throws(() => compileReleaseContract({ ...contract, platforms: ["ios"] }, { platform: "ios", sourcePath: path.join(root, ".autotap", "contracts", "home.contract.ts") }), /target-native reset/);
});

test("release contract grounding and explicit map coverage preserve uncovered behavior", () => {
  const contract = {
    kind: "release-contract", version: 1, name: "feedWorks", title: "Feed works",
    businessValue: "Customers can consume content.", criticality: "high", platforms: ["web"],
    actors: { customer: {} }, steps: [{ actor: "customer", task: "openFeed" }],
    coverage: { nodes: ["feed"], edges: ["edge_feed"] },
  };
  const map = {
    schemaVersion: 1,
    coverage: { tasks: [], contracts: [], uncoveredNodeIds: ["screen_feed", "screen_other"], uncoveredEdgeIds: ["edge_feed"] },
    nodes: [
      { id: "screen_feed", semanticKey: "feed", name: "Feed", coveredBy: { tasks: [], contracts: [] } },
      { id: "screen_other", semanticKey: "other", name: "Other", coveredBy: { tasks: [], contracts: [] } },
    ],
    edges: [{ id: "edge_feed", coveredBy: { tasks: [], contracts: [] } }],
  };
  assert.deepEqual(validateReleaseContractAgainstUiMap(contract, map), { errors: [], warnings: [] });
  const covered = applyReleaseContractCoverage(map, contract);
  assert.deepEqual(covered.coverage.contracts, ["feedWorks"]);
  assert.deepEqual(covered.coverage.uncoveredNodeIds, ["screen_other"]);
  assert.deepEqual(covered.coverage.uncoveredEdgeIds, []);
});

test("compiled release-contract identity survives the shared JSON loader", () => {
  const root = repo();
  const compiledPath = write(path.join(root, ".autotap", "contracts", "compiled.json"), JSON.stringify({
    name: "System works", kind: "scenario", platform: "web",
    actors: { alice: {}, bob: {} }, steps: [{ actor: "alice", tap: "Go" }],
    releaseContract: { name: "systemWorks", criticality: "critical" },
  }));
  assert.equal(loadScenarioFile(compiledPath).releaseContract.name, "systemWorks");
});

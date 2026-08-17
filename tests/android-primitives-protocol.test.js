import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const cliSource = fs.readFileSync("bin/tapp.js", "utf8");
const engineSource = fs.readFileSync("mcp-server/src/index.js", "utf8");

test("Android open leaves the launched app foreground for follow-up eyes-and-hands commands", () => {
  const cliOpen = cliSource.match(/case "open":[\s\S]*?case "tree":/)?.[0] || "";
  const mcpOpen = engineSource.match(/if \(name === "tapp_open_app"\)[\s\S]*?if \(name === "tapp_list_simulators"\)/)?.[0] || "";
  assert.match(cliOpen, /const snap = await driver\.launch/);
  assert.doesNotMatch(cliOpen, /driver\.forceStop/);
  assert.match(mcpOpen, /const snap = await driver\.launch/);
  assert.doesNotMatch(mcpOpen, /driver\.forceStop/);
});

test("Android tree launches an explicit target and can also inspect the current foreground screen", () => {
  const tree = cliSource.match(/case "tree":[\s\S]*?case "shot":/)?.[0] || "";
  assert.match(tree, /const hasTarget =/);
  assert.match(tree, /target\.appId \? await driver\.launch\(\) : await driver\.snapshot\(\)/);
  assert.match(tree, /platform: "android"/);
  assert.match(tree, /activity: snap\.activity/);
});

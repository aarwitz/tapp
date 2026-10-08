import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const json = (relative) => JSON.parse(read(relative));

const pkg = json("package.json");
const plugin = json(".claude-plugin/plugin.json");
const marketplace = json(".claude-plugin/marketplace.json");
const extension = json("vscode-extension/package.json");
const server = json("server.json");
const skill = read("skills/tapp/SKILL.md");

test("the canonical Tapp skill is concise, discoverable, and honest", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter, "skill has YAML frontmatter");
  const keys = frontmatter[1]
    .split("\n")
    .filter((line) => /^[a-z][a-z0-9_-]*:/.test(line))
    .map((line) => line.split(":", 1)[0]);
  assert.deepEqual(keys, ["name", "description"]);
  assert.match(frontmatter[1], /^name: tapp$/m);
  for (const trigger of ["iOS", "Android", "web", "find bugs", "screenshot", "Tapp"]) {
    assert.match(frontmatter[1], new RegExp(trigger, "i"), `description names ${trigger}`);
  }
  assert.doesNotMatch(skill, /\bTODO\b|SHIP-READY|ship\/no-ship/i);
  assert.match(skill, /Never guess among multiple targets/);
  assert.match(skill, /exploration never decides this/i);
  assert.match(skill, /fresh repository needs one grounding exploration/i);
  assert.match(skill, /MCP session start → focus or act → end/);
  assert.match(skill, /npx -y @aarwitz\/tapp@latest doctor/);
  // 120 lines: the decision table and the navigation rules are the skill; raised from 100 on
  // 2026-10-08 when the audit-vs-explore routing left no room for the next rule.
  assert.ok(skill.split("\n").length < 120, "SKILL.md stays compact enough for agent context");
  assert.match(read("skills/tapp/references/commands.md"), /npx -y @aarwitz\/tapp@latest init \. --explore/);
  for (const relative of ["skills/tapp/SKILL.md", "skills/tapp/references/commands.md", "README.md", "AGENTS.md"]) {
    assert.doesNotMatch(read(relative), /npx -y @aarwitz\/tapp(?!@)/, `${relative} does not let npx reuse a stale global Tapp`);
  }
  assert.doesNotMatch(read("README.md"), /"@aarwitz\/tapp",\s*"mcp"/, "copyable MCP config uses the explicit latest tag");
  assert.match(read("README.md"), /"@aarwitz\/tapp@latest",\s*"mcp"/);
  for (const relative of [
    "bin/tapp.js",
    "mcp-server/src/application-model.js",
    "mcp-server/src/ci-report.js",
    "mcp-server/src/ci-setup.js",
    "mcp-server/src/index.js",
    "mcp-server/src/pr-selection.js",
    "mcp-server/src/product-operations.js",
  ]) {
    assert.doesNotMatch(
      read(relative),
      /(?:Run|run|rerun|Rerun|Next:|next:)\s+`?tapp\s/,
      `${relative} does not give a fresh user an unusable global-only follow-up command`,
    );
  }
});

test("npm and the Claude plugin ship the same current skill and MCP server", () => {
  assert.ok(pkg.files.includes("skills/"));
  assert.ok(pkg.files.includes(".claude-plugin/"));
  assert.equal(plugin.version, pkg.version);
  assert.equal(server.version, pkg.version);
  assert.ok(server.description.length <= 100, "MCP Registry description respects its public limit");
  assert.doesNotMatch(server.description, /ship\/no-ship|SHIP-READY/i);
  assert.equal(server.packages[0].identifier, "@aarwitz/tapp");
  assert.equal(server.packages[0].version, pkg.version);
  assert.deepEqual(plugin.mcpServers.tapp, {
    command: "npx",
    args: ["-y", `@aarwitz/tapp@${pkg.version}`, "mcp"],
    cwd: "${CLAUDE_PROJECT_DIR}",
  });
  assert.match(marketplace.description, /official Tapp plugin/i);
  assert.deepEqual(marketplace.plugins[0].source, {
    source: "npm",
    package: "@aarwitz/tapp",
  });
});

test("VS Code contributes the Tapp skill and the current observation contract", () => {
  assert.deepEqual(extension.contributes.chatSkills, [{ path: "./skills/tapp/SKILL.md" }]);
  const names = extension.contributes.languageModelTools.map((tool) => tool.name);
  assert.ok(names.includes("tapp_explore_ios"));
  assert.ok(names.includes("tapp_ios_focus"));
  assert.ok(!names.includes("tapp_run_ios_qa"));
  const explorer = extension.contributes.languageModelTools.find((tool) => tool.name === "tapp_explore_ios");
  assert.match(explorer.modelDescription, /observation/);
  assert.match(explorer.modelDescription, /no score or ship verdict/);
  assert.doesNotMatch(JSON.stringify(extension), /ship\/no-ship|SHIP-READY/i);

  const bridge = read("vscode-extension/bridge.js");
  assert.match(bridge, new RegExp(`@aarwitz/tapp@${pkg.version.replaceAll(".", "\\.")}`));
  assert.match(bridge, /this\.call\("tapp_explore"/);
  assert.match(bridge, /this\.call\("tapp_focus"/);
  assert.doesNotMatch(bridge, /tapp_run_qa/);
});

const hasPrivatePublicationTool = fs.existsSync(new URL("../tools/sync-public.sh", import.meta.url));

test("the public staging surface includes every agent exposure", { skip: !hasPrivatePublicationTool }, () => {
  const sync = read("tools/sync-public.sh");
  for (const path of [".claude-plugin", "skills", "vscode-extension", "server.json"]) {
    assert.match(sync, new RegExp(`^  ${path.replaceAll(".", "\\.")}$`, "m"), `${path} is allowlisted`);
  }
  for (const packaged of [
    "package/skills/tapp/SKILL.md",
    "package/skills/tapp/references/commands.md",
    "package/.claude-plugin/plugin.json",
  ]) {
    assert.match(sync, new RegExp(packaged.replaceAll(".", "\\.")), `${packaged} is guarded`);
  }
});

// The publish workflow ships in the public mirror, where it runs. `next` is the prerelease
// channel the 0.17.0 RC campaign used: candidates on `next` while `latest` held the last stable.
// An unconditional `npm publish` would make the first RC `latest` for every user, and leaves
// `next` pointing at a superseded stable after a normal release — which is what happened between
// 0.17.18 and 0.17.21 and was corrected by hand twice.
test("publishing routes prereleases to next and never leaves next behind latest", () => {
  const workflow = read(".github/workflows/publish-npm.yml");

  // The publish must carry an explicit channel rather than defaulting everything to latest.
  assert.match(workflow, /npm publish[^\n]*--tag "\$\{\{ steps\.release\.outputs\.channel \}\}"/,
    "npm publish targets the computed dist-tag");
  assert.doesNotMatch(workflow, /^\s*-\s*run:\s*npm publish --provenance --access public\s*$/m,
    "no unconditional publish that would make a prerelease the latest release");

  // A hyphen is what makes a semver version a prerelease.
  assert.match(workflow, /if \[\[ "\$version" == \*-\* \]\]/, "prereleases are detected by semver");
  assert.match(workflow, /channel=next/, "a prerelease publishes to next");
  assert.match(workflow, /channel=latest/, "a stable release publishes to latest");

  // After a stable release something must advance `next`, or it silently serves an older version.
  assert.match(workflow, /npm dist-tag add "@aarwitz\/tapp@\$version" next/,
    "a stable release moves next forward");
  assert.match(workflow, /continue-on-error: true/,
    "a dist-tag failure must not turn an already-published release red");
});

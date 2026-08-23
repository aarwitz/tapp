import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const json = (relative) => JSON.parse(read(relative));
const landingRoot = fs.existsSync(new URL("../landing/index.html", import.meta.url)) ? "landing" : "docs";
const readLanding = (relative) => read(`${landingRoot}/${relative}`);
const hasPrivatePublicationTool = fs.existsSync(new URL("../tools/sync-public.sh", import.meta.url));

const shortDescription =
  "Let coding agents verify UI changes on real iOS, Android, and web surfaces, then enforce reviewed proof in deterministic CI.";

test("public package surfaces describe one Tapp product", () => {
  const pkg = json("package.json");
  const readme = read("README.md");
  const landing = readLanding("index.html");

  assert.equal(pkg.description, shortDescription);
  assert.match(readme, /^# Tapp$/m);
  assert.match(readme, /Tapp lets coding agents verify UI changes on real iOS, Android, and web surfaces/);
  assert.match(readme, /Only the repository-connected gate[\s\S]*`pass`, `fail`, or `inconclusive`/);
  assert.match(landing, /Let your coding agent prove the UI it changed/);

  for (const relative of [
    "README.md",
    "package.json",
    "action.yml",
    "server.json",
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    "vscode-extension/package.json",
    "vscode-extension/README.md",
    "mcp-server/README.md",
    "bin/tapp.js",
  ]) {
    const source = read(relative);
    assert.doesNotMatch(source, /ship with proof|Playwright for iOS|autonomous QA|Browser Product|One engine, every surface|live simulator panel/i, relative);
  }
  assert.doesNotMatch(
    landing,
    /ship with proof|Playwright for iOS|autonomous QA|Browser Product|One engine, every surface|live simulator panel/i,
    `${landingRoot}/index.html`,
  );
});

test("public onboarding leads with the skill and keeps one-line CLI fallback", () => {
  const readme = read("README.md");
  const landing = readLanding("index.html");
  const help = read("bin/tapp.js");

  for (const source of [readme, landing, help]) {
    assert.match(source, /npx -y skills add aarwitz\/tapp --skill tapp/);
  }
  for (const source of [readme, landing]) {
    assert.match(source, /npx -y @aarwitz\/tapp@latest init \. --explore/);
  }
  assert.doesNotMatch(landing, /npx -y @aarwitz\/tapp(?!@)/);
  assert.doesNotMatch(landing, /@aarwitz\/tapp app \.|#quickstart/);
  assert.match(readme, /Inspecting, focused evidence, autonomous exploration, deterministic replay, and gating[\s\S]*need no MCP server/);
  assert.match(readme, /interactively tap, type, and record an[\s\S]*multi-step journey[\s\S]*persistent session/);
  assert.match(readme, /only a route already observed in[\s\S]*\.tapp\/ui-map\.json[\s\S]*authorizes navigation/);
});

test("public Action examples use a release tag instead of a moving branch", () => {
  for (const relative of ["README.md", "docs/scenarios.md"]) {
    const source = read(relative);
    assert.doesNotMatch(source, /uses:\s*aarwitz\/tapp@main/, `${relative} does not recommend a moving Action branch`);
    assert.match(source, /uses:\s*aarwitz\/tapp@v\d+\.\d+\.\d+/, `${relative} recommends a release tag`);
    assert.match(source, /reviewed release commit SHA/, `${relative} names the stronger immutable option`);
  }
});

test("platform claims name the exact current target boundary", () => {
  const readme = read("README.md");
  const landing = readLanding("index.html");

  for (const source of [readme, landing]) {
    assert.match(source, /iOS/);
    assert.match(source, /Android/);
    assert.match(source, /Web \(beta\)/i);
    assert.match(source, /WinForms/);
    assert.match(source, /WPF/);
    assert.match(source, /not currently (?:Tapp )?(?:supported )?targets?/i);
  }
  assert.match(landing, /"operatingSystem": "macOS, Windows, Linux"/);
});

test("runtapp.com remains the canonical product website", () => {
  const landing = readLanding("index.html");
  assert.equal(readLanding("CNAME").trim(), "runtapp.com");
  assert.match(landing, /<link rel="canonical" href="https:\/\/runtapp\.com\/">/);
  assert.match(readLanding("robots.txt"), /https:\/\/runtapp\.com\/sitemap\.xml/);
  assert.match(readLanding("sitemap.xml"), /https:\/\/runtapp\.com\//);
});

test("the private publication guard verifies the current CLI identity", { skip: !hasPrivatePublicationTool }, () => {
  const guard = read("tools/sync-public.sh");
  assert.match(guard, /agent-driven app testing for iOS, Android, and web/);
  assert.match(guard, /git add -A --force/, "the exact staged allowlist wins over path-specific ignores");
  assert.doesNotMatch(guard, /ship with proof/i);
});

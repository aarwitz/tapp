import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const action = fs.readFileSync(new URL("../action.yml", import.meta.url), "utf8");

function shellBodies(yaml) {
  const lines = yaml.split("\n");
  const bodies = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(\s*)run:\s*\|\s*$/);
    if (!match) continue;
    const indent = match[1].length;
    const body = [];
    for (i += 1; i < lines.length; i += 1) {
      const lineIndent = (lines[i].match(/^(\s*)/) || ["", ""])[1].length;
      if (lines[i].trim() && lineIndent <= indent) {
        i -= 1;
        break;
      }
      body.push(lines[i]);
    }
    bodies.push(body.join("\n"));
  }
  return bodies;
}

test("composite Action does not interpolate inputs into shell source", () => {
  for (const body of shellBodies(action)) {
    assert.doesNotMatch(body, /\$\{\{\s*inputs\./);
  }
});

test("nested third-party Actions are pinned to full commit SHAs", () => {
  const nestedUses = [...action.matchAll(/^\s+uses:\s+([^#\s]+)(?:\s+#.*)?$/gm)].map((m) => m[1]);
  assert.ok(nestedUses.length >= 2);
  for (const use of nestedUses) {
    assert.match(use, /^[^@]+@[a-f0-9]{40}$/);
  }
});

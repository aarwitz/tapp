#!/usr/bin/env node
// Prepublish safety gate for the VS Code extension. The private source repo's public-staging guard
// owns the confidential client-name list; duplicating those names in a publicly shipped checker
// would itself leak bad breadcrumbs. This package-local gate catches credential-like literals and
// runs for both `vsce package` and `vsce publish`.
"use strict";
const fs = require("fs");
const path = require("path");

const PATTERNS = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][^"']{12,}["']/i;

// Scan authored source. `dist` is a generated bundle of the same source plus third-party
// dependencies; escaped display masks such as "•••" become long string literals there and are
// false positives. node_modules is third-party and .vsix is output.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);
const SKIP_EXT = new Set([".vsix", ".png", ".jpg", ".gif", ".ico"]);

const hits = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      continue;
    }
    const full = path.join(dir, entry.name);
    if (SKIP_EXT.has(path.extname(entry.name))) continue;
    if (entry.name === "check-clientsafe.js") continue; // the PATTERNS literal lives here
    let text;
    try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
    text.split("\n").forEach((line, i) => {
      const m = line.match(PATTERNS);
      if (m) hits.push(`${path.relative(process.cwd(), full)}:${i + 1}: ${m[0]}`);
    });
  }
}

walk(process.cwd());

if (hits.length) {
  console.error("\n❌ ABORT: client-sensitive string(s) found — refusing to package/publish:\n");
  hits.forEach((h) => console.error("   " + h));
  console.error("\nScrub these before publishing. (Gate: check-clientsafe.js)\n");
  process.exit(1);
}
console.log("✅ client-safe: no client strings in the extension package.");

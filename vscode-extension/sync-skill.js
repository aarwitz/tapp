#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const extensionRoot = __dirname;
const sourceRoot = path.resolve(extensionRoot, "..", "skills", "tapp");
const destinationRoot = path.join(extensionRoot, "skills", "tapp");

if (!fs.existsSync(path.join(sourceRoot, "SKILL.md"))) {
  console.error(`Missing canonical Tapp skill: ${sourceRoot}`);
  process.exit(1);
}

fs.rmSync(destinationRoot, { recursive: true, force: true });
fs.cpSync(sourceRoot, destinationRoot, { recursive: true });
console.log(`Synced Tapp skill → ${path.relative(extensionRoot, destinationRoot)}`);

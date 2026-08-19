import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const landingRoot = fs.existsSync(path.join(root, "landing"))
  ? path.join(root, "landing")
  : path.join(root, "docs");
const read = (file) => fs.readFileSync(path.join(landingRoot, file), "utf8");

test("landing page establishes runtapp.com and @aarwitz/tapp as canonical", () => {
  const index = read("index.html");

  assert.match(index, /<link rel="canonical" href="https:\/\/runtapp\.com\/">/);
  assert.match(index, /<meta property="og:url" content="https:\/\/runtapp\.com\/">/);
  assert.match(index, /https:\/\/www\.npmjs\.com\/package\/@aarwitz\/tapp/);
  assert.match(index, /"@type": "SoftwareApplication"/);
  assert.match(index, /"operatingSystem": "macOS, Linux"/);
  assert.doesNotMatch(index, /"operatingSystem"[^\n]*Windows/);
  assert.doesNotMatch(index, /tapp-mcp|npmjs\.com\/package\/runtapp|npx(?:\s+-y)?\s+runtapp|\bAutoTap\b/i);
});

test("landing discovery files point only at the canonical site", () => {
  const robots = read("robots.txt");
  const sitemap = read("sitemap.xml");

  assert.match(robots, /Sitemap: https:\/\/runtapp\.com\/sitemap\.xml/);
  assert.match(sitemap, /https:\/\/runtapp\.com\//);
  assert.doesNotMatch(`${robots}\n${sitemap}`, /tapp-mcp|package-migration|npmjs\.com\/package\/runtapp/i);
});

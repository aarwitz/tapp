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
  assert.match(index, /"operatingSystem": "macOS, Windows, Linux"/);
  assert.match(index, /iOS simulators/);
  assert.match(index, /Android emulators and devices/);
  assert.match(index, /Windows\s+desktop UI apps such as WinForms, WPF, and WinUI are not currently supported/);
  assert.match(index, /npx -y skills add aarwitz\/tapp --skill tapp/);
  assert.match(index, /npx -y @aarwitz\/tapp@latest init \. --explore/);
  assert.match(index, /Let your coding agent prove the UI it changed/);
  assert.match(index, /Real evidence/);
  assert.match(index, /See Tapp in 90 seconds/);
  assert.match(index, /assets\/tapp-product-film\.mp4/);
  assert.match(index, /assets\/tapp-product-film-poster\.jpg/);
  assert.match(index, /evidence\/webdemo\/report\.html/);
  assert.match(index, /founding-pilot\.yml/);
  assert.match(index, /og:image" content="https:\/\/runtapp\.com\/assets\/tapp-social\.png/);
  assert.doesNotMatch(index, /href="#"/);
  assert.doesNotMatch(index, /onclick=/);
  assert.doesNotMatch(index, /Browser Product|Release Studio|One engine, every surface|@aarwitz\/tapp app \.|#quickstart/i);
  assert.doesNotMatch(index, /tapp-mcp|npmjs\.com\/package\/runtapp|npx(?:\s+-y)?\s+runtapp|\bAutoTap\b/i);
});

test("landing proof assets and public pilot intake ship together", () => {
  for (const file of [
    "assets/tapp-mark.svg",
    "assets/tapp-icon.png",
    "assets/tapp-social.png",
    "assets/tapp-focus-ios.jpg",
    "assets/tapp-focus-proof.png",
    "assets/tapp-explore-ios.webm",
    "assets/tapp-explore-ios.mp4",
    "assets/tapp-product-film.mp4",
    "assets/tapp-product-film-poster.jpg",
    "assets/tapp-web-report.png",
    "evidence/webdemo/report.html",
  ]) {
    assert.ok(fs.existsSync(path.join(landingRoot, file)), `${file} exists`);
  }

  const report = read("evidence/webdemo/report.html");
  assert.match(report, /Real, sanitized demo evidence/);
  assert.match(report, /observation, not a release decision/);
  assert.doesNotMatch(report, /\/Users\/|aarwitz\/.tapp|127\.0\.0\.1/);
});

test("landing discovery files point only at the canonical site", () => {
  const robots = read("robots.txt");
  const sitemap = read("sitemap.xml");

  assert.match(robots, /Sitemap: https:\/\/runtapp\.com\/sitemap\.xml/);
  assert.match(sitemap, /https:\/\/runtapp\.com\//);
  assert.doesNotMatch(`${robots}\n${sitemap}`, /tapp-mcp|package-migration|npmjs\.com\/package\/runtapp/i);
});

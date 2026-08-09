import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const hasDesktopSources = fs.existsSync("AutoTap/Services/ExplorationService.swift");

test("desktop exploration accepts the harness's resolved transition evidence", { skip: !hasDesktopSources }, () => {
  const source = fs.readFileSync("AutoTap/Services/ExplorationService.swift", "utf8");
  const knownPrefixes = source.match(/let knownPrefixes = \[(.*?)\]/s)?.[1] || "";
  assert.match(knownPrefixes, /"OCQA_TRANSITION_RESOLVED:"/);
  assert.match(source, /if line\.hasPrefix\("OCQA_TRANSITION_RESOLVED:\{"\)/);
});

test("desktop Coverage consumes the shared application model, release plan, and repository UI Map", { skip: !hasDesktopSources }, () => {
  const models = fs.readFileSync("AutoTap/Models/AppMap.swift", "utf8");
  const state = fs.readFileSync("AutoTap/ViewModels/AppState.swift", "utf8");
  const view = fs.readFileSync("AutoTap/Views/Coverage/CoverageView.swift", "utf8");
  assert.match(models, /struct TappApplicationModelDocument: Codable/);
  assert.match(models, /struct TappReleasePlanDocument: Codable/);
  assert.match(state, /decodeIfPresent\("application-model\.json"/);
  assert.match(state, /decodeIfPresent\("release-plan\.json"/);
  assert.match(state, /decodeIfPresent\("ui-map\.json"/);
  assert.match(state, /repositoryUIMap\.merged\(with: observed\)/);
  assert.match(view, /"Flow Map", "Screens", "Release Plan", "Application"/);
  assert.match(models, /struct UIMapRoute: Codable, Hashable/);
  assert.match(models, /routes: node\.routes \?\? \[\]/);
  assert.match(models, /entryPlatforms: entries\.compactMap/);
  assert.match(models, /navigationRootPlatforms: navigationRoots\.compactMap/);
  assert.match(view, /Observed navigation references/);
  assert.match(view, /Launch entry/);
  assert.match(view, /Navigation root/);
});

test("desktop release-plan review preserves unknown engine fields and never edits contracts", { skip: !hasDesktopSources }, () => {
  const state = fs.readFileSync("AutoTap/ViewModels/AppState.swift", "utf8");
  assert.match(state, /JSONSerialization\.jsonObject/);
  assert.match(state, /items\[index\]\["decision"\] = decision/);
  assert.match(state, /output\.write\(to: url, options: \.atomic\)/);
  assert.match(state, /Committed contracts remain accepted/);
  assert.doesNotMatch(state, /func reviewReleasePlanItem[\s\S]*?\.tapp\/contracts/);
});

test("desktop binary retains a repeatable real-schema artifact audit", { skip: !hasDesktopSources }, () => {
  const source = fs.readFileSync("AutoTap/App/HeadlessVerify.swift", "utf8");
  assert.match(source, /--verify-artifacts/);
  assert.match(source, /Coverage structural-state labels do not match ui-map\.json/);
  assert.match(source, /TappApplicationModelDocument\.self/);
  assert.match(source, /TappReleasePlanDocument\.self/);
  assert.match(source, /UIMapDocument\.self/);
  assert.match(source, /Coverage launch-entry annotations do not match ui-map\.json/);
  assert.match(source, /Coverage navigation-root annotations do not match ui-map\.json/);
});

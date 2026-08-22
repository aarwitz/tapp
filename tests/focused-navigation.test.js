import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildUiMapFromMarkers } from "../mcp-server/src/ui-map.js";
import { findSourceUiMatches, locateFocusedTarget } from "../mcp-server/src/focused-navigation.js";

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-focus-"));
  fs.mkdirSync(path.join(root, "Sources"), { recursive:true });
  fs.writeFileSync(path.join(root, "Sources", "StorefrontSettingsView.swift"), `
import SwiftUI
struct StorefrontSettingsView: View {
  var body: some View { Button("Save storefront settings") { save() } }
}
`);
  fs.writeFileSync(path.join(root, "Sources", "SettingsView.swift"), `
struct SettingsView: View {
  var body: some View { NavigationLink("Storefront") { StorefrontSettingsView() } }
}
`);
  fs.writeFileSync(path.join(root, "Sources", "HomeView.swift"), `
struct HomeView: View {
  var body: some View { Tab("Settings") { SettingsView() } }
}
`);
  fs.mkdirSync(path.join(root, ".tapp"), { recursive:true });
  const markers = path.join(root, "markers.txt");
  fs.writeFileSync(markers, [
    'OCQA_STATE:{"screen":"Home","role":"screen","controls":[{"kind":"button","label":"Storefront","accessibilityId":"storefront_tab"}]}',
    'OCQA_ACTION:{"type":"tap","target":"storefront_tab","screen":"Home"}',
    'OCQA_TRANSITION:{"from":"Home","to":"Storefront Settings","action":"storefront_tab","changed":true}',
    'OCQA_STATE:{"screen":"Storefront Settings","role":"form","controls":[{"kind":"button","label":"Save storefront settings","accessibilityId":"save_storefront"}]}',
  ].join("\n") + "\n");
  const map = buildUiMapFromMarkers({ markersPath:markers, platform:"ios", target:"com.example.store", runId:"focus" });
  fs.writeFileSync(path.join(root, ".tapp", "ui-map.json"), JSON.stringify(map, null, 2));
  return root;
}

test("focused target location uses owned source and the observed UI Map route", () => {
  const root = repo();
  const result = locateFocusedTarget({
    projectDir:root,
    platform:"ios",
    query:"make sure the save storefront settings button is visible above the keyboard",
  });
  assert.equal(result.status, "route-ready");
  assert.equal(result.target.name, "Storefront Settings");
  assert.equal(result.navigation.provenance, "observed-ui-map");
  assert.deepEqual(result.navigation.steps.map((step) => step.action.target), ["storefront_tab"]);
  assert.equal(result.sourceMatches[0].path, "Sources/StorefrontSettingsView.swift");
  assert.equal(result.sourceMatches[0].symbol, "StorefrontSettingsView");
  assert.equal(result.sourceTrail.some((clue) => clue.path === "Sources/SettingsView.swift" && clue.references === "StorefrontSettingsView" && /NavigationLink/.test(clue.snippet)), true);
  assert.equal(result.sourceTrail.some((clue) => clue.path === "Sources/HomeView.swift" && clue.references === "SettingsView"), true);
});

test("focused source lookup is bounded and returns line-level evidence", () => {
  const root = repo();
  const matches = findSourceUiMatches({ projectDir:root, query:"Save storefront settings" });
  assert.ok(matches.length >= 1);
  assert.equal(matches[0].line, 4);
  assert.match(matches[0].snippet, /Save storefront settings/);
});

test("focused target refuses to invent a route when no observed UI Map exists", () => {
  const root = repo();
  fs.rmSync(path.join(root, ".tapp", "ui-map.json"));
  const result = locateFocusedTarget({ projectDir:root, platform:"ios", query:"Save storefront settings" });
  assert.equal(result.status, "source-located");
  assert.equal(result.navigation.status, "blocked");
  assert.match(result.navigation.reason, /will not invent a route/);
  assert.equal(result.sourceTrail.some((clue) => /NavigationLink/.test(clue.snippet)), true);
});

test("natural agent phrasing prefers a named destination over its same-label navigation control", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-focus-web-language-"));
  fs.writeFileSync(path.join(root, "index.html"), '<h1>Home</h1><a href="/login.html">Sign in</a>');
  fs.writeFileSync(path.join(root, "login.html"), '<h1>Sign in</h1><button>Sign in</button>');
  fs.mkdirSync(path.join(root, ".tapp"));
  const markers = path.join(root, "markers.txt");
  fs.writeFileSync(markers, [
    'OCQA_STATE:{"screen":"Home","url":"http://127.0.0.1/","controls":[{"kind":"link","label":"Sign in"}]}',
    'OCQA_ACTION:{"type":"tap","target":"Sign in","screen":"Home"}',
    'OCQA_TRANSITION:{"from":"Home","to":"Sign in","action":"Sign in","changed":true}',
    'OCQA_STATE:{"screen":"Sign in","url":"http://127.0.0.1/login.html","controls":[{"kind":"button","label":"Sign in"}]}',
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(root, ".tapp", "ui-map.json"), JSON.stringify(buildUiMapFromMarkers({
    markersPath:markers, platform:"web", target:"http://127.0.0.1", runId:"natural-focus",
  })));

  const result = locateFocusedTarget({
    projectDir:root, platform:"web",
    query:"go to the Sign in page and click the Sign in button exactly once",
  });
  assert.equal(result.status, "route-ready");
  assert.equal(result.target.name, "Sign in");
  assert.equal(result.navigation.mode, "direct-web-route");
  assert.equal(result.navigation.route, "/login.html");
  assert.ok(result.sourceMatches.some((match) => match.path === "login.html"));
});

test("an exact screen name outranks the parent screen's same-label navigation control", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-focus-native-screen-"));
  fs.writeFileSync(path.join(root, "SettingsView.swift"), 'NavigationLink("Update Profile") { UpdateProfileView() }\n');
  fs.writeFileSync(path.join(root, "UpdateProfileView.swift"), 'struct UpdateProfileView: View { var body: some View { Button("Save Changes") {} } }\n');
  fs.mkdirSync(path.join(root, ".tapp"));
  const markers = path.join(root, "markers.txt");
  fs.writeFileSync(markers, [
    'OCQA_STATE:{"screen":"Settings","controls":[{"kind":"button","label":"Update Profile"}]}',
    'OCQA_ACTION:{"type":"tap","target":"Update Profile","screen":"Settings"}',
    'OCQA_TRANSITION:{"from":"Settings","to":"Update Profile","action":"Update Profile","changed":true}',
    'OCQA_STATE:{"screen":"Update Profile","controls":[{"kind":"button","label":"Save Changes"}]}',
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(root, ".tapp", "ui-map.json"), JSON.stringify(buildUiMapFromMarkers({
    markersPath:markers, platform:"ios", target:"com.example.app", runId:"screen-focus",
  })));

  const result = locateFocusedTarget({ projectDir:root, platform:"ios", query:"Update Profile screen" });
  assert.equal(result.target.name, "Update Profile");
  assert.deepEqual(result.navigation.steps.map((step) => step.action.target), ["Update Profile"]);
});

test("screen names that are also ordinary prose words remain valid focused destinations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-focus-about-screen-"));
  fs.writeFileSync(path.join(root, "AboutActivity.java"), 'setContentView(R.layout.about); setTitle("About");\n');
  fs.mkdirSync(path.join(root, ".tapp"));
  const markers = path.join(root, "markers.txt");
  fs.writeFileSync(markers, [
    'OCQA_STATE:{"screen":"Settings","controls":[{"kind":"button","label":"About","accessibilityId":"about_button"}]}',
    'OCQA_ACTION:{"type":"tap","target":"about_button","screen":"Settings"}',
    'OCQA_TRANSITION:{"from":"Settings","to":"About","action":"about_button","changed":true}',
    'OCQA_STATE:{"screen":"About","controls":[{"kind":"button","label":"Done","accessibilityId":"done_button"}]}',
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(root, ".tapp", "ui-map.json"), JSON.stringify(buildUiMapFromMarkers({
    markersPath:markers, platform:"android", target:"io.example.app", runId:"about-focus",
  })));

  const result = locateFocusedTarget({ projectDir:root, platform:"android", query:"go to the About screen" });
  assert.equal(result.status, "route-ready");
  assert.equal(result.target.name, "About");
  assert.deepEqual(result.navigation.steps.map((step) => step.action.target), ["about_button"]);
});

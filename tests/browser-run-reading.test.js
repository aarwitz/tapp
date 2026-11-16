import test from "node:test";
import assert from "node:assert/strict";
import { coverageGraph, groupFindings, severityTally, transitionLabel } from "../browser/view-model.js";

// TM-794. The engine keeps every finding distinct by type|screen|target so a regression stays
// visible. Reading is the other job: these two functions arrange what the engine recorded and
// are the whole of what the Findings and Coverage views do beyond drawing.

// The shape a real web exploration produces: one site-wide contrast problem reported once per
// text node, which is why a run arrives as dozens of lines with the two real ones buried.
const webRun = [
  { type: "low_contrast", severity: "low", screen: "Home", target: "Services", title: 'Hard to read: "Services" is 3.8:1 against its background (needs 4.5:1 at 14px)' },
  { type: "low_contrast", severity: "low", screen: "Home", target: "Scope", title: 'Hard to read: "Scope before the build begins" is 3.8:1 against its background (needs 4.5:1 at 12px)' },
  { type: "low_contrast", severity: "low", screen: "Privacy", target: "Last updated", title: 'Hard to read: "Last updated September 19" is 4.3:1 against its background (needs 4.5:1 at 11px)' },
  { type: "tiny_text", severity: "low", screen: "Home", target: "Applied AI", title: 'Very small text (11.5px): "Applied AI Consultancy"' },
  { type: "tiny_text", severity: "low", screen: "Home", target: "founders", title: 'Very small text (10.9px): "A conversation with both founders"' },
  { type: "unfinished_copy", severity: "medium", screen: "Solutions", target: null, title: 'Unfinished copy on the page: "Coming soon WEB APP PILOT"' },
  { type: "blocking_overlay", severity: "low", screen: "Home", target: "Request this time", title: 'Control "Request this time" could not be clicked — something kept covering it' },
];

test.describe("findings, grouped for reading", () => {
  test("collapses a repeated kind into one line without losing a single finding", () => {
    const groups = groupFindings(webRun);
    assert.equal(groups.length, 4, "seven findings, four kinds");
    assert.equal(groups.reduce((sum, group) => sum + group.count, 0), webRun.length, "every finding is inside exactly one group");
    const contrast = groups.find((group) => group.type === "low_contrast");
    assert.equal(contrast.count, 3);
    assert.deepEqual(contrast.screens, ["Home", "Privacy"], "a group says which screens it covers");
  });

  test("names a group in the engine's own words, cut at a word boundary", () => {
    const byType = Object.fromEntries(groupFindings(webRun).map((group) => [group.type, group.label]));
    // The shared prefix of the contrast titles stops mid-word at `Hard to read: "S`; the partial
    // word goes, the engine's phrase stays.
    assert.equal(byType.low_contrast, "Hard to read");
    assert.equal(byType.tiny_text, "Very small text");
    // A group of one is its own title; nothing is invented for it.
    assert.equal(byType.unfinished_copy, 'Unfinished copy on the page: "Coming soon WEB APP PILOT"');
  });

  test("keeps the whole title when every finding in the group shares it", () => {
    const groups = groupFindings([
      { type: "unwired_control", severity: "high", screen: "Cart", title: "Button does nothing" },
      { type: "unwired_control", severity: "high", screen: "Checkout", title: "Button does nothing" },
    ]);
    assert.equal(groups[0].label, "Button does nothing", "the last word is the engine's, not a partial match");
  });

  test("falls back to the kind when the titles share too little to name one", () => {
    const groups = groupFindings([
      { type: "network_error", severity: "high", title: "Request failed: /api/a" },
      { type: "network_error", severity: "high", title: "Nothing in common here" },
    ]);
    assert.equal(groups[0].label, "Network error");
  });

  test("worst first, inside the list and inside each group", () => {
    const groups = groupFindings([
      { type: "slow", severity: "low", title: "Slow page" },
      { type: "crash", severity: "critical", title: "App crashed" },
      { type: "mixed", severity: "low", title: "Mixed bag one" },
      { type: "mixed", severity: "high", title: "Mixed bag two" },
    ]);
    assert.deepEqual(groups.map((group) => group.severity), ["critical", "high", "low"]);
    assert.equal(groups[1].items[0].severity, "high", "the group opens on its worst finding");
  });

  test("the tally is counted from the findings, worst first, and never shows an empty severity", () => {
    assert.deepEqual(severityTally(webRun), [{ severity: "medium", count: 1 }, { severity: "low", count: 6 }]);
    assert.deepEqual(severityTally([]), []);
    assert.deepEqual(severityTally([{ title: "no severity given" }]), [{ severity: "info", count: 1 }]);
    const ordered = severityTally([{ severity: "low" }, { severity: "critical" }, { severity: "medium" }, { severity: "high" }]);
    assert.deepEqual(ordered.map((entry) => entry.severity), ["critical", "high", "medium", "low"]);
  });

  test("a run with no findings groups into nothing rather than failing", () => {
    assert.deepEqual(groupFindings([]), []);
    assert.deepEqual(groupFindings([null, undefined]), []);
  });
});

// A map as the engine writes it: four screens, three ways between them, and the stills named
// after the screen each one is of.
const map = {
  app: { platforms: ["web"], entryNodes: { web: "screen_home" } },
  nodes: [
    { id: "screen_home", semanticKey: "webdemo", name: "WebDemo", controls: [{ id: "c1" }, { id: "c2" }] },
    { id: "screen_pricing", semanticKey: "pricing", name: "Pricing", controls: [] },
    { id: "screen_features", semanticKey: "features", name: "Features", controls: [{ id: "c3" }] },
    { id: "screen_checkout", semanticKey: "checkout", name: "Checkout", controls: [] },
  ],
  edges: [
    { id: "e1", from: "screen_home", to: "screen_pricing", action: { type: "tap", target: "Pricing" } },
    { id: "e2", from: "screen_home", to: "screen_features", action: { type: "tap", target: "Features" } },
    { id: "e3", from: "screen_pricing", to: "screen_checkout", action: { type: "tap", target: "Buy" } },
  ],
};
const stills = [
  { src: "state_1_webdemo.png", caption: "webdemo" },
  { src: "state_2_features.png", caption: "features" },
  { src: "state_3_pricing.png", caption: "pricing" },
  { src: "state_4_checkout.png", caption: "checkout" },
];

test.describe("coverage: the shape of a run", () => {
  test("columns are distance from the screen the run started on", () => {
    const graph = coverageGraph(map, stills, { platform: "web" });
    assert.deepEqual(graph.counts, { screens: 4, transitions: 3 });
    assert.equal(graph.entryId, "screen_home");
    assert.deepEqual(graph.columns, [["screen_home"], ["screen_pricing", "screen_features"], ["screen_checkout"]]);
    assert.equal(graph.screens.every((screen) => screen.reached), true);
    assert.deepEqual(graph.unreachable, []);
  });

  test("each screen carries the action that led on from it, in the engine's words", () => {
    const home = coverageGraph(map, stills, { platform: "web" }).screens.find((screen) => screen.id === "screen_home");
    assert.deepEqual(home.outgoing, [
      { label: "tap “Pricing”", to: "screen_pricing", toName: "Pricing" },
      { label: "tap “Features”", to: "screen_features", toName: "Features" },
    ]);
    assert.equal(home.controls, 2);
    assert.equal(transitionLabel({ type: "back" }), "back", "an action with no target is still named");
    assert.equal(transitionLabel({}), "goes to");
  });

  test("a still is joined to its screen by name, and never guessed at", () => {
    const graph = coverageGraph(map, stills, { platform: "web" });
    assert.equal(graph.screens.find((screen) => screen.id === "screen_pricing").shot, "state_3_pricing.png");
    const noStills = coverageGraph(map, [], { platform: "web" });
    assert.equal(noStills.screens.every((screen) => screen.shot === null), true, "no still means no picture, not another screen's");
  });

  test("a second state of a screen borrows that screen's still and says so", () => {
    const withVariant = {
      ...map,
      nodes: [...map.nodes, { id: "screen_cart_v", semanticKey: "checkout--state-abc", baseSemanticKey: "checkout", variant: "state-abc", name: "Checkout", stateLabel: "Checkout · Payment", controls: [] }],
      edges: [...map.edges, { id: "e4", from: "screen_checkout", to: "screen_cart_v", action: { type: "tap", target: "Pay" } }],
    };
    const variant = coverageGraph(withVariant, stills, { platform: "web" }).screens.find((screen) => screen.id === "screen_cart_v");
    assert.equal(variant.name, "Checkout · Payment", "a variant is named apart from the screen it is a state of");
    assert.equal(variant.shot, "state_4_checkout.png");
    assert.equal(variant.shotIsOfBaseScreen, true, "the card must be able to say the picture is of another state");
    assert.equal(variant.variantOf, "Checkout");
  });

  test("a screen with no recorded way in is set apart, never implied to follow the one beside it", () => {
    const orphaned = { ...map, nodes: [...map.nodes, { id: "screen_lost", semanticKey: "settings", name: "Settings", controls: [] }] };
    const graph = coverageGraph(orphaned, stills, { platform: "web" });
    assert.deepEqual(graph.unreachable, ["screen_lost"]);
    const lost = graph.screens.find((screen) => screen.id === "screen_lost");
    assert.equal(lost.reached, false);
    assert.equal(lost.column, 3, "after every column the run actually reached");
    assert.deepEqual(graph.columns[3], ["screen_lost"]);
  });

  test("a run that wrote no map draws nothing rather than half a picture", () => {
    assert.deepEqual(coverageGraph(null, []), { screens: [], columns: [], counts: { screens: 0, transitions: 0 }, entryId: "", unreachable: [] });
    assert.deepEqual(coverageGraph({ nodes: [], edges: [] }, []).screens, []);
  });

  test("a map with one screen and no transitions is a single column", () => {
    const single = { app: { platforms: ["web"], entryNodes: { web: "only" } }, nodes: [{ id: "only", semanticKey: "home", name: "Home", controls: [] }], edges: [] };
    const graph = coverageGraph(single, [], { platform: "web" });
    assert.deepEqual(graph.columns, [["only"]]);
    assert.deepEqual(graph.screens[0].outgoing, []);
  });
});

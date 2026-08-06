import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildUiMapFromMarkers, diffUiMaps, mergeUiMaps, redactUiText, replayableUiMapNavigation, validateUiMap } from "../mcp-server/src/ui-map.js";

function markers(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-ui-map-"));
  const file = path.join(dir, "ocqa-markers.txt");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

const loginToFeed = [
  'OCQA_STATE:{"screen":"Sign in","url":"/login","hash":"login-v1","role":"login","controls":[{"kind":"field","label":"Email","id":"email"},{"kind":"secureField","label":"Password","id":"password","secure":true},{"kind":"button","label":"Sign in","id":"signin"}]}',
  'OCQA_ACTION:{"type":"tap","target":"Sign in","screen":"Sign in"}',
  'OCQA_TRANSITION:{"from":"Sign in","to":"Feed","action":"Sign in","changed":true}',
  'OCQA_STATE:{"screen":"Feed","url":"/feed","hash":"feed-v1","role":"list","controls":[{"kind":"button","label":"Profile qa.person@example.test","id":"profile"}]}',
];

test("UI Map builds stable nodes, controls, transitions, provenance, and redacts dynamic text", () => {
  const map = buildUiMapFromMarkers({ markersPath: markers(loginToFeed), platform: "web", target: "http://example.test", runId: "run-1", observedAt: "2026-08-04T12:00:00.000Z" });
  assert.deepEqual(validateUiMap(map), []);
  assert.equal(map.nodes.length, 2);
  assert.equal(map.edges.length, 1);
  assert.equal(map.nodes.find((node) => node.name === "Sign in").controls.length, 3);
  assert.match(map.nodes.find((node) => node.name === "Feed").controls[0].label, /<email>/);
  assert.equal(map.edges[0].action.target, "Sign in");
  assert.equal(map.app.entryNodes.web, map.nodes.find((node) => node.name === "Sign in").id);
  assert.deepEqual(map.nodes.find((node) => node.name === "Feed").routes, [{ platform: "web", path: "/feed", replayable: true, status: "observed" }]);
  assert.deepEqual(map.edges[0].platforms, ["web"]);
  assert.deepEqual(map.provenance.runIds, ["run-1"]);
});

test("UI Map separates same-title structural states without fragmenting dynamic list content", () => {
  const map = buildUiMapFromMarkers({ markersPath: markers([
    'OCQA_STATE:{"screen":"Todo List","hash":"root-a","role":"list","controls":[{"kind":"button","label":"Add"},{"kind":"button","label":"Create New Task"},{"kind":"button","label":"Verify onboarding modal, QA"}]}',
    'OCQA_ACTION:{"type":"tap","target":"Add","screen":"Todo List"}',
    'OCQA_TRANSITION_RESOLVED:{"from":"Todo List","to":"New Task","action":"label:Add"}',
    'OCQA_STATE:{"screen":"New Task","hash":"new","role":"form","controls":[{"kind":"field","label":"New Task","accessibilityId":"new_task_field"},{"kind":"button","label":"Save"}]}',
    'OCQA_ACTION:{"type":"tap","target":"Save","screen":"New Task"}',
    'OCQA_TRANSITION_RESOLVED:{"from":"New Task","to":"Todo List","action":"label:Save"}',
    'OCQA_STATE:{"screen":"Todo List","hash":"root-b","role":"list","controls":[{"kind":"button","label":"Add"},{"kind":"button","label":"Create New Task"},{"kind":"button","label":"Tapp stateful benchmark, QA"}]}',
    'OCQA_ACTION:{"type":"tap","target":"Tapp stateful benchmark, QA","screen":"Todo List"}',
    'OCQA_TRANSITION_RESOLVED:{"from":"Todo List","to":"Todo List","action":"label:Tapp stateful benchmark, QA"}',
    'OCQA_STATE:{"screen":"Todo List","hash":"detail-a","role":"list","controls":[{"kind":"button","label":"Completed"},{"kind":"field","label":"Notes","accessibilityId":"task_notes_field"},{"kind":"button","label":"Mark Complete"},{"kind":"button","label":"Delete Task"}]}',
    'OCQA_ACTION:{"type":"tap","target":"Mark Complete","screen":"Todo List"}',
    'OCQA_TRANSITION_RESOLVED:{"from":"Todo List","to":"Todo List","action":"label:Mark Complete"}',
    'OCQA_STATE:{"screen":"Todo List","hash":"detail-b","role":"list","controls":[{"kind":"button","label":"Completed"},{"kind":"field","label":"Notes","accessibilityId":"task_notes_field"},{"kind":"button","label":"Reopen Task"},{"kind":"button","label":"Delete Task"}]}',
  ]), platform: "ios", runId: "stateful", observedAt: "2026-08-05T13:00:00.000Z" });

  const todoStates = map.nodes.filter((node) => node.name === "Todo List");
  assert.equal(todoStates.length, 2);
  const root = todoStates.find((node) => !node.variant);
  const detail = todoStates.find((node) => node.variant === "task-notes-field");
  assert.ok(root);
  assert.ok(detail);
  assert.equal(root.semanticKey, "todo-list");
  assert.equal(detail.semanticKey, "todo-list--task-notes-field");
  assert.equal(root.fingerprints.length, 2, "a new dynamic row remains the same list state");
  assert.equal(detail.fingerprints.length, 2, "Mark Complete/Reopen remains the same detail state");
  assert.ok(map.edges.some((edge) => edge.from === root.id && edge.to === detail.id));
});

test("UI Map separates a same-title state when a prerequisite control disappears", () => {
  const map = buildUiMapFromMarkers({ markersPath: markers([
    'OCQA_STATE:{"screen":"Shop","role":"app","controls":[{"kind":"button","accessibilityId":"product","label":"Product"},{"kind":"button","accessibilityId":"cart_button","label":"Cart"}]}',
    'OCQA_ACTION:{"type":"tap","target":"product","screen":"Shop"}',
    'OCQA_TRANSITION:{"from":"Shop","to":"Product","action":"product","changed":true}',
    'OCQA_STATE:{"screen":"Product","role":"app","controls":[{"kind":"button","accessibilityId":"add_to_cart_button","label":"Add to cart"}]}',
    'OCQA_ACTION:{"type":"tap","target":"add_to_cart_button","screen":"Product"}',
    'OCQA_TRANSITION:{"from":"Product","to":"Cart","action":"add_to_cart_button","changed":true}',
    'OCQA_STATE:{"screen":"Cart","role":"app","controls":[{"kind":"button","accessibilityId":"checkout_button","label":"Checkout"},{"kind":"button","accessibilityId":"continue_shopping_button","label":"Continue shopping"}]}',
    'OCQA_ACTION:{"type":"tap","target":"continue_shopping_button","screen":"Cart"}',
    'OCQA_TRANSITION:{"from":"Cart","to":"Shop","action":"continue_shopping_button","changed":true}',
    'OCQA_STATE:{"screen":"Shop","role":"app","controls":[{"kind":"button","accessibilityId":"product","label":"Product"},{"kind":"button","accessibilityId":"cart_button","label":"Cart"}]}',
    'OCQA_ACTION:{"type":"tap","target":"cart_button","screen":"Shop"}',
    'OCQA_TRANSITION:{"from":"Shop","to":"Cart","action":"cart_button","changed":true}',
    'OCQA_STATE:{"screen":"Cart","role":"app","controls":[{"kind":"button","accessibilityId":"continue_shopping_button","label":"Continue shopping"}]}',
  ]), platform: "android", runId: "cart-state", observedAt: "2026-08-05T14:00:00.000Z" });
  const carts = map.nodes.filter((node) => node.name === "Cart");
  assert.equal(carts.length, 2);
  const filled = carts.find((node) => node.controls.some((control) => control.semanticKey === "checkout-button"));
  const empty = carts.find((node) => !node.controls.some((control) => control.semanticKey === "checkout-button"));
  assert.ok(filled);
  assert.ok(empty);
  assert.notEqual(filled.id, empty.id);
  const shop = map.nodes.find((node) => node.name === "Shop");
  assert.ok(map.edges.some((edge) => edge.from === shop.id && edge.to === empty.id && edge.action.target === "cart_button"));
  assert.ok(map.edges.some((edge) => edge.to === filled.id && edge.action.target === "add_to_cart_button"));
});

test("UI Map keeps same-route SPA form expansion in one semantic screen", () => {
  const markerPath = markers([
    'OCQA_STATE:{"screen":"Messages","url":"http://127.0.0.1:3000/","role":"screen","controls":[{"kind":"button","cssId":"chat","label":"Chat"}]}',
    'OCQA_STATE:{"screen":"Messages","url":"http://127.0.0.1:3000/","role":"screen","controls":[{"kind":"button","cssId":"chat","label":"Chat"},{"kind":"field","cssId":"message","label":"Message"},{"kind":"button","cssId":"send","label":"Send"}]}',
  ]);
  const map = buildUiMapFromMarkers({ markersPath: markerPath, platform: "web", target: "http://127.0.0.1:3000", runId: "spa-form" });
  assert.equal(map.nodes.length, 1);
  assert.equal(map.nodes[0].semanticKey, "messages");
  assert.equal(map.nodes[0].controls.some((control) => control.semanticKey === "send"), true);
});

test("UI Map retains same-screen form preparation required by a later transition", () => {
  const map = buildUiMapFromMarkers({ markersPath: markers([
    'OCQA_STATE:{"screen":"Checkout","role":"form","controls":[{"kind":"field","accessibilityId":"name_field","label":"Name"},{"kind":"field","accessibilityId":"address_field","label":"Address"},{"kind":"button","accessibilityId":"place_order_button","label":"Place order"}]}',
    'OCQA_ACTION:{"type":"type","target":"name_field","reason":"complete_form","status":"ok","screen":"Checkout"}',
    'OCQA_STATE:{"screen":"Checkout","role":"form","controls":[{"kind":"field","accessibilityId":"name_field","label":"Name"},{"kind":"field","accessibilityId":"address_field","label":"Address"},{"kind":"button","accessibilityId":"place_order_button","label":"Place order"}]}',
    'OCQA_ACTION:{"type":"type","target":"address_field","valueSource":"generated-text","reason":"complete_form","status":"ok","screen":"Checkout"}',
    'OCQA_STATE:{"screen":"Checkout","role":"form","controls":[{"kind":"field","accessibilityId":"name_field","label":"Name"},{"kind":"field","accessibilityId":"address_field","label":"Address"},{"kind":"button","accessibilityId":"place_order_button","label":"Place order"}]}',
    'OCQA_ACTION:{"type":"tap","target":"place_order_button","status":"ok","screen":"Checkout"}',
    'OCQA_TRANSITION:{"from":"Checkout","to":"Order Confirmed","action":"place_order_button","changed":true}',
    'OCQA_STATE:{"screen":"Order Confirmed","role":"confirmation","controls":[]}',
  ]), platform: "android", runId: "checkout-preparation", observedAt: "2026-08-05T14:00:00.000Z" });
  const edge = map.edges.find((candidate) => candidate.action.target === "place_order_button");
  assert.deepEqual(edge.preparation, [
    { type: "type", target: "name_field", valueSource: "generated-text" },
    { type: "type", target: "address_field", valueSource: "generated-text" },
  ]);
  assert.deepEqual(edge.preconditions, [
    { type: "field-populated", target: "name_field" },
    { type: "field-populated", target: "address_field" },
  ]);
});

test("UI Map redacts dynamic routes and refuses to call query-dependent observations replayable", () => {
  const map = buildUiMapFromMarkers({ markersPath: markers([
    'OCQA_STATE:{"screen":"Order","url":"/orders/12345678?token=private","role":"screen"}',
  ]), platform: "web", observedAt: "2026-08-04T12:00:00.000Z" });
  assert.deepEqual(map.nodes[0].routes, [{ platform: "web", path: "/orders/<number>", replayable: false, status: "observed", queryOmitted: true }]);
});

test("UI Map compiles a bounded semantic replay path from the observed navigation root", () => {
  const map = buildUiMapFromMarkers({ markersPath: markers([
    'OCQA_STATE:{"screen":"Welcome","role":"onboarding"}',
    'OCQA_NAVIGATION_ROOT:{"screen":"Home","role":"screen","controls":[{"kind":"button","label":"Open Settings","identifier":"settings_button"}]}',
    'OCQA_ACTION:{"type":"tap","target":"label:Open Settings","screen":"Home"}',
    'OCQA_TRANSITION_RESOLVED:{"from":"Home","to":"Settings","action":"label:Open Settings"}',
    'OCQA_STATE:{"screen":"Settings","role":"settings"}',
  ]), platform: "ios", observedAt: "2026-08-04T12:00:00.000Z" });
  const home = map.nodes.find((node) => node.name === "Home");
  const settings = map.nodes.find((node) => node.name === "Settings");
  assert.notEqual(map.app.entryNodes.ios, map.app.navigationRoots.ios, "launch and deterministic navigation root are distinct facts");
  assert.equal(map.app.navigationRoots.ios, home.id);
  assert.deepEqual(home.controls[0].selectors, [
    { kind: "accessibilityId", value: "settings_button" },
    { kind: "label", value: "Open Settings" },
  ]);
  assert.deepEqual(replayableUiMapNavigation(map, settings.id, "ios"), {
    status: "replayable",
    mode: "ui-map-path",
    provenance: "observed-ui-map",
    entryNodeId: home.id,
    targetNodeId: settings.id,
    maxSteps: 8,
    steps: [{
      edgeId: map.edges[0].id,
      from: home.id,
      to: settings.id,
      action: {
        type: "tap",
        target: "Open Settings",
        selectors: [
          { kind: "accessibilityId", value: "settings_button" },
          { kind: "label", value: "Open Settings" },
        ],
      },
      wait: { type: "condition", timeoutMs: 6000 },
      expected: { type: "screen", value: "settings", name: "Settings" },
    }],
  });
});

test("UI Map reconciles an inferred state change with its explicit transition marker", () => {
  const markersPath = markers([
    'OCQA_STATE:{"screen":"Sign in","role":"login"}',
    'OCQA_ACTION:{"type":"login","target":"Sign in","screen":"Sign in"}',
    'OCQA_STATE:{"screen":"Feed","role":"list"}',
    'OCQA_TRANSITION:{"from":"Sign in","to":"Feed","action":"Sign in"}',
  ]);
  const map = buildUiMapFromMarkers({ markersPath, platform: "web", observedAt: "2026-08-04T12:00:00.000Z" });
  assert.equal(map.edges.length, 1);
  assert.equal(map.edges[0].action.type, "login");
  assert.equal(map.edges[0].confirmed, true);
});

test("UI Map attributes browser route opens to their semantic link and deduplicates confirmation", () => {
  const markersPath = markers([
    'OCQA_STATE:{"screen":"Home","role":"screen"}',
    'OCQA_ACTION:{"type":"open","target":"/features.html","via":"Features"}',
    'OCQA_STATE:{"screen":"Features","role":"screen"}',
    'OCQA_TRANSITION:{"from":"Home","to":"Features","action":"Features"}',
  ]);
  const map = buildUiMapFromMarkers({ markersPath, platform: "web", observedAt: "2026-08-04T12:00:00.000Z" });
  assert.equal(map.edges.length, 1);
  assert.equal(map.edges[0].action.target, "Features");
  assert.equal(map.edges[0].confirmed, true);
});

test("UI Map merge preserves learned history and accumulates platform variants", () => {
  const first = buildUiMapFromMarkers({ markersPath: markers(loginToFeed), platform: "web", runId: "web-1", observedAt: "2026-08-04T12:00:00.000Z" });
  first.app.target = "";
  first.app.sourceRoot = "";
  const second = buildUiMapFromMarkers({ markersPath: markers(loginToFeed), platform: "android", runId: "android-1", observedAt: "2026-08-04T13:00:00.000Z" });
  second.app.target = "com.example.product";
  second.app.sourceRoot = "apps/mobile";
  const merged = mergeUiMaps(first, second);
  assert.equal(merged.app.target, "com.example.product");
  assert.equal(merged.app.sourceRoot, "apps/mobile");
  assert.deepEqual(merged.app.platforms, ["android", "web"]);
  assert.deepEqual(merged.nodes.find((node) => node.name === "Feed").platforms, ["android", "web"]);
  assert.equal(merged.app.entryNodes.web, merged.nodes.find((node) => node.name === "Sign in").id);
  assert.equal(merged.app.entryNodes.android, merged.nodes.find((node) => node.name === "Sign in").id);
  assert.deepEqual(merged.edges[0].platforms, ["android", "web"]);
  assert.deepEqual(merged.provenance.runIds, ["android-1", "web-1"]);
  assert.equal(merged.edges[0].observation.count, 2);
});

test("UI Map diff does not call shallow-run absence a regression", () => {
  const full = buildUiMapFromMarkers({ markersPath: markers(loginToFeed), platform: "web", observedAt: "2026-08-04T12:00:00.000Z" });
  const shallow = buildUiMapFromMarkers({ markersPath: markers([loginToFeed[0]]), platform: "web", observedAt: "2026-08-04T13:00:00.000Z" });
  const ordinary = diffUiMaps(full, shallow);
  assert.equal(ordinary.notObservedNodes.length, 1);
  assert.deepEqual(ordinary.lostReachability, []);
  const comparable = diffUiMaps(full, shallow, { comparableFullSweep: true });
  assert.equal(comparable.lostReachability.length, 1);
  assert.equal(comparable.requiresReview, true);
});

test("UI Map text redaction removes common secret/customer identifiers", () => {
  assert.equal(redactUiText("Message qa@example.com token_abcdefghijklmnop 12345678"), "Message <email> <token> <number>");
});

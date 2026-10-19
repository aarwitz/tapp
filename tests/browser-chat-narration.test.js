import test from "node:test";
import assert from "node:assert/strict";

// Node 20 has no assert.partialDeepStrictEqual.
const includes = (actual, expected) => { for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, key); };
import { classifyPrompt, narrate, narrateFinding, summarize } from "../browser/view-model.js";

test.describe("prompt classification", () => {
  test("routes every kind of thing a person can point tapp at", () => {
    assert.equal(classifyPrompt("https://example.com/pricing").kind, "url");
    assert.deepEqual(classifyPrompt("example.com"), { kind: "url", value: "https://example.com" });
    assert.deepEqual(classifyPrompt("github.com/aarwitz/tapp"), { kind: "github", value: "aarwitz/tapp" });
    assert.deepEqual(classifyPrompt("https://github.com/aarwitz/tapp.git"), { kind: "github", value: "aarwitz/tapp" });
    assert.deepEqual(classifyPrompt("aarwitz/tapp"), { kind: "github", value: "aarwitz/tapp" });
    assert.equal(classifyPrompt("~/code/my-app").kind, "path");
    assert.equal(classifyPrompt("/Users/me/app").kind, "path");
    assert.deepEqual(classifyPrompt("com.company.app"), { kind: "bundle", value: "com.company.app" });
    assert.equal(classifyPrompt("/tmp/Build/Products/Debug-iphonesimulator/Demo.app").kind, "app");
    assert.equal(classifyPrompt("~/Downloads/app-debug.apk").kind, "apk");
    assert.deepEqual(classifyPrompt("Acme Bakery"), { kind: "business", value: "Acme Bakery" });
    assert.equal(classifyPrompt("   ").kind, "empty");
  });
});

test.describe("chat narration", () => {
  test("leads each engine line with an emoji and keeps the engine's words", () => {
    assert.deepEqual(narrate({ text: 'Tapped "Add to Cart"' }), { kind: "step", icon: "👆", text: 'Tapped "Add to Cart"' });
    assert.equal(narrate({ text: "Typed test@example.com into Email" }).icon, "⌨️");
    assert.equal(narrate({ text: "Signed in as demo@example.com" }).icon, "🔐");
    assert.equal(narrate({ text: "Launching com.demo.app on the booted simulator" }, { platform: "ios" }).icon, "📱");
    assert.equal(narrate({ text: "Launching the dev server" }, { platform: "web" }).icon, "🌐");
    assert.equal(narrate({ text: "Could not launch the app within 60s" }).kind, "warning");
  });
  test("folds action counters into a progress entry instead of a chat line", () => {
    includes(narrate({ text: "12/40 actions · 5 states" }), { kind: "progress", current: 12, total: 40, states: 5 });
  });
  test("colours findings by severity", () => {
    includes(narrateFinding({ severity: "high", title: "Dead control", screen: "Checkout" }), { icon: "🟠", text: "Dead control on Checkout" });
  });
  test("summarises as a pill plus prose and never as a score", () => {
    const gate = summarize("gate", { report: { gate: { outcome: "pass", reasons: ["All 3 contracts replayed"] } } });
    includes(gate, { tone: "ready", pill: "✓ Ready to merge" });
    assert.match(summarize("audit", { pagesAudited: 4, issueCount: 0 }).pill, /Nothing broken/);
    assert.match(summarize("explore-build", { headline: "Explored 6 screens", screensExplored: 6, actionsPerformed: 20, findings: [] }).text, /not a release decision/);
    assert.doesNotMatch(JSON.stringify(gate), /\b\d{2,3}\/100\b/);
  });
});

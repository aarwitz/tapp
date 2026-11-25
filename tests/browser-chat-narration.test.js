import test from "node:test";
import assert from "node:assert/strict";

// Node 20 has no assert.partialDeepStrictEqual.
const includes = (actual, expected) => { for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, key); };
import { classifyPrompt, narrate, narrateFinding, summarize, parseConnectFragment } from "../browser/view-model.js";

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

test("the person's own agent is told apart in the chat, and its turn is summarised without a verdict (ADR-0012)", () => {
  assert.deepEqual(narrate({ phase: "agent", text: "Looking at the sign-in page." }), { kind: "agent", icon: "🤖", text: "Looking at the sign-in page." });
  assert.deepEqual(narrate({ phase: "agent-tool", text: "tapp_look — url: http://localhost:3000/" }), { kind: "step", icon: "🛠️", text: "tapp_look — url: http://localhost:3000/" });
  assert.deepEqual(narrate({ phase: "agent-warning", text: "Tool error: No booted simulator" }), { kind: "warning", icon: "⚠️", text: "Tool error: No booted simulator" });
  assert.deepEqual(narrate({ phase: "agent-done", text: "The sign-in works." }), { kind: "agent", icon: "✅", text: "The sign-in works." });
  assert.deepEqual(summarize("agent", { text: "The sign-in works.", turns: 3 }), { tone: "ready", pill: "✓ 3 turns", text: "The sign-in works." });
  assert.deepEqual(summarize("agent", { text: "", turns: 1, isError: true }), { tone: "caution", pill: "Stopped", text: "Done." });
});

test("the runtime's address and secret arrive in the fragment, and only a loopback address with a real secret is believed (ADR-0011 §4)", () => {
  assert.deepEqual(parseConnectFragment("#connect=http%3A%2F%2F127.0.0.1%3A4317&token=" + "a".repeat(32)), { origin: "http://127.0.0.1:4317", token: "a".repeat(32) });
  assert.deepEqual(parseConnectFragment("connect=http://localhost:4317/&token=" + "b".repeat(43)), { origin: "http://localhost:4317", token: "b".repeat(43) });
  assert.equal(parseConnectFragment("#connect=https://evil.example&token=" + "a".repeat(32)), null, "never a remote address");
  assert.equal(parseConnectFragment("#connect=http://127.0.0.1:4317&token=short"), null);
  assert.equal(parseConnectFragment(""), null);
});

test("a brand map narrates each surface and sums up without claiming to have seen what it could not (ADR-0013)", () => {
  assert.deepEqual(narrate({ phase: "brand", text: "YouTube @acme: Channel: Acme" }), { kind: "step", icon: "🧭", text: "YouTube @acme: Channel: Acme" });
  const summary = summarize("brand", { name: "Acme Bakery", surfaces: [{}, {}, {}], counts: { ok: 2, "not-checked": 2 } });
  assert.equal(summary.pill, "2 of 4 seen");
  assert.match(summary.text, /3 surfaces found from the website/);
  assert.match(summary.text, /2 could not be checked/);
  assert.match(summary.text, /never signs in to a social account/);
  assert.equal(summarize("brand", { name: "Acme", surfaces: [{}], counts: { ok: 1, warning: 1 } }).tone, "caution");
});

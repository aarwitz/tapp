import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DESTRUCTIVE_CONTROL, SYSTEM_MENU_TITLES, isMacosAppBundle, macActionableElements, normalizeMacElements } from "../mcp-server/src/macos-driver.js";
import { isMacAuthSubmit, isMacBlankSnapshot, macMapControls, macStateHash } from "../mcp-server/src/macos-explorer.js";

// A trimmed accessibility tree in the shape the Swift helper emits.
const TREE = {
  path: "", role: "AXApplication", title: "Ledger", desc: "", value: "", identifier: "", enabled: true, focused: false,
  frame: [0, 0, 0, 0], actions: [],
  children: [
    {
      path: "0", role: "AXWindow", title: "Ledger — Untitled", desc: "", value: "", identifier: "", enabled: true, focused: true,
      frame: [0, 0, 900, 600], actions: ["AXRaise"],
      children: [
        { path: "0.0", role: "AXTextField", title: "Email", desc: "", value: "", identifier: "emailField", enabled: true, focused: false, frame: [20, 40, 200, 24], actions: ["AXConfirm"], children: [] },
        { path: "0.1", role: "AXSecureTextField", title: "Password", desc: "", value: "", identifier: "passwordField", enabled: true, focused: false, frame: [20, 80, 200, 24], actions: ["AXConfirm"], children: [] },
        { path: "0.2", role: "AXButton", title: "Open My Ledger", desc: "", value: "", identifier: "", enabled: true, focused: false, frame: [20, 120, 140, 28], actions: ["AXPress"], children: [] },
        { path: "0.3", role: "AXButton", title: "Delete Everything", desc: "", value: "", identifier: "", enabled: true, focused: false, frame: [200, 120, 140, 28], actions: ["AXPress"], children: [] },
        { path: "0.4", role: "AXButton", title: "Disabled thing", desc: "", value: "", identifier: "", enabled: false, focused: false, frame: [360, 120, 100, 28], actions: ["AXPress"], children: [] },
        { path: "0.5", role: "AXStaticText", title: "", desc: "", value: "Welcome back", identifier: "", enabled: true, focused: false, frame: [20, 10, 200, 18], actions: [], children: [] },
      ],
    },
    {
      path: "1", role: "AXMenuBar", title: "", desc: "", value: "", identifier: "", enabled: true, focused: false, frame: [0, 0, 1440, 24], actions: [],
      children: [
        { path: "1.0", role: "AXMenuBarItem", title: "Apple", desc: "", value: "", identifier: "", enabled: true, focused: false, frame: [0, 0, 30, 24], actions: ["AXPress"],
          children: [{ path: "1.0.0", role: "AXMenuItem", title: "Shut Down…", desc: "", value: "", identifier: "", enabled: true, focused: false, frame: [0, 0, 0, 0], actions: ["AXPress"], children: [] }] },
        { path: "1.1", role: "AXMenuBarItem", title: "Ledger", desc: "", value: "", identifier: "", enabled: true, focused: false, frame: [30, 0, 60, 24], actions: ["AXPress"],
          children: [{ path: "1.1.0", role: "AXMenuItem", title: "Preferences…", desc: "", value: "", identifier: "", enabled: true, focused: false, frame: [0, 0, 0, 0], actions: ["AXPress"], children: [] }] },
      ],
    },
  ],
};

test("the accessibility tree becomes the control shape the rest of tapp already speaks", () => {
  const elements = normalizeMacElements(TREE);
  const byLabel = Object.fromEntries(elements.filter((element) => element.label).map((element) => [element.label, element]));
  assert.equal(byLabel.Email.kind, "field");
  assert.equal(byLabel.Password.kind, "secureField");
  assert.equal(byLabel.Password.secure, true);
  assert.equal(byLabel["Open My Ledger"].clickable, true);
  assert.equal(byLabel["Disabled thing"].clickable, false, "a disabled control is not pressable");
  assert.equal(byLabel["Welcome back"].clickable, false, "static text is scenery");
  assert.equal(byLabel["Open My Ledger"].path, "0.2", "the path addresses it in this snapshot");
});

test("tapp refuses to press the controls that would cost somebody their machine", () => {
  // This runs on a real desktop. There is no simulator to throw away, so the refusal is not a
  // nicety: a crawler that presses "Shut Down…" ends the person's session.
  for (const label of ["Shut Down…", "Restart", "Log Out Aaron", "Move to Trash", "Erase disk", "Delete Everything", "Quit Ledger", "Empty Trash"]) {
    assert.match(label, DESTRUCTIVE_CONTROL, `${label} must never be pressed`);
  }
  for (const label of ["Open My Ledger", "Save", "Add row", "Continue", "Export…"]) {
    assert.doesNotMatch(label, DESTRUCTIVE_CONTROL, `${label} is ordinary and must stay pressable`);
  }
  const elements = normalizeMacElements(TREE);
  assert.equal(elements.find((element) => element.label === "Delete Everything").destructive, true);
  assert.equal(macActionableElements(elements).some((element) => element.destructive), false);
});

test("the system menu bar belongs to macOS, not to the application under test", () => {
  const elements = normalizeMacElements(TREE);
  assert.equal(elements.some((element) => element.label === "Shut Down…"), false, "the Apple menu is not crawled at all");
  assert.equal(elements.some((element) => element.label === "Preferences…"), true, "the application's own menu is inventoried");
  assert.equal(elements.find((element) => element.label === "Preferences…").inMenu, true);
  assert.ok(SYSTEM_MENU_TITLES.has("Apple"));
  // Asked for them explicitly, they are there — inventory is a choice, not a limitation.
  assert.equal(normalizeMacElements(TREE, { includeSystemMenus: true }).some((element) => element.label === "Shut Down…"), true);
});

test("a .app is a macOS application or a simulator build, and the executable says which", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-macos-bundle-"));
  const mac = path.join(root, "Ledger.app");
  fs.mkdirSync(path.join(mac, "Contents", "MacOS"), { recursive: true });
  const sim = path.join(root, "Sim.app");
  fs.mkdirSync(sim, { recursive: true });
  fs.writeFileSync(path.join(sim, "Sim"), "");
  assert.equal(isMacosAppBundle(mac), true);
  assert.equal(isMacosAppBundle(sim), false, "a simulator build keeps its executable at the top level");
  assert.equal(isMacosAppBundle(path.join(root, "Missing.app")), false);
  assert.equal(isMacosAppBundle("/System/Applications"), false);
});

test("exploration reads the window, and menus are counted rather than crawled", () => {
  const snap = { screen: "Ledger — Untitled", elements: normalizeMacElements(TREE) };
  assert.equal(isMacBlankSnapshot(snap), false);
  assert.equal(isMacBlankSnapshot({ screen: "Empty", elements: [] }), true);
  // The hash ignores menu items: opening a menu is not a new screen.
  const withMenuChange = { ...snap, elements: snap.elements.map((element) => element.inMenu ? { ...element, label: `${element.label} (open)` } : element) };
  assert.equal(macStateHash(snap), macStateHash(withMenuChange));
  const controls = macMapControls(snap.elements);
  assert.deepEqual(controls.map((control) => control.label).sort(), ["Delete Everything", "Disabled thing", "Email", "Open My Ledger", "Password"].sort());
  assert.equal(controls.some((control) => control.label === "Preferences…"), false, "a menu item is not a window control");
});

test("the sign-in submit rule is the shared one, so a product-named button still works", () => {
  assert.equal(isMacAuthSubmit({ label: "Sign In" }), true);
  assert.equal(isMacAuthSubmit({ label: "Unlock" }), true);
  assert.equal(isMacAuthSubmit({ label: "Open My Ledger" }), false, "named for the product, so the shared rule handles it by position");
});

// Driving a real application on whoever runs this is not something a test suite should do
// without being asked, so it is opt-in. It is the test that actually proves the driver.
test("tapp drives a real macOS application", { skip: process.env.TAPP_MACOS_LIVE === "1" ? false : "set TAPP_MACOS_LIVE=1 to drive Calculator on this machine", timeout: 180_000 }, async () => {
  const { MacosDriver, macAccessibilityTrusted } = await import("../mcp-server/src/macos-driver.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-macos-live-"));
  if (!macAccessibilityTrusted({ home })) {
    assert.fail("Accessibility is not granted to whatever runs this; `tapp doctor` says how.");
  }
  const driver = new MacosDriver({ home });
  driver.launch("/System/Applications/Calculator.app");
  let snap = driver.settle();
  assert.match(snap.screen, /Calculator/i);
  assert.ok(macActionableElements(snap.elements).length > 10, "the keypad is visible");
  for (const key of ["7", "Add", "8", "Equals"]) {
    snap = driver.settle();                       // paths move as the app re-lays out
    assert.equal(driver.tap(key, snap).status, "ok", `pressing ${key}`);
  }
  snap = driver.settle({ includeSystemMenus: true });
  assert.equal(driver.tap("Quit Calculator", snap).status, "refused", "and it still refuses the dangerous ones");
});

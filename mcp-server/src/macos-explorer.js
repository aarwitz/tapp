// Bounded deterministic exploration of a macOS application.
//
// It emits the same marker contract as the XCUITest harness and the Android explorer, so
// report.js, the UI Map, journeys, baselines and the CI gate do not know or care which platform
// produced the evidence.
//
// Two rules are specific to the desktop, and both exist because this is the person's own
// machine rather than a simulator:
//
//   • Destructive controls are never pressed. The driver refuses them too; this is the second
//     of the two locks (mcp-server/src/macos-driver.js).
//   • Menu items are INVENTORIED, NOT PRESSED. A desktop menu is where "Quit", "Delete" and
//     "Move to Trash" live, and it is also full of items that open modal file pickers a crawler
//     cannot close. The report says what the menus contain and says plainly that nothing in them
//     was exercised, which is an honest coverage boundary rather than a silent one.
import fs from "node:fs";
import path from "node:path";

import { MacosDriver, macActionableElements } from "./macos-driver.js";

const ERROR_RE = /\b(something went wrong|an error occurred|failed to load|unexpected error|could not be completed|unable to)\b/i;
const AUTH_SUBMIT_RE = /\b(sign[ -]?in|log[ -]?in|continue|submit|unlock)\b/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function macStateHash(snap) {
  return (snap.elements || []).filter((element) => !element.inMenu)
    .map((element) => `${element.type}:${element.id}:${element.label}:${element.value}`).join("|");
}

export function isMacAuthSubmit(element) {
  return AUTH_SUBMIT_RE.test(`${element?.label || ""} ${element?.id || ""}`.replace(/[_-]+/g, " "));
}

/** The control inventory a UI Map node wants, for the window only. */
export function macMapControls(elements) {
  // A disabled button is still part of the screen's inventory — "enabled: false" is a state a
  // UI Map should record, not a reason to omit the control (same as the Android map).
  const PRESSABLE = new Set(["button", "checkbox", "radio", "tabs", "link", "disclosure"]);
  return elements.filter((element) => !element.inMenu && (element.clickable || PRESSABLE.has(element.kind) || element.kind === "field" || element.kind === "secureField"))
    .map((element) => ({
      kind: element.kind === "secureField" ? "secureField" : element.kind === "field" ? "field" : element.kind === "checkbox" || element.kind === "radio" ? "toggle" : "button",
      type: element.type,
      id: element.id || "",
      accessibilityId: element.id || "",
      label: element.label,
      secure: Boolean(element.secure),
      enabled: element.enabled !== false,
      hittable: Boolean(element.hittable),
    }));
}

/** A window with nothing in it is a finding, not a successful visit. */
export function isMacBlankSnapshot(snap) {
  const elements = (snap?.elements || []).filter((element) => !element.inMenu);
  const meaningful = elements.some((element) => String(element.label || "").trim() || String(element.value || "").trim());
  const interactive = elements.some((element) => element.clickable || element.kind === "field");
  return !meaningful && !interactive;
}

export async function exploreMacos({
  appPath, maxActions = 40, timeoutSec = 300, outDir,
  testEmail = "", testPassword = "", onProgress = () => {}, driver, home,
}) {
  const d = driver || new MacosDriver({ home });
  fs.mkdirSync(outDir, { recursive: true });
  const screenshots = path.join(outDir, "screenshots");
  fs.mkdirSync(screenshots, { recursive: true });
  const markersPath = path.join(outDir, "ocqa-markers.txt");
  fs.rmSync(markersPath, { force: true });
  const emit = (kind, payload) => fs.appendFileSync(markersPath, `OCQA_${kind}:${JSON.stringify(payload)}\n`);

  const deadline = Date.now() + timeoutSec * 1000;
  const tried = new Set();
  const visited = new Map();
  let issues = 0;
  let actions = 0;
  let loginTried = false;
  let shotsUnavailable = false;

  const launched = d.launch(appPath);
  emit("ACTION", { type: "open", target: launched.name || appPath, via: appPath, narrative: `Launched ${launched.name || path.basename(appPath)}` });
  let snap = d.settle();

  const stillRunning = () => {
    try { process.kill(d.pid, 0); return true; } catch { return false; }
  };

  const recordState = (snapshot) => {
    const hash = macStateHash(snapshot);
    const screen = snapshot.screen || snapshot.app || "Window";
    if (!visited.has(hash)) {
      visited.set(hash, screen);
      const file = path.join(screenshots, `${String(visited.size).padStart(2, "0")}-${screen.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 50) || "window"}.png`);
      const shot = d.screenshot(file, snapshot);
      if (shot.status !== "ok") shotsUnavailable = true;
    }
    const inputs = snapshot.elements.filter((element) => element.kind === "field" || element.kind === "secureField")
      .map((element) => ({ key: element.id || element.label, label: element.label, secure: Boolean(element.secure) }));
    emit("STATE", {
      screen, hash, elements: snapshot.elements.length, action: actions,
      role: inputs.some((input) => input.secure) ? "login" : "app",
      inputs, controls: macMapControls(snapshot.elements),
    });
    return { hash, screen, inputs };
  };

  // Everything in the application's own menus, recorded once as coverage. Nothing here is
  // pressed; see the note at the top of this file.
  const menuInventory = [...new Set(snap.elements.filter((element) => element.inMenu && element.label)
    .map((element) => `${element.menu} › ${element.label}`))].slice(0, 400);
  if (menuInventory.length) emit("COVERAGE", { kind: "menu-items", listed: menuInventory.length, pressed: 0, items: menuInventory });

  while (actions < maxActions && Date.now() < deadline) {
    if (!stillRunning()) {
      emit("ISSUE", { type: "crash", severity: "critical", title: "The application exited during exploration", screen: visited.size ? [...visited.values()].at(-1) : "Launch", step: actions });
      issues += 1;
      break;
    }
    const { hash, screen, inputs } = recordState(snap);
    onProgress({ action: actions, max: maxActions, states: visited.size });

    const visibleText = snap.elements.filter((element) => !element.inMenu).map((element) => element.label || element.value).filter(Boolean).join(" ");
    if (ERROR_RE.test(visibleText)) {
      emit("ISSUE", { type: "error_surface", severity: "high", title: "Visible error surface", screen, step: actions });
      issues += 1;
    }
    if (isMacBlankSnapshot(snap)) {
      emit("ISSUE", { type: "blank_screen", severity: "high", title: "No usable controls or content", screen, step: actions });
      issues += 1;
    }

    // Fill a field before pressing things, so a form is submitted with something in it.
    const unfilled = snap.elements.find((element) => !element.inMenu && (element.kind === "field" || element.kind === "secureField")
      && element.enabled && !tried.has(`${screen}|input|${element.id || element.label}`));
    if (unfilled) {
      const key = unfilled.id || unfilled.label;
      const lower = `${key} ${unfilled.label}`.toLowerCase();
      const value = unfilled.secure || lower.includes("password") ? (testPassword || "TestPass123!")
        : lower.includes("email") ? (testEmail || "test@example.com") : "Tapp test";
      tried.add(`${screen}|input|${key}`);
      const typed = d.type(key, value, snap);
      actions += 1;
      emit("ACTION", {
        type: "type", target: key, screen, status: typed.status,
        valueSource: unfilled.secure || lower.includes("password") ? "test-password" : lower.includes("email") ? "test-email" : "generated-text",
        reason: "complete_form", step: actions, narrative: `Typed into “${unfilled.label || key}”`,
      });
      snap = d.settle();
      continue;
    }

    const candidate = macActionableElements(snap.elements)
      .find((element) => !element.inMenu && !tried.has(`${hash}|tap|${element.label}`));
    if (candidate) {
      const target = candidate.label;
      const loginSubmit = inputs.some((input) => input.secure) && isMacAuthSubmit(candidate);
      if (loginSubmit) loginTried = true;
      tried.add(`${hash}|tap|${target}`);
      const pressed = d.tap(target, snap);
      actions += 1;
      await sleep(250);
      snap = d.settle();
      const after = macStateHash(snap);
      emit("ACTION", {
        type: loginSubmit ? "login_submit" : "tap", target, screen, status: pressed.status,
        reason: "untried_control", step: actions, narrative: `Pressed “${target}”`,
      });
      emit("TRANSITION", { from: screen, to: snap.screen, action: target, changed: hash !== after });
      const authFailed = loginSubmit && snap.elements.some((element) => element.secure && !element.inMenu);
      if (pressed.status === "ok" && authFailed) {
        emit("ISSUE", { type: "auth_failed", severity: "high", title: "Sign-in attempt remained on the sign-in window", screen, target, step: actions });
        issues += 1;
      } else if (pressed.status === "ok" && hash === after) {
        emit("ISSUE", { type: "unresponsive_element", severity: "medium", title: `Control did not respond: ${target}`, screen, target, step: actions });
        issues += 1;
      }
      continue;
    }

    // Nothing left here. Escape closes a sheet, a popover or a menu — the desktop's "back".
    const escapeKey = `${hash}|escape`;
    if (!tried.has(escapeKey)) {
      tried.add(escapeKey);
      d.key("escape");
      actions += 1;
      await sleep(250);
      const next = d.settle();
      emit("ACTION", { type: "back", target: "escape", reason: "state_exhausted", step: actions, screen, narrative: "Pressed Escape" });
      emit("TRANSITION", { from: screen, to: next.screen, action: "escape", changed: macStateHash(next) !== hash });
      if (macStateHash(next) !== hash) { snap = next; continue; }
    }
    break;
  }

  const timedOut = Date.now() >= deadline;
  emit("COMPLETE", {
    actions, states: visited.size, issues,
    screens: [...new Set(visited.values())].join(","),
    outcome: timedOut ? "timeout" : "complete", timedOut,
    credentialsProvided: Boolean(testEmail || testPassword), credentialsUsed: loginTried,
    // Said out loud, every run: what a desktop run deliberately does not touch.
    notChecked: [
      `${menuInventory.length} menu item(s) were listed but not pressed — a desktop menu holds Quit, Delete and file pickers.`,
      ...(shotsUnavailable ? ["Screenshots were unavailable: macOS Screen Recording permission is not granted to whatever runs tapp."] : []),
    ],
    ...(timedOut ? { timeoutSeconds: timeoutSec } : {}),
  });
  onProgress({ action: actions, max: maxActions, states: visited.size });
  return { markersPath, outDir, actions, states: visited.size, issues, timedOut, menuItems: menuInventory.length, screenshots: !shotsUnavailable };
}

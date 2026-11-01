// Driving a macOS application, the same way tapp drives an Android device.
//
// Android is `adb` plus a UIAutomator dump; macOS is the Accessibility API plus a small Swift
// helper (MacHarness/tapp-mac-ax.swift), compiled once and cached. Neither needs the application
// under test to be rebuilt, re-signed or linked against anything.
//
// Two things make macOS different from every other target tapp drives, and both shape this file.
//
// 1. Element paths are not stable. An application re-lays out its accessibility tree as its state
//    changes, so a path read a moment ago can address a different control or nothing at all.
//    Every action therefore takes a FRESH snapshot and resolves its target by label on that
//    snapshot — never by a remembered path. (Measured on Calculator: pressing four buttons in a
//    row with paths from one snapshot pressed the wrong ones.)
//
// 2. This is the person's real machine. There is no simulator and no sandbox: a stray press lands
//    on their actual Finder, their actual documents, their actual session. So the driver refuses
//    destructive controls itself, rather than trusting whatever is choosing targets to be
//    careful. An explorer bug must not be able to log somebody out.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Controls tapp will not press on a desktop, however it was asked. The cost of a false positive
 * is a control left alone; the cost of a false negative is somebody's session, their files, or
 * their machine. The list is matched against the whole label, case-insensitively.
 */
export const DESTRUCTIVE_CONTROL = /\b(shut ?down|restart|log ?out|sign ?out|sleep|erase|empty trash|move to trash|delete|uninstall|deactivate|format|wipe|reset|revoke|remove|discard|destroy|force quit|quit)\b/i;

/** System chrome that belongs to macOS, not to the application under test. */
export const SYSTEM_MENU_TITLES = new Set(["Apple", "Services", "Window", "Help"]);

const MAC_ROLE_KIND = {
  AXButton: "button", AXMenuItem: "menuItem", AXMenuBarItem: "menu", AXPopUpButton: "button",
  AXCheckBox: "checkbox", AXRadioButton: "radio", AXTextField: "field", AXTextArea: "field",
  AXSecureTextField: "secureField", AXSlider: "slider", AXLink: "link", AXTabGroup: "tabs",
  AXStaticText: "text", AXImage: "image", AXRow: "row", AXCell: "cell", AXDisclosureTriangle: "disclosure",
};

/** Where the compiled helper lives. Built on first use, like the iOS harness. */
export function macAxHelperPath(home = process.env.TAPP_HOME || path.join(os.homedir(), ".tapp")) {
  return path.join(home, "bin", "tapp-mac-ax");
}

export function macAxSourcePath() {
  return path.join(packageRoot, "MacHarness", "tapp-mac-ax.swift");
}

/**
 * Compile the helper if it is missing or older than its source. ~3s once; after that it is a
 * cached binary and the driver is as quick as adb.
 */
export function ensureMacAxHelper({ home = process.env.TAPP_HOME || path.join(os.homedir(), ".tapp"), rebuild = false } = {}) {
  if (process.platform !== "darwin") throw new Error("macOS applications can only be driven on macOS.");
  const source = macAxSourcePath();
  if (!fs.existsSync(source)) throw new Error(`The macOS helper source is missing: ${source}`);
  const binary = macAxHelperPath(home);
  const fresh = !rebuild && fs.existsSync(binary) && fs.statSync(binary).mtimeMs >= fs.statSync(source).mtimeMs;
  if (fresh) return binary;
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const built = spawnSync("swiftc", ["-O", source, "-o", binary], { encoding: "utf8" });
  if (built.status !== 0) {
    throw new Error(`Could not build the macOS helper. Is Xcode or the Command Line Tools installed? ${String(built.stderr || built.error?.message || "").trim().slice(0, 300)}`);
  }
  return binary;
}

function runHelper(binary, args, { timeoutMs = 30_000 } = {}) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`The macOS helper did not run: ${result.error.message}`);
  const text = String(result.stdout || "").trim();
  if (result.status !== 0) {
    let detail = String(result.stderr || "").trim();
    try { detail = JSON.parse(detail).error || detail; } catch { /* plain text is fine */ }
    throw new Error(detail || `The macOS helper exited ${result.status}`);
  }
  try { return JSON.parse(text); } catch { throw new Error(`The macOS helper answered something that is not JSON: ${text.slice(0, 200)}`); }
}

/** Has the person granted Accessibility to whatever is running tapp? Nothing works without it. */
export function macAccessibilityTrusted({ home } = {}) {
  try { return Boolean(runHelper(ensureMacAxHelper({ home }), ["trusted"], { timeoutMs: 10_000 }).trusted); }
  catch { return false; }
}

export const ACCESSIBILITY_REMEDIATION =
  "Grant Accessibility to whatever runs tapp: System Settings → Privacy & Security → Accessibility, then add your terminal (or the tapp app) and switch it on. macOS has no way for a program to grant this to itself.";

/** One flat, tapp-shaped control list out of the nested accessibility tree. */
export function normalizeMacElements(root, { includeSystemMenus = false } = {}) {
  const elements = [];
  const visit = (node, insideMenuBar, menuOwner) => {
    if (!node) return;
    const role = String(node.role || "");
    // The menu bar carries the Apple menu and the system items; they are macOS, not the
    // application, and nothing good comes of a crawler in there.
    if (role === "AXMenuBarItem") {
      const owner = String(node.title || "");
      if (!includeSystemMenus && SYSTEM_MENU_TITLES.has(owner)) return;
      for (const child of node.children || []) visit(child, true, owner);
      elements.push(shape(node, true, owner));
      return;
    }
    elements.push(shape(node, insideMenuBar, menuOwner));
    for (const child of node.children || []) visit(child, insideMenuBar, menuOwner);
  };
  const shape = (node, inMenu, menuOwner) => {
    const role = String(node.role || "");
    const label = String(node.title || node.desc || node.identifier || "").trim();
    const value = String(node.value || "").trim();
    const actions = Array.isArray(node.actions) ? node.actions : [];
    const [x = 0, y = 0, width = 0, height = 0] = Array.isArray(node.frame) ? node.frame : [];
    return {
      path: String(node.path || ""),
      type: role,
      kind: MAC_ROLE_KIND[role] || "other",
      role: MAC_ROLE_KIND[role] || "other",
      id: String(node.identifier || ""),
      label: label || value,
      value,
      secure: role === "AXSecureTextField",
      enabled: node.enabled !== false,
      // A control with no press action and no size is scenery.
      clickable: actions.includes("AXPress") && node.enabled !== false && (inMenu || (width > 0 && height > 0)),
      hittable: inMenu || (width > 0 && height > 0),
      inMenu: Boolean(inMenu),
      menu: menuOwner || "",
      frame: [x, y, width, height],
      destructive: DESTRUCTIVE_CONTROL.test(label || value),
    };
  };
  visit(root, false, "");
  return elements;
}

/** Everything tapp is willing to press here, best first. */
export function macActionableElements(elements) {
  return elements.filter((element) => element.clickable && element.label && !element.destructive);
}

export class MacosDriver {
  constructor({ home = process.env.TAPP_HOME || path.join(os.homedir(), ".tapp"), pid = null } = {}) {
    this.home = home;
    this.binary = ensureMacAxHelper({ home });
    this.pid = pid;
    this.appName = "";
  }

  /** Start the application (or attach to it if it is already running) and wait for a window. */
  launch(appPath, { settleMs = 1200 } = {}) {
    const started = runHelper(this.binary, ["launch", "--app", appPath], { timeoutMs: 45_000 });
    this.pid = started.pid;
    this.appName = started.name || "";
    this.bundleId = started.bundleId || "";
    spawnSync("sleep", [String(Math.max(0.2, settleMs / 1000))]);
    return started;
  }

  requirePid() {
    if (!this.pid) throw new Error("No application is attached; launch one first.");
    return String(this.pid);
  }

  /** A fresh snapshot. Everything else in this class takes one of these, never a stale path. */
  settle({ maxNodes = 2500, maxDepth = 28, includeSystemMenus = false } = {}) {
    const tree = runHelper(this.binary, ["tree", "--pid", this.requirePid(), "--max-nodes", String(maxNodes), "--max-depth", String(maxDepth)]);
    const elements = normalizeMacElements(tree.root, { includeSystemMenus });
    return {
      platform: "macos",
      app: tree.app || this.appName,
      // The window title names the screen, the way a visible h1 names a web page.
      screen: tree.window || tree.app || this.appName,
      truncated: Boolean(tree.truncated),
      nodeCount: tree.nodes || elements.length,
      elements,
    };
  }

  /** Resolve a semantic target against THIS snapshot. Never against a remembered one. */
  find(target, snap) {
    const wanted = String(target || "").trim().toLowerCase();
    if (!wanted) return null;
    const candidates = snap.elements.filter((element) => element.hittable && element.enabled);
    return candidates.find((element) => element.id && element.id.toLowerCase() === wanted)
      || candidates.find((element) => element.label.toLowerCase() === wanted)
      || candidates.find((element) => element.label.toLowerCase().startsWith(wanted))
      || candidates.find((element) => element.label.toLowerCase().includes(wanted))
      || null;
  }

  tap(target, snap) {
    const element = this.find(target, snap);
    if (!element) return { status: "not_found", detail: `No control named ‘${target}’` };
    // The refusal lives here, not only in whatever chose the target: this runs against the
    // person's real machine and an explorer bug must not be able to log them out.
    if (element.destructive) return { status: "refused", detail: `tapp does not press ‘${element.label}’ on a real machine` };
    if (!element.clickable) return { status: "not_actionable", detail: `‘${element.label}’ cannot be pressed` };
    try {
      runHelper(this.binary, ["press", "--pid", this.requirePid(), "--path", element.path]);
      return { status: "ok", detail: element.label, element };
    } catch (error) { return { status: "failed", detail: error.message }; }
  }

  type(target, text, snap) {
    const element = this.find(target, snap);
    if (!element) return { status: "not_found", detail: `No field named ‘${target}’` };
    try {
      runHelper(this.binary, ["setvalue", "--pid", this.requirePid(), "--path", element.path, "--text", String(text ?? "")]);
      return { status: "ok", detail: element.label, element };
    } catch (error) { return { status: "failed", detail: error.message }; }
  }

  key(name) {
    try { runHelper(this.binary, ["key", "--pid", this.requirePid(), "--key", String(name)]); return { status: "ok", detail: String(name) }; }
    catch (error) { return { status: "failed", detail: error.message }; }
  }

  /**
   * A picture of the window, if the person has granted Screen Recording. Evidence is better with
   * one and still usable without, so a refusal is reported rather than thrown.
   */
  screenshot(destination, snap = null) {
    const frame = snap?.elements?.find((element) => element.type === "AXWindow")?.frame;
    const args = ["-x", "-o"];
    if (frame && frame[2] > 0 && frame[3] > 0) args.push("-R", frame.map((value) => Math.round(value)).join(","));
    args.push(destination);
    const shot = spawnSync("screencapture", args, { encoding: "utf8", timeout: 20_000 });
    if (shot.status === 0 && fs.existsSync(destination) && fs.statSync(destination).size > 0) return { status: "ok", path: destination };
    return { status: "unavailable", detail: "screencapture produced nothing — macOS Screen Recording permission is probably not granted" };
  }

  quit() {
    if (!this.pid) return { status: "ok", detail: "nothing to quit" };
    try { runHelper(this.binary, ["quit", "--pid", String(this.pid)], { timeoutMs: 15_000 }); return { status: "ok" }; }
    catch (error) { return { status: "failed", detail: error.message }; }
  }
}

/**
 * Is this .app a macOS application or an iOS simulator build? Both are directories called
 * Something.app, and tapp is given either. A macOS bundle keeps its executable in Contents/MacOS;
 * a simulator build keeps it at the top level and declares an iPhone platform.
 */
export function isMacosAppBundle(bundlePath) {
  try {
    if (!/\.app\/?$/.test(bundlePath) || !fs.statSync(bundlePath).isDirectory()) return false;
    return fs.existsSync(path.join(bundlePath, "Contents", "MacOS"));
  } catch { return false; }
}

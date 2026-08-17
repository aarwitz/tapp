// Native black-box Android driver: the UIAutomator/ADB counterpart to Tapp's
// generic XCUITest harness. It can attach to any debuggable or release APK
// without linking a Tapp SDK into the app.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function executable(name, env = process.env) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const homes = [
    env.ANDROID_SDK_ROOT,
    env.ANDROID_HOME,
    env.HOME && path.join(env.HOME, "Library", "Android", "sdk"),
    env.HOME && path.join(env.HOME, "Android", "Sdk"),
    "/opt/homebrew/share/android-commandlinetools",
    "/usr/local/share/android-commandlinetools",
  ].filter(Boolean);
  for (const home of homes) {
    const p = path.join(home, "platform-tools", name + suffix);
    if (fs.existsSync(p)) return p;
  }
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    const p = path.join(dir, name + suffix);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function resolveAdbPath(env = process.env) {
  return executable("adb", env);
}

function runFile(command, args, { encoding = "utf8", timeout = 30_000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding, timeout, maxBuffer }, (error, stdout, stderr) => {
      resolve({ code: error?.code && Number.isInteger(error.code) ? error.code : error ? 1 : 0, stdout, stderr, error });
    });
  });
}

function entityDecode(value) {
  return String(value || "")
    .replaceAll("&quot;", '"').replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function bounds(value) {
  const m = String(value || "").match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!m) return { x: 0, y: 0, w: 0, h: 0 };
  const [, x1, y1, x2, y2] = m.map(Number);
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

export function parseUiAutomatorXml(xml) {
  const nodes = [];
  for (const match of String(xml || "").matchAll(/<node\s+([^>]*?)(?:\/?>)/g)) {
    const attrs = {};
    for (const a of match[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = entityDecode(a[2]);
    const frame = bounds(attrs.bounds);
    const text = attrs.text || "";
    const description = attrs["content-desc"] || "";
    const resourceId = attrs["resource-id"] || "";
    nodes.push({
      type: attrs.class || "android.view.View",
      id: resourceId,
      label: description || text,
      text,
      value: text,
      description,
      package: attrs.package || "",
      enabled: attrs.enabled !== "false",
      clickable: attrs.clickable === "true",
      focusable: attrs.focusable === "true",
      focused: attrs.focused === "true",
      scrollable: attrs.scrollable === "true",
      secure: attrs.password === "true",
      selected: attrs.selected === "true",
      hittable: attrs.enabled !== "false" && attrs["visible-to-user"] !== "false" && frame.w > 0 && frame.h > 0,
      ...frame,
    });
  }
  return nodes;
}

export function androidElementKey(element) {
  return element.id || element.description || element.text || `${element.type}:${element.x},${element.y}`;
}

export function findAndroidElement(elements, target, { hittable = false } = {}) {
  const wanted = String(target || "").trim();
  if (!wanted) return null;
  const pool = hittable ? elements.filter((e) => e.hittable) : elements;
  const exact = (value) => value && value.localeCompare(wanted, undefined, { sensitivity: "accent" }) === 0;
  return pool.find((e) => exact(e.id))
    || pool.find((e) => e.id && e.id.endsWith(`/${wanted}`))
    || pool.find((e) => exact(e.description))
    || pool.find((e) => exact(e.text))
    || pool.find((e) => exact(e.label))
    || pool.find((e) => [e.description, e.text, e.label].some((v) => v && v.toLowerCase().includes(wanted.toLowerCase())))
    || null;
}

export function detectAndroidScreen(elements, activity = "") {
  const explicit = elements.find((e) => /\/(screen_title|toolbar_title|title)$/.test(e.id) && e.text);
  if (explicit) return explicit.text;
  const described = elements.find((e) => /^screen:/i.test(e.description));
  if (described) return described.description.replace(/^screen:\s*/i, "");
  const topText = elements
    .filter((e) => e.text && e.y < 260 && !/statusbar|navigationbar/i.test(e.type))
    .sort((a, b) => a.y - b.y || a.x - b.x)[0];
  if (topText) return topText.text;
  const component = String(activity || "").split("/").at(-1)?.replace(/^\./, "").replace(/Activity$/, "");
  return component || "Unknown";
}

export function isAndroidAppSnapshot(snapshot, appId) {
  if (!snapshot || !appId) return false;
  const activity = String(snapshot.activity || "");
  const ownsActivity = activity.startsWith(`${appId}/`);
  const packages = new Set((snapshot.elements || []).map((e) => e.package).filter(Boolean));
  const ownsElements = packages.has(appId);
  // dumpXml and dumpsys used to run concurrently. If an app crashed while they were sampled, a
  // stale activity from the dead app could be paired with another app's UI tree and Tapp would map
  // that unrelated app as the crash destination. When both signals exist, require agreement.
  if (activity && packages.size) return ownsActivity && ownsElements;
  return ownsActivity || ownsElements;
}

export class AndroidDriver {
  constructor({ adbPath = resolveAdbPath(), serial = "", appId = "" } = {}) {
    if (!adbPath) throw new Error("Android testing needs adb. Install Android SDK platform-tools or set ANDROID_SDK_ROOT.");
    this.adbPath = adbPath;
    this.serial = serial;
    this.appId = appId;
  }

  args(args) { return this.serial ? ["-s", this.serial, ...args] : args; }
  async adb(args, options) { return runFile(this.adbPath, this.args(args), options); }

  async ensureDevice() {
    const r = await runFile(this.adbPath, ["devices", "-l"]);
    if (r.code !== 0) throw new Error((r.stderr || "adb devices failed").trim());
    const devices = String(r.stdout).split(/\r?\n/).slice(1)
      .map((line) => line.trim().split(/\s+/)).filter((p) => p[0] && p[1] === "device");
    if (this.serial) {
      if (!devices.some(([serial]) => serial === this.serial)) throw new Error(`Android device ${this.serial} is not connected and authorized`);
    } else if (devices.length) {
      this.serial = devices[0][0];
    } else {
      throw new Error("No connected Android emulator/device. Start an emulator or connect a device with USB debugging enabled.");
    }
    return { serial: this.serial };
  }

  async install(apkPath) {
    const r = await this.adb(["install", "-r", "-t", apkPath], { timeout: 180_000 });
    if (r.code !== 0 || !String(r.stdout).includes("Success")) throw new Error((r.stderr || r.stdout || "APK install failed").trim());
    return true;
  }

  async forceStop() {
    if (this.appId) await this.adb(["shell", "am", "force-stop", this.appId]);
  }

  async isProcessAlive() {
    if (!this.appId) return false;
    const r = await this.adb(["shell", "pidof", this.appId]);
    return r.code === 0 && /\d/.test(String(r.stdout || ""));
  }

  async clearData() {
    if (!this.appId) throw new Error("appId is required to clear Android app data");
    const r = await this.adb(["shell", "pm", "clear", this.appId]);
    if (!String(r.stdout).includes("Success")) throw new Error((r.stderr || r.stdout || "Could not clear app data").trim());
  }

  async launch({ clearData = false } = {}) {
    await this.ensureDevice();
    if (!this.appId) throw new Error("Android appId is required");
    await this.forceStop();
    if (clearData) await this.clearData();
    const resolved = await this.adb(["shell", "cmd", "package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", this.appId]);
    const component = String(resolved.stdout || "").split(/\r?\n/).map((s) => s.trim()).findLast((s) => s.includes("/"));
    if (!component) throw new Error(`No launchable Activity found for ${this.appId}`);
    const r = await this.adb(["shell", "am", "start", "-W", "-n", component], { timeout: 30_000 });
    if (r.code !== 0 || !/Status:\s*ok/i.test(String(r.stdout))) throw new Error((r.stderr || r.stdout || `Could not launch ${this.appId}`).trim());
    await sleep(600);
    return this.snapshot();
  }

  async currentActivity() {
    const activity = await this.adb(["shell", "dumpsys", "activity", "activities"]);
    const atext = String(activity.stdout || "");
    const resumed = (atext.match(/mResumedActivity:.*?\s([\w.$]+\/[\w.$]+)/) || atext.match(/topResumedActivity=.*?\s([\w.$]+\/[\w.$]+)/) || [])[1];
    if (resumed) return resumed;
    const window = await this.adb(["shell", "dumpsys", "window", "windows"]);
    const wtext = String(window.stdout || "");
    return (wtext.match(/mCurrentFocus=.*?\s([\w.$]+\/[\w.$]+)/) || wtext.match(/mFocusedApp=.*?\s([\w.$]+\/[\w.$]+)/) || [])[1] || "";
  }

  async dumpXml() {
    let r = await this.adb(["exec-out", "uiautomator", "dump", "/dev/tty"], { timeout: 20_000, maxBuffer: 24 * 1024 * 1024 });
    let output = String(r.stdout || "");
    let at = output.indexOf("<?xml");
    if (r.code !== 0 || at < 0) {
      const remote = `/sdcard/tapp-window-${process.pid}.xml`;
      await this.adb(["shell", "uiautomator", "dump", remote], { timeout: 20_000 });
      r = await this.adb(["exec-out", "cat", remote], { timeout: 20_000, maxBuffer: 24 * 1024 * 1024 });
      await this.adb(["shell", "rm", "-f", remote]);
      output = String(r.stdout || "");
      at = output.indexOf("<?xml");
    }
    if (at < 0) throw new Error((r.stderr || "UIAutomator produced no XML hierarchy").trim());
    return output.slice(at);
  }

  async snapshot() {
    const [xml, activity] = await Promise.all([this.dumpXml(), this.currentActivity()]);
    const elements = parseUiAutomatorXml(xml);
    return { screenTitle: detectAndroidScreen(elements, activity), elements, activity, xml };
  }

  async screenshot(filePath) {
    const r = await this.adb(["exec-out", "screencap", "-p"], { encoding: "buffer", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    if (r.code !== 0 || !r.stdout?.length) throw new Error("Android screenshot failed");
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, r.stdout);
    }
    return r.stdout;
  }

  async settle(timeoutMs = 2200) {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stable = 0;
    let latest;
    while (Date.now() < deadline) {
      latest = await this.snapshot();
      const fingerprint = latest.elements.map((e) => `${androidElementKey(e)}:${e.text}:${e.x},${e.y}`).join("|");
      if (fingerprint === previous) stable += 1; else stable = 0;
      if (stable >= 1) return latest;
      previous = fingerprint;
      await sleep(180);
    }
    return latest || this.snapshot();
  }

  async tap(target, snapshot) {
    const snap = snapshot || await this.snapshot();
    const element = findAndroidElement(snap.elements, target, { hittable: true });
    if (!element) return { status: "not_found", detail: `could not find ‘${target}’` };
    const x = Math.round(element.x + element.w / 2);
    const y = Math.round(element.y + element.h / 2);
    const r = await this.adb(["shell", "input", "tap", String(x), String(y)]);
    return r.code === 0 ? { status: "ok", element } : { status: "not_hittable", detail: String(r.stderr || "tap failed") };
  }

  async type(target, value, snapshot) {
    const snap = snapshot || await this.snapshot();
    const element = target ? findAndroidElement(snap.elements, target, { hittable: true }) : snap.elements.find((e) => e.focused);
    if (!element) return { status: "not_found", detail: `no field ‘${target}’ to type into` };
    await this.tap(androidElementKey(element), snap);
    await this.adb(["shell", "input", "keyevent", "KEYCODE_MOVE_END"]);
    await this.adb(["shell", "input", "keyevent", "--longpress", "KEYCODE_DEL"]);
    // ADB input uses %s for spaces. Keep it as an argv value so the shell never
    // interprets credentials or punctuation.
    const encoded = String(value).replaceAll("%", "%25").replaceAll(" ", "%s");
    const r = await this.adb(["shell", "input", "text", encoded]);
    return r.code === 0 ? { status: "ok", element } : { status: "not_hittable", detail: String(r.stderr || "type failed") };
  }

  async back() { await this.adb(["shell", "input", "keyevent", "KEYCODE_BACK"]); return { status: "ok" }; }

  async swipe(direction = "up") {
    const points = {
      up: [540, 1500, 540, 500], down: [540, 500, 540, 1500],
      left: [900, 1000, 180, 1000], right: [180, 1000, 900, 1000],
    }[direction.toLowerCase()] || [540, 1500, 540, 500];
    await this.adb(["shell", "input", "swipe", ...points.map(String), "250"]);
    return { status: "ok" };
  }

  async waitFor(target, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snap = await this.snapshot();
      if (snap.screenTitle.toLowerCase() === String(target).toLowerCase() || findAndroidElement(snap.elements, target)) return snap;
      await sleep(250);
    }
    return null;
  }
}

export function androidCaptureDir(prefix = "android") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tapp-${prefix}-`));
}

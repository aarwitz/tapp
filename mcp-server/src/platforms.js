// Every surface tapp aims at, and whether THIS Studio can drive it.
//
// tapp is not a web tool. The engine drives websites, iOS simulators and Android devices, and the
// Studio in `browser/` is the same program wherever it runs — on a laptop it can start an iOS run,
// and on a Linux box in a data centre it cannot, because there is no Mac attached to it.
//
// The product used to leave that implicit: the hosted Studio answered an .app with a bare 400,
// and nothing anywhere said that tapp drives phones at all. Someone arriving at app.runtapp.com
// reasonably concluded it was a website checker.
//
// So this module is the one place that answers, for a given host: what can tapp drive, what does
// each one need, and what should this person do next. Every state below is computed from the
// machine the Studio is on — never declared — and a platform with no driver says so in those
// words. Nothing here may describe a capability that does not exist.
import fs from "node:fs";
import path from "node:path";

import { resolveAdbPath } from "./android-driver.js";

/**
 * The states a platform can be in, worst-named-first so nobody mistakes one for another:
 *
 *   ready         — this Studio can start a run now.
 *   needs-machine — tapp drives it, but not from this host. There is an exact command for the
 *                   machine that can, because self-hosting is the same product, not a lesser one.
 *   pilot         — tapp does NOT drive it yet. No driver exists. Early work is done with a
 *                   person while the driver lands (owner decision, 2026-09-14, for Windows).
 */
export const PLATFORM_STATES = Object.freeze(["ready", "needs-machine", "pilot"]);

/** What tapp aims at, in the order a person should see them. */
export const PLATFORM_TARGETS = Object.freeze([
  {
    id: "web", label: "Web", give: "A website URL",
    driver: "playwright", needs: "Playwright and Chromium, which tapp installs",
    machine: "any machine",
  },
  {
    id: "ios", label: "iOS", give: "A simulator .app or a bundle id",
    driver: "xcuitest", needs: "macOS with Xcode",
    machine: "a Mac with Xcode",
  },
  {
    id: "android", label: "Android", give: "An .apk or a connected device",
    driver: "adb", needs: "the Android SDK and adb",
    machine: "a machine with the Android SDK",
  },
  {
    id: "macos", label: "macOS app", give: "A .app on your Mac",
    driver: null, needs: "macOS",
    machine: "a Mac",
  },
  {
    id: "windows", label: "Windows app", give: "A WPF, WinForms or WinUI app",
    driver: null, needs: "Windows",
    machine: "a Windows machine",
  },
]);

// "A simulator .app" mid-sentence, without lowercasing the file extension or the brand.
const lower = (text) => String(text).replace(/^(An?|The) /, (word) => word.toLowerCase());

const onPath = (name, env) => String(env.PATH || "").split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, name)));

/**
 * What this machine actually has. The same checks `runnerSummary` used, in one place, so the
 * Studio and the runner list can never disagree about whether Xcode is installed.
 */
export function hostToolchain({ env = process.env, platform = process.platform } = {}) {
  return {
    ios: platform === "darwin" && (fs.existsSync("/usr/bin/xcodebuild") || onPath("xcodebuild", env)),
    // The driver's own resolver, not a PATH guess: the SDK is commonly an unlinked Homebrew
    // cask with ANDROID_HOME unset, and the Studio must not say "no Android" about a machine
    // where `tapp explore` would happily find adb.
    android: platform === "linux" || platform === "darwin" || platform === "win32" ? Boolean(resolveAdbPath(env)) : false,
    // Chromium is fetched on demand, so web is reachable from any host; whether this particular
    // one has it unpacked is checked when the run starts, which is where the error belongs.
    web: true,
  };
}

/** The command that opens this same Studio on a machine that can do the work. */
export const SELF_HOST_COMMAND = "npx -y @aarwitz/tapp@latest app";

/**
 * The honest state of every platform for one host.
 *
 * @param {object} options
 * @param {boolean} options.hosted  true for app.runtapp.com, false for `tapp app` on a laptop
 */
export function platformStates({ hosted = false, env = process.env, platform = process.platform, toolchain = null } = {}) {
  const has = toolchain || hostToolchain({ env, platform });
  return PLATFORM_TARGETS.map((target) => {
    // No driver is no driver, on any host. This must never read as "you need a different machine",
    // because buying the machine would not help.
    if (!target.driver) {
      return {
        ...target,
        state: "pilot",
        summary: `tapp has no ${target.label} driver yet.`,
        how: `Early ${target.label} work is done with us while the driver lands. Tell us about yours and we will run it with you.`,
        command: "",
      };
    }
    // A public Studio starts website runs and nothing else, whatever the machine under it
    // happens to own (ADR-0008). Saying "ready" because this particular host has Xcode would
    // promise a run the server then refuses — so the deployment has a say, not just the disk.
    const exposed = hosted ? target.id === "web" : true;
    if (has[target.id] && exposed) {
      return {
        ...target,
        state: "ready", because: "",
        summary: hosted ? `Ready here. ${target.give}.` : `Ready on this machine. ${target.give}.`,
        how: `Paste ${lower(target.give)} in the box above.`,
        command: "",
      };
    }
    const because = has[target.id] && !exposed ? "not-exposed" : "no-toolchain";
    return {
      ...target,
      state: "needs-machine", because,
      summary: because === "not-exposed"
        ? `tapp drives ${target.label}, and this machine could — but a public Studio only starts website runs.`
        : `tapp drives ${target.label}, but this Studio is not on ${target.machine}.`,
      // Self-host is the same product without the hosting, so the answer is a command, not an
      // apology (ADR-0006).
      how: `Run this Studio on ${target.machine} and give it ${lower(target.give)} there:`,
      command: SELF_HOST_COMMAND,
    };
  });
}

/** One platform's state, by id. */
export function platformState(id, options = {}) {
  return platformStates(options).find((entry) => entry.id === String(id)) || null;
}

/** The platforms this Studio can start a run on right now. */
export function readyPlatforms(options = {}) {
  return platformStates(options).filter((entry) => entry.state === "ready").map((entry) => entry.id);
}

/**
 * The answer to "I gave you an .app and you are a Linux box": where it runs, and how to get there.
 * Shaped like every other self-host answer the Studio already knows how to show.
 */
export function selfHostAnswer(platformId, target = "", options = {}) {
    const entry = platformState(platformId, options);
  if (!entry) return null;
  const what = target ? `“${target}”` : `a ${entry.label} target`;
  if (entry.state === "pilot") {
    return { kind: "self-host", platform: entry.id, state: entry.state, target,
      message: `${what} is a ${entry.label} target, and tapp has no ${entry.label} driver yet. ${entry.how}`, command: "" };
  }
  return { kind: "self-host", platform: entry.id, state: entry.state, target,
    message: `Running ${what} needs ${entry.machine}, which this Studio is not on. Start the Studio there: ${SELF_HOST_COMMAND}`,
    command: SELF_HOST_COMMAND };
}

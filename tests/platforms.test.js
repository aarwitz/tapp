import test from "node:test";
import assert from "node:assert/strict";

import { PLATFORM_TARGETS, PLATFORM_STATES, SELF_HOST_COMMAND, hostToolchain, platformState, platformStates, readyPlatforms, selfHostAnswer } from "../mcp-server/src/platforms.js";
import { customerProductContract } from "../browser/product-contract.js";

// A Linux box in a data centre: no Xcode, no adb. This is app.runtapp.com.
const CLOUD = { hosted: true, platform: "linux", toolchain: { web: true, ios: false, android: false } };
// A developer's Mac with the lot installed.
const LAPTOP = { hosted: false, platform: "darwin", toolchain: { web: true, ios: true, android: true } };

test("the hosted Studio says what tapp drives, not only what it can start", () => {
  const states = Object.fromEntries(platformStates(CLOUD).map((entry) => [entry.id, entry.state]));
  assert.deepEqual(states, { web: "ready", ios: "needs-machine", android: "needs-machine", macos: "pilot", windows: "pilot" });
  assert.deepEqual(readyPlatforms(CLOUD), ["web"], "only web can actually start there");
  // The whole point: iOS is present and described, not deleted. Erasing it is what made a
  // cross-platform product read as a website checker.
  const ios = platformState("ios", CLOUD);
  assert.match(ios.summary, /tapp drives iOS/);
  assert.equal(ios.command, SELF_HOST_COMMAND, "and the answer is a command, not an apology");
});

test("a laptop runs almost all of it, and says so", () => {
  const states = Object.fromEntries(platformStates(LAPTOP).map((entry) => [entry.id, entry.state]));
  assert.deepEqual(states, { web: "ready", ios: "ready", android: "ready", macos: "pilot", windows: "pilot" });
  assert.deepEqual(readyPlatforms(LAPTOP), ["web", "ios", "android"]);
  assert.equal(platformState("ios", LAPTOP).command, "", "nothing to go and do");
});

test("a platform with no driver never reads as a hardware problem the reader could fix", () => {
  // Buying a Windows machine would not help: there is no driver. Saying "needs your machine"
  // here would be a lie that costs somebody a laptop.
  for (const id of ["windows", "macos"]) {
    const entry = platformState(id, LAPTOP);
    assert.equal(entry.state, "pilot");
    assert.match(entry.summary, /no .* driver yet/i);
    assert.equal(entry.command, "", "there is no command that would make it work");
    assert.doesNotMatch(`${entry.summary} ${entry.how}`, /install|needs a Mac|needs a machine with/i);
  }
  // And it stays "pilot" on a Mac and on Windows alike, because the host is not the problem.
  assert.equal(platformState("windows", { hosted: false, platform: "win32", toolchain: { web: true, ios: false, android: true } }).state, "pilot");
});

test("every platform tapp has a driver for is one the contract declares, and vice versa", () => {
  const driven = PLATFORM_TARGETS.filter((target) => target.driver).map((target) => target.id).sort();
  assert.deepEqual(driven, [...customerProductContract.targetPlatforms].sort(),
    "targetPlatforms is what the engine can drive; a platform listed there must have a driver");
  for (const target of PLATFORM_TARGETS) assert.ok(target.label && target.give && target.machine, `${target.id} must say what it is and what it takes`);
  for (const entry of platformStates(CLOUD)) assert.ok(PLATFORM_STATES.includes(entry.state), `${entry.id}: ${entry.state} is not a state`);
});

test("the answer to a target this Studio cannot start says where it runs", () => {
  const ios = selfHostAnswer("ios", "/Users/me/Build/App.app", CLOUD);
  assert.equal(ios.kind, "self-host");
  assert.equal(ios.platform, "ios");
  assert.match(ios.message, /App\.app/);
  assert.match(ios.message, /a Mac with Xcode/);
  assert.match(ios.message, /npx -y @aarwitz\/tapp@latest app/);
  // A pilot platform is answered differently: no command, because none would work.
  const windows = selfHostAnswer("windows", "Ledger.exe", CLOUD);
  assert.equal(windows.command, "");
  assert.match(windows.message, /no Windows app driver yet/i);
  assert.equal(selfHostAnswer("nonsense", "", CLOUD), null);
});

test("the toolchain probe is the one the engine uses, so the Studio cannot contradict a run", () => {
  // An unlinked Homebrew SDK with ANDROID_HOME unset is the normal case on a Mac, and a PATH
  // check calls it "no Android" on a machine where `tapp explore --platform android` works.
  const found = hostToolchain({ env: { ANDROID_SDK_ROOT: "/nope" }, platform: "linux" });
  assert.equal(typeof found.android, "boolean");
  assert.equal(found.web, true, "Chromium is fetched on demand; the run reports what the run finds");
  assert.equal(hostToolchain({ env: {}, platform: "linux" }).ios, false, "iOS is macOS-only, as a fact about Xcode");
});

test("a public Studio never promises a run its own rules will refuse", () => {
  // A public Studio on a Mac has Xcode under it, but ADR-0008 lets a visitor start website
  // runs and nothing else. Reporting iOS as "ready" there would promise a run the server
  // answers with "run this on your machine" — the UI and the handler must agree.
  const publicMac = { hosted: true, platform: "darwin", toolchain: { web: true, ios: true, android: true } };
  const ios = platformState("ios", publicMac);
  assert.equal(ios.state, "needs-machine");
  assert.equal(ios.because, "not-exposed", "and it says the honest reason, not 'no Xcode here'");
  assert.match(ios.summary, /this machine could/);
  assert.deepEqual(readyPlatforms(publicMac), ["web"]);
  // The same machine, run as somebody's own Studio, starts all three.
  assert.deepEqual(readyPlatforms({ ...publicMac, hosted: false }), ["web", "ios", "android"]);
});

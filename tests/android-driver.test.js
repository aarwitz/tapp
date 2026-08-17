import test from "node:test";
import assert from "node:assert/strict";
import { AndroidDriver, detectAndroidScreen, findAndroidElement, isAndroidAppSnapshot, parseLatestAndroidCrashExitInfo, parseUiAutomatorXml } from "../mcp-server/src/android-driver.js";

const XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="io.github.aarwitz.tapp.demo" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,1920]">
    <node index="0" text="Dashboard" resource-id="io.github.aarwitz.tapp.demo:id/screen_title" class="android.widget.TextView" package="io.github.aarwitz.tapp.demo" content-desc="" clickable="false" enabled="true" bounds="[32,80][600,180]" />
    <node index="1" text="Continue" resource-id="io.github.aarwitz.tapp.demo:id/continue_button" class="android.widget.Button" package="io.github.aarwitz.tapp.demo" content-desc="continue_primary" clickable="true" enabled="true" bounds="[100,300][900,430]" />
  </node>
</hierarchy>`;

test("UIAutomator XML becomes the shared accessibility element shape", () => {
  const elements = parseUiAutomatorXml(XML);
  assert.equal(elements.length, 3);
  const button = findAndroidElement(elements, "continue_button", { hittable: true });
  assert.equal(button.text, "Continue");
  assert.equal(button.clickable, true);
  assert.deepEqual({ x: button.x, y: button.y, w: button.w, h: button.h }, { x: 100, y: 300, w: 800, h: 130 });
  assert.equal(detectAndroidScreen(elements), "Dashboard");
});

test("Android selection prefers stable ids then accessibility descriptions and labels", () => {
  const elements = parseUiAutomatorXml(XML);
  assert.equal(findAndroidElement(elements, "io.github.aarwitz.tapp.demo:id/continue_button").text, "Continue");
  assert.equal(findAndroidElement(elements, "continue_primary").text, "Continue");
  assert.equal(findAndroidElement(elements, "continue").text, "Continue");
});

test("Android ownership rejects a stale activity paired with another app's UI tree", () => {
  assert.equal(isAndroidAppSnapshot({
    activity: "io.tapp.corpus.demo/.MainActivity",
    elements: [{ package: "io.tapp.corpus.shop", text: "Order Confirmed" }],
  }, "io.tapp.corpus.demo"), false);
  assert.equal(isAndroidAppSnapshot({
    activity: "io.tapp.corpus.demo/.MainActivity",
    elements: [{ package: "io.tapp.corpus.demo", text: "Dashboard" }],
  }, "io.tapp.corpus.demo"), true);
});

test("Android exit history selects the latest real crash instead of a newer non-crash exit", () => {
  const history = `ApplicationExitInfo #0:
    timestamp=2026-08-17 01:55:56.196 pid=18132 realUid=10207
    process=io.tapp.demo reason=9 (EXCESSIVE RESOURCE USAGE)
  ApplicationExitInfo #1:
    timestamp=2026-08-17 01:55:32.728 pid=17985 realUid=10207
    process=io.tapp.demo reason=4 (APP CRASH(EXCEPTION))`;
  assert.equal(parseLatestAndroidCrashExitInfo(history), "2026-08-17 01:55:32.728|17985|4");
  assert.equal(parseLatestAndroidCrashExitInfo("reason=16 (PACKAGE UPDATED)"), null);
});

test("Android launch retries a mixed activity/UI snapshot until app ownership agrees", async () => {
  const driver = Object.create(AndroidDriver.prototype);
  driver.appId = "io.tapp.login";
  let calls = 0;
  driver.snapshot = async () => {
    calls += 1;
    return calls === 1 ? {
      activity: "io.tapp.login/.MainActivity",
      elements: [{ package: "io.tapp.other", text: "stale app surface" }],
    } : {
      activity: "io.tapp.login/.MainActivity",
      elements: [{ package: "io.tapp.login", text: "Sign In" }],
    };
  };
  const snapshot = await driver.waitForOwnedSnapshot(1_000);
  assert.equal(calls, 3);
  assert.equal(isAndroidAppSnapshot(snapshot, driver.appId), true);
});

test("Android launch dismisses a stale system crash surface before accepting ownership", async () => {
  const driver = Object.create(AndroidDriver.prototype);
  driver.appId = "io.tapp.login";
  let calls = 0;
  let dismissals = 0;
  driver.closeSystemDialogs = async () => { dismissals += 1; };
  driver.snapshot = async () => {
    calls += 1;
    if (calls === 1) return {
      activity: "io.tapp.login/.MainActivity",
      elements: [{ package: "android", text: "Tapp corpus keeps stopping" }],
    };
    return {
      activity: "io.tapp.login/.MainActivity",
      elements: [{ package: "io.tapp.login", text: "Sign In" }],
    };
  };
  const snapshot = await driver.waitForOwnedSnapshot(1_000);
  assert.equal(dismissals, 1);
  assert.equal(calls, 3);
  assert.equal(isAndroidAppSnapshot(snapshot, driver.appId), true);
});

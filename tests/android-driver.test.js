import test from "node:test";
import assert from "node:assert/strict";
import { detectAndroidScreen, findAndroidElement, isAndroidAppSnapshot, parseUiAutomatorXml } from "../mcp-server/src/android-driver.js";

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

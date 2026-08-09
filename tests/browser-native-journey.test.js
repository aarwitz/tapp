import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBrowserProduct } from "../mcp-server/src/browser-product.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let chromium;
try { ({ chromium } = await import("playwright")); } catch {}

test("browser opens, drives, captures, and records the real iOS target", {
  skip:process.platform !== "darwin" || process.env.TAPP_RUN_NATIVE_BROWSER !== "1" || !chromium,
  timeout:8 * 60_000,
}, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-browser-native-"));
  const project = path.join(workspace, "DemoApp");
  fs.cpSync(path.join(repository, "DemoApp"), project, { recursive:true });
  const priorHome = process.env.TAPP_HOME;
  process.env.TAPP_HOME = path.join(workspace, "tapp-home");
  const product = await startBrowserProduct({ projectDir:project, launch:false });
  const browser = await chromium.launch({ headless:true });
  const page = await browser.newPage({ viewport:{ width:1440, height:1000 } });
  const operate = async (selector, timeout = 7 * 60_000) => {
    await page.locator(selector).click();
    await page.locator("#operation-drawer").waitFor({ state:"visible", timeout:5000 });
    await page.locator("#operation-drawer").waitFor({ state:"hidden", timeout });
  };
  try {
    await page.goto(product.launchUrl, { waitUntil:"networkidle" });
    await page.locator("#targets .target-card").waitFor({ state:"visible", timeout:30_000 });
    assert.match(await page.locator("#targets").innerText(), /iOS/);
    await operate("#explore");
    assert.match(await page.locator("#map-metric").innerText(), /\d+ states · \d+ transitions/);
    assert.doesNotMatch(await page.locator("#map-metric").innerText(), /^0 states/);
    await operate("#start-session");
    await page.locator("#live-session-panel").waitFor({ state:"visible" });
    await page.waitForFunction(() => document.querySelector("#live-frame-image")?.naturalWidth > 0, null, { timeout:30_000 });
    const jump = page.locator("#live-control-list .live-control").filter({ hasText:"Jump to Tasks" }).first();
    assert.equal(await jump.isVisible(), true);
    await jump.click();
    await page.locator("#operation-drawer").waitFor({ state:"visible", timeout:5000 });
    await page.locator("#operation-drawer").waitFor({ state:"hidden", timeout:90_000 });
    assert.match(await page.locator("#live-screen-title").innerText(), /Todo List/);
    await page.locator("#live-flow-name").fill("Open task list from onboarding");
    await operate("#save-live-flow", 30_000);
    const flow = path.join(project, ".autotap", "flows", "open-task-list-from-onboarding.yml");
    assert.equal(fs.existsSync(flow), true);
    assert.doesNotMatch(fs.readFileSync(flow, "utf8"), /platform: web|platform: android/);
    await page.locator("#live-frame-loading").waitFor({ state:"hidden", timeout:30_000 });
    const controlLabels = await page.locator("#live-control-list .live-control strong").allTextContents();
    assert.equal(controlLabels.filter((label) => label === "Open Counter Playground").length, 1);
    await page.screenshot({ path:path.join(workspace, "browser-native-proof.png"), fullPage:true });
    await operate("#end-session", 60_000);
  } finally {
    await browser.close();
    await product.close();
    if (priorHome === undefined) delete process.env.TAPP_HOME;
    else process.env.TAPP_HOME = priorHome;
  }
});

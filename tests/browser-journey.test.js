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

function commerceFixture() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-browser-journey-"));
  for (const file of ["package.json", "index.html", "app.js", "styles.css", "server.js"]) fs.copyFileSync(path.join(repository, "CommerceDemo", file), path.join(project, file));
  fs.mkdirSync(path.join(project, ".tapp"), { recursive: true });
  fs.cpSync(path.join(repository, "CommerceDemo", ".tapp", "tasks"), path.join(project, ".tapp", "tasks"), { recursive: true });
  fs.copyFileSync(path.join(repository, "CommerceDemo", ".tapp", "project.json"), path.join(project, ".tapp", "project.json"));
  return project;
}

// The Studio is a run viewer (ADR-0006, owner decision 2026-10-15): open a repository, choose the
// target, explore it, drive it live, keep a Flow, run the gate, and read every run's evidence.
test("browser journey: target, exploration, live session, saved Flow, gate, and the runs list", { skip: !chromium, timeout: 180_000 }, async () => {
  const project = commerceFixture();
  const priorHome = process.env.TAPP_HOME;
  process.env.TAPP_HOME = path.join(project, "tapp-home");
  const product = await startBrowserProduct({ projectDir: project, launch: false });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const operate = async (selector, timeout = 120_000) => {
    await page.locator(selector).click();
    await page.locator("#operation-drawer").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#operation-drawer").waitFor({ state: "hidden", timeout });
  };
  try {
    await page.goto(product.launchUrl, { waitUntil: "networkidle" });
    await page.locator("#targets .target-card").waitFor({ state:"visible", timeout:30_000 });
    assert.match(await page.locator("body").innerText(), /Choose the product target/);
    assert.match(await page.locator("body").innerText(), /Web/);
    // The removed views are gone, not hidden.
    for (const id of ["contracts", "coverage", "settings", "findings"]) assert.equal(await page.locator(`.primary-nav [data-view="${id}"]`).count(), 0, `${id} view removed`);
    assert.equal(await page.locator("#folder-input").count(), 0, "no upload path");

    await operate("#explore");
    assert.match(await page.locator("#chat-transcript").innerText(), /Starting a release check/);
    assert.match(await page.locator("#chat-transcript").innerText(), /[👆📍🧭⌨️🌐📱]/u, "the chat narrates with emoji-led lines");
    assert.equal(await page.locator("#chat-float").isVisible(), true);
    assert.match(await page.locator("#chat-transcript").innerText(), /not a release decision/, "exploration ends with an observation, never a verdict");
    assert.match(await page.locator("#chat-transcript").innerText(), /report\.html/, "the report is attached");
    await operate("#start-session");
    await page.locator("#live-session-panel").waitFor({ state:"visible" });
    await page.waitForFunction(() => document.querySelector("#live-frame-image")?.naturalWidth > 0);
    const liveBuy = page.locator("#live-control-list .live-control").filter({ hasText:"Buy Tapp Pro Plan" }).first();
    assert.equal(await liveBuy.isVisible(), true);
    await liveBuy.click();
    await page.locator("#operation-drawer").waitFor({ state:"visible", timeout:5000 });
    await page.locator("#operation-drawer").waitFor({ state:"hidden", timeout:30_000 });
    assert.match(await page.locator("#live-screen-title").innerText(), /Cart/);
    await page.locator("#live-flow-name").fill("Open checkout cart");
    await operate("#save-live-flow");
    const recordedFlow = path.join(project, ".tapp", "flows", "open-checkout-cart.yml");
    assert.equal(fs.existsSync(recordedFlow), true);
    assert.match(fs.readFileSync(recordedFlow, "utf8"), /platform: web/);
    assert.doesNotMatch(fs.readFileSync(recordedFlow, "utf8"), /127\.0\.0\.1:\d+/, "managed runtime ports are not committed");
    await operate("#end-session");
    await page.locator("#live-session-panel").waitFor({ state:"hidden" });

    await page.locator('.primary-nav [data-view="runs"]').click();
    await operate("#run-gate");
    const decision = await page.locator("#decision-title").innerText();
    assert.match(decision, /Ready to merge|Do not merge|Inconclusive/, "the decision card shows the gate outcome, never a score");
    assert.ok(await page.locator("#runs-list .run-row").count() >= 1, "the gate run is listed");
    const detail = await page.locator("#run-detail").innerText();
    assert.match(detail, /Decision rationale/);
    assert.match(detail, /Visual report/, "every run links to the report page the engine wrote");
    await page.screenshot({ path: path.join(process.env.TAPP_HOME, "release-studio.png"), fullPage: true });
  } finally {
    await browser.close();
    await product.close();
    if (priorHome === undefined) delete process.env.TAPP_HOME;
    else process.env.TAPP_HOME = priorHome;
  }
});

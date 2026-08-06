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
  fs.mkdirSync(path.join(project, ".autotap"), { recursive: true });
  fs.cpSync(path.join(repository, "CommerceDemo", ".autotap", "tasks"), path.join(project, ".autotap", "tasks"), { recursive: true });
  fs.copyFileSync(path.join(repository, "CommerceDemo", ".autotap", "project.json"), path.join(project, ".autotap", "project.json"));
  return project;
}

test("browser journey completes onboarding, map review, contract promotion, baseline, evidence, and CI preview", { skip: !chromium, timeout: 180_000 }, async () => {
  const project = commerceFixture();
  const priorHome = process.env.AUTOTAP_HOME;
  process.env.AUTOTAP_HOME = path.join(project, "tapp-home");
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
    await operate("#explore");
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
    const recordedFlow = path.join(project, ".autotap", "flows", "open-checkout-cart.yml");
    assert.equal(fs.existsSync(recordedFlow), true);
    assert.match(fs.readFileSync(recordedFlow, "utf8"), /platform: web/);
    assert.doesNotMatch(fs.readFileSync(recordedFlow, "utf8"), /127\.0\.0\.1:\d+/, "managed runtime ports are not committed");
    await operate("#end-session");
    await page.locator("#live-session-panel").waitFor({ state:"hidden" });
    await page.locator('.primary-nav [data-view="coverage"]').click();
    await page.locator("#map-metric").waitFor({ state: "visible" });
    assert.match(await page.locator("#map-metric").innerText(), /5 states · 4 transitions/);

    await page.locator('.primary-nav [data-view="contracts"]').click();
    const proposals = page.locator("#plan-list .plan-item");
    assert.ok(await proposals.count() >= 1);
    for (let index = 0; index < await proposals.count(); index += 1) {
      const item = proposals.nth(index);
      const text = await item.innerText();
      await item.locator("select").selectOption(text.includes("Checkout creates an order that remains in order history") ? "approved" : "deferred");
    }
    await operate("#save-review");
    await operate("#generate");
    assert.match(await page.locator("#validation-status").innerText(), /untrusted draft/);
    await operate("#validate-drafts");
    assert.match(await page.locator("#validation-status").innerText(), /Validated drafts available/);
    await operate("#promote");
    assert.equal(fs.existsSync(path.join(project, ".autotap", "contracts", "checkout-creates-durable-order.contract.ts")), true);
    const promotedModel = JSON.parse(fs.readFileSync(path.join(project, ".autotap", "application-model.json"), "utf8"));
    assert.equal(promotedModel.requirements.some((item) => item.id === "contracts"), false, "promotion refreshes canonical product readiness");
    assert.equal(promotedModel.artifacts.contracts.some((item) => item.name === "checkoutCreatesDurableOrder"), true);
    const promotedPlan = JSON.parse(fs.readFileSync(path.join(project, ".autotap", "release-plan.json"), "utf8"));
    assert.match(promotedPlan.items.find((item) => item.name === "checkoutCreatesDurableOrder").generation.realValidation.web.evidence, /^tapp-capture:flow-web-/);
    assert.doesNotMatch(await page.locator("#connect").innerText(), /No reviewed release contracts exist yet/);
    assert.match(await page.locator("#validation-status").innerText(), /Promoted suite ready/);
    assert.doesNotMatch(await page.locator("#artifact-list").innerText(), /Draft/);
    assert.equal(await page.locator("#promote").isDisabled(), true);

    await page.locator('.primary-nav [data-view="runs"]').click();
    await operate("#run-gate");
    assert.match(await page.locator("#decision-title").innerText(), /Ready to merge/);
    await page.locator('.primary-nav [data-view="settings"]').click();
    assert.equal(await page.locator("#create-baseline").isEnabled(), true);
    await operate("#create-baseline");
    assert.equal(fs.existsSync(path.join(project, ".autotap", "baselines", "web")), true);
    await page.locator('.primary-nav [data-view="runs"]').click();
    await operate("#run-gate");
    await page.locator('.primary-nav [data-view="settings"]').click();
    assert.match(await page.locator("#latest-evidence").innerText(), /0 new vs baseline/);
    await operate("#preview-ci");
    assert.match(await page.locator("#ci-preview").innerText(), /Tapp release gate/);
    await page.screenshot({ path: path.join(process.env.AUTOTAP_HOME, "release-studio.png"), fullPage: true });
  } finally {
    await browser.close();
    await product.close();
    if (priorHome === undefined) delete process.env.AUTOTAP_HOME;
    else process.env.AUTOTAP_HOME = priorHome;
  }
});

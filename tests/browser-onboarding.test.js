import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startBrowserProduct } from "../mcp-server/src/browser-product.js";
import { productJourneyFlags } from "../browser/view-model.js";

let chromium;
try { ({ chromium } = await import("playwright")); } catch {}

function webRepository(prefix, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><h1>${name}</h1>`);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }));
  return root;
}

function multiTargetRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-visible-multi-target-"));
  fs.writeFileSync(path.join(root, "settings.gradle"), "include ':consumer', ':merchant'\n");
  fs.writeFileSync(path.join(root, "gradlew"), "#!/bin/sh\n");
  for (const [module, applicationId] of [["consumer", "com.acme.consumer"], ["merchant", "com.acme.merchant"]]) {
    fs.mkdirSync(path.join(root, module), { recursive:true });
    fs.writeFileSync(path.join(root, module, "build.gradle"), `plugins { id 'com.android.application' }\nandroid { defaultConfig { applicationId '${applicationId}' } }\n`);
  }
  return root;
}

test("committed contracts do not mark current-revision keyless validation complete", () => {
  const flags = productJourneyFlags({
    status:{ explored:true, reviewComplete:false, validated:false, promoted:true },
    hasTarget:true,
    hasEvidence:false,
  });
  assert.deepEqual(flags, [true, true, true, false, false, false]);
});

test("visible source chooser converges folder and GitHub imports into the same product journey", { skip:!chromium, timeout:60_000 }, async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-visible-onboarding-workspaces-"));
  const folder = webRepository("tapp-visible-folder-", "folder-product");
  const githubProvider = {
    async list() { return [{ nameWithOwner:"acme/github-product", name:"github-product", defaultBranch:"main", private:true, permission:"WRITE" }]; },
    async clone(_name, destination) {
      fs.mkdirSync(destination, { recursive:true });
      fs.writeFileSync(path.join(destination, "index.html"), "<!doctype html><h1>GitHub product</h1>");
      fs.writeFileSync(path.join(destination, "package.json"), JSON.stringify({ name:"github-product" }));
    },
  };
  const product = await startBrowserProduct({ workspaceRoot, githubProvider, launch:false });
  const browser = await chromium.launch({ headless:true });
  const page = await browser.newPage();
  try {
    await page.goto(product.launchUrl, { waitUntil:"networkidle" });
    assert.match(await page.locator("#source-onboarding").innerText(), /Drop a project folder/);
    assert.match(await page.locator("#source-onboarding").innerText(), /Connect to GitHub/);

    await page.locator("#folder-input").setInputFiles(folder);
    await page.locator("#targets .target-card").waitFor({ state:"visible", timeout:30_000 });
    await page.waitForFunction(() => document.querySelector("#operation-drawer")?.classList.contains("hidden") && !document.querySelector("#map-metric")?.textContent?.startsWith("0 states"), null, { timeout:30_000 });
    assert.match(await page.locator("#repository-detail").innerText(), /isolated (?:working copy|checkout)/i);
    assert.match(await page.locator("#targets").innerText(), /Web/);
    assert.doesNotMatch(await page.locator("#map-metric").innerText(), /^0 states/);

    await page.locator("#change-source").click();
    await page.locator("#connect-github").click();
    const githubRepository = page.locator('[data-github-repository="acme/github-product"]');
    await githubRepository.waitFor({ state:"visible" });
    await githubRepository.click();
    await page.waitForFunction(() => document.querySelector("#repository-title")?.textContent?.includes("acme/github-product"), null, { timeout:30_000 });
    await page.locator("#targets .target-card").waitFor({ state:"visible" });
    await page.waitForFunction(() => document.querySelector("#operation-drawer")?.classList.contains("hidden") && !document.querySelector("#map-metric")?.textContent?.startsWith("0 states"), null, { timeout:30_000 });
    assert.match(await page.locator("#repository-detail").innerText(), /isolated (?:working copy|checkout)/i);
    assert.doesNotMatch(await page.locator("#map-metric").innerText(), /^0 states/);
    const options = await page.locator("#repository-switcher option").allTextContents();
    assert.equal(options.some((value) => value.includes("local-folder-upload")), true);
    assert.equal(options.some((value) => value.includes("github")), true);
  } finally {
    await browser.close();
    await product.close();
  }
});

test("multiple detected applications require an explicit polished target choice", { skip:!chromium, timeout:30_000 }, async () => {
  const product = await startBrowserProduct({ workspaceRoot:fs.mkdtempSync(path.join(os.tmpdir(), "tapp-visible-multi-workspaces-")), launch:false });
  const browser = await chromium.launch({ headless:true });
  const page = await browser.newPage();
  try {
    await page.goto(product.launchUrl, { waitUntil:"networkidle" });
    await page.locator("#folder-input").setInputFiles(multiTargetRepository());
    await page.locator("#targets .target-card").first().waitFor({ state:"visible", timeout:20_000 });
    await page.waitForFunction(() => document.querySelector("#operation-drawer")?.classList.contains("hidden"));
    assert.equal(await page.locator("#targets .target-card").count(), 2);
    assert.match(await page.locator("#target-choice-callout").innerText(), /Nothing will build until you select a target/);
    assert.match(await page.locator("#target-status").innerText(), /Selection required/);
    assert.equal(await page.locator("#explore").isDisabled(), true);
    assert.match(await page.locator("#map-metric").innerText(), /^0 states/);
    await page.screenshot({ path:path.join(os.tmpdir(), "tapp-multi-target-proof.png"), fullPage:true });

    const selected = page.locator("#targets .target-card").first();
    await selected.click();
    assert.equal(await selected.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#target-choice-callout").isHidden(), true);
    assert.equal(await page.locator("#explore").isEnabled(), true);
    assert.match(await page.locator("#explore").innerText(), /Build & explore/);
    assert.match(await page.locator("#map-metric").innerText(), /^0 states/, "selecting a target does not silently start exploration");
  } finally {
    await browser.close();
    await product.close();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startBrowserProduct } from "../mcp-server/src/browser-product.js";
import { operationIsPending, productJourneyFlags } from "../browser/view-model.js";

let chromium;
try { ({ chromium } = await import("playwright")); } catch {}
const skipRealBrowser = process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1";

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

test("hosted operations remain pending while queued or leased to a runner", () => {
  assert.equal(operationIsPending("queued"), true);
  assert.equal(operationIsPending("claimed"), true);
  assert.equal(operationIsPending("running"), true);
  assert.equal(operationIsPending("completed"), false);
  assert.equal(operationIsPending("failed"), false);
});

// A fixture website with one defect, for the read-only audit path.
async function fixtureSite() {
  const http = await import("node:http");
  const server = http.createServer((request, response) => {
    if (request.url === "/missing.css") { response.writeHead(404); response.end("nope"); return; }
    response.writeHead(200, { "content-type":"text/html" });
    response.end('<!doctype html><title>Acme</title><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/missing.css"><body><h1>Acme</h1><a href="/">Home</a></body>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url:`http://127.0.0.1:${server.address().port}/` };
}

test("without a repository the Studio explains how to open one and audits a website read-only", { skip:skipRealBrowser || !chromium, timeout:90_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-visible-audit-home-"));
  const priorHome = process.env.TAPP_HOME;
  process.env.TAPP_HOME = home;
  const site = await fixtureSite();
  const product = await startBrowserProduct({ launch:false });
  let browser;
  try {
    browser = await chromium.launch({ headless:true });
    const page = await browser.newPage();
    await page.goto(product.launchUrl, { waitUntil:"networkidle" });
    const onboarding = await page.locator("#source-onboarding").innerText();
    assert.match(onboarding, /What should tapp test\?/);
    assert.match(onboarding, /folder on this Mac/, "a repository is opened from the machine, not uploaded");
    assert.doesNotMatch(onboarding, /Upload a project folder|Connect to GitHub/);
    assert.match(onboarding, /audit a website read-only/);
    assert.equal(await page.locator(".hero-device").count(), 1, "the empty state shows what tapp does");

    await page.locator("#prompt-input").fill(site.url);
    await page.locator("#prompt-start").click();
    await page.locator("#operation-drawer").waitFor({ state:"visible", timeout:5000 });
    await page.locator("#operation-drawer").waitFor({ state:"hidden", timeout:60_000 });
    const chat = await page.locator("#chat-transcript").innerText();
    assert.match(chat, /read-only — nothing will be clicked/, "the chat opens with what is about to happen");
    assert.match(chat, /1 issue found/i, "the chat ends with a summary pill");
    assert.match(chat, /report\.html/, "the report is attached to the transcript");
    assert.equal(await page.locator("#device-frame.web").count(), 1, "the stage takes the browser's aspect ratio for a website");
    await page.locator('.primary-nav [data-view="runs"]').click();
    await page.locator("#runs-list .run-row").first().waitFor({ state:"visible" });
    const row = await page.locator("#runs-list .run-row").first().innerText();
    assert.match(row, /Audit · 127\.0\.0\.1/);
    assert.match(row, /read-only/);
    assert.match(row, /1 issue/i);
    const detail = await page.locator("#run-detail").innerText();
    assert.match(detail, /READ-ONLY AUDIT/);
    assert.match(detail, /404 asset: \/missing\.css/);
    assert.match(detail, /nothing was clicked/i);
    assert.match(detail, /Visual report/);
    const captures = fs.readdirSync(path.join(home, "captures")).filter((name) => name.startsWith("web-audit-"));
    assert.equal(captures.length, 1, "the audit wrote one capture in the explore layout");
    assert.equal(fs.existsSync(path.join(home, "captures", captures[0], "report.html")), true);
  } finally {
    await browser?.close();
    await product.close();
    site.server.close();
    if (priorHome === undefined) delete process.env.TAPP_HOME; else process.env.TAPP_HOME = priorHome;
  }
});

test("multiple detected applications require an explicit polished target choice", { skip:skipRealBrowser || !chromium, timeout:30_000 }, async () => {
  const product = await startBrowserProduct({ projectDir:multiTargetRepository(), launch:false });
  let browser;
  try {
    browser = await chromium.launch({ headless:true });
    const page = await browser.newPage();
    await page.goto(product.launchUrl, { waitUntil:"networkidle" });
    await page.locator("#targets .target-card").first().waitFor({ state:"visible", timeout:20_000 });
    await page.waitForFunction(() => document.querySelector("#operation-drawer")?.classList.contains("hidden"));
    assert.equal(await page.locator("#targets .target-card").count(), 2);
    assert.match(await page.locator("#target-choice-callout").innerText(), /Nothing will build until you select a target/);
    assert.match(await page.locator("#target-status").innerText(), /Selection required/);
    assert.equal(await page.locator("#explore").isDisabled(), true);
    assert.equal(await page.locator("#run-gate").isDisabled(), true);
    await page.screenshot({ path:path.join(os.tmpdir(), "tapp-multi-target-proof.png"), fullPage:true });

    const selected = page.locator("#targets .target-card").first();
    await selected.click();
    assert.equal(await selected.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#target-choice-callout").isHidden(), true);
    assert.equal(await page.locator("#explore").isEnabled(), true);
    assert.match(await page.locator("#explore").innerText(), /Build & explore/);
    assert.equal(await page.locator("#operation-drawer").isHidden(), true, "selecting a target does not silently start a build");
  } finally {
    await browser?.close();
    await product.close();
  }
});

import test from "node:test";
import assert from "node:assert/strict";

import { chooseOverlayDismissal, dismissBlockingOverlay } from "../mcp-server/src/web-explorer.js";

const browserTest = { skip: process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1", timeout: 90_000 };

// The shapes that actually sit in front of real sites. A rule written for one of them (a big
// centred modal) missed five of these six when it was measured, and a crawler that cannot get
// past an overlay never meets the application at all.
const SHAPES = {
  "native <dialog>, which is position:absolute by default": {
    html: `<dialog open style="padding:20px"><p>Share your location to find coaches near you</p>
      <button>Allow Device Location</button><button>Not now</button></dialog>`,
    expect: "Not now",
  },
  "a fixed backdrop with the card absolutely placed inside it": {
    html: `<div style="position:fixed;inset:0;background:rgba(0,0,0,.5)"><div style="position:absolute;top:30%;left:30%;width:400px;padding:20px;background:#fff">
      <p>Share your location?</p><button>Allow Device Location</button><button>Not now</button></div></div>`,
    expect: "Not now",
  },
  "a small bottom sheet, far under half the viewport": {
    html: `<div style="position:fixed;bottom:0;left:0;width:360px;height:140px;background:#fff">
      <p>Use your location?</p><button>Allow</button><button>Not now</button></div>`,
    expect: "Not now",
  },
  "a cookie bar: full width, barely any height": {
    html: `<div style="position:fixed;bottom:0;left:0;right:0;height:64px;background:#222;color:#fff">
      We use cookies <button>Accept all</button><button>Reject all</button></div>`,
    expect: "Reject all",
  },
  "a corner toast whose only way out is a glyph": {
    html: `<div style="position:fixed;top:12px;right:12px;width:300px;height:80px;background:#fff">
      <span>Enable notifications?</span><button aria-label="Close">✕</button></div>`,
    expect: "✕",
  },
  "a way out that is phrased, not bare": {
    html: `<div style="position:fixed;inset:0;background:#fff"><p>Join our newsletter</p>
      <button>Subscribe</button><button>Not now, thanks</button></div>`,
    expect: "Not now, thanks",
  },
};

test("tapp gets past the pop-up shapes real sites use, and never by granting anything", browserTest, async (t) => {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch { return t.skip("playwright not installed"); }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    for (const [shape, { html, expect }] of Object.entries(SHAPES)) {
      await page.setContent(`<!doctype html><body style="margin:0"><main><h1>App</h1><button id="real">Real control</button></main>${html}</body>`);
      const dismissed = await dismissBlockingOverlay(page);
      assert.ok(dismissed, `${shape}: tapp found no way out`);
      assert.equal(dismissed.label, expect, `${shape}: pressed the wrong control`);
    }
  } finally { await browser.close(); }
});

test("a page with nothing in front of it is left alone", browserTest, async (t) => {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch { return t.skip("playwright not installed"); }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    // A sticky header is lifted above the page and is not a pop-up: it offers no way out.
    await page.setContent(`<!doctype html><body><header style="position:sticky;top:0"><a href="/">Home</a></header>
      <main><h1>Shop</h1><button>Add to cart</button></main></body>`);
    assert.equal(await dismissBlockingOverlay(page), null, "a sticky header is not an overlay to escape");
  } finally { await browser.close(); }
});

test("the way out is the one that grants the least, and never the one that grants something", () => {
  assert.equal(chooseOverlayDismissal(["Allow Device Location", "Not now"]), "Not now");
  assert.equal(chooseOverlayDismissal(["Accept all", "Reject all", "Manage preferences"]), "Reject all");
  assert.equal(chooseOverlayDismissal(["Accept all", "Manage preferences"]), "Manage preferences");
  assert.equal(chooseOverlayDismissal(["Subscribe", "Not now, thanks"]), "Not now, thanks");
  assert.equal(chooseOverlayDismissal(["Enable notifications", "Don't ask again"]), "Don't ask again");
  // Nothing here is a way out that does not also grant something, so tapp presses nothing.
  assert.equal(chooseOverlayDismissal(["Allow", "Accept", "Sign up", "Turn on"]), null);
  assert.equal(chooseOverlayDismissal([]), null);
});

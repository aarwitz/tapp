import test from "node:test";
import assert from "node:assert/strict";

import { collectPageObservations, observationFindings, OBSERVATION_SCOPE } from "../mcp-server/src/page-observations.js";

const browserTest = { skip: process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1", timeout: 90_000 };

// One page carrying the things a person notices: text nobody can read, copy nobody finished, a
// field with nothing to say what it is, a control with no name, text cut off by its own box, a
// button that is fine on a desktop and too small on a phone, and a page that scrolls sideways
// on a phone. Also a perfectly ordinary paragraph, which must not be reported.
const PAGE = `<!doctype html><html><head><title>Document</title><style>
  body { background:#fff; color:#111; font-family: sans-serif; margin:0; }
  .faint { color:#bbbbbb; background:#ffffff; font-size:14px; }
  .clipped { width:120px; overflow:hidden; white-space:nowrap; }
  .small { font-size:9px; }
  .wide { width:1200px; height:10px; }
  .pill { display:block; width:28px; height:28px; }
</style></head><body>
  <p>Perfectly ordinary dark text on white, which nobody would complain about at all.</p>
  <p class="faint">You can barely read this sentence against the background.</p>
  <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
  <p class="clipped">This sentence is far too long for the little box it has been put inside of.</p>
  <p class="small">Tiny print that a person has to lean in to read, which is more than twenty-five characters.</p>
  <form><input name="mystery"><input name="described" placeholder="Your email"></form>
  <button class="pill"></button>
  <button class="pill">Go</button>
  <div class="wide"></div>
</body></html>`;

async function onPage(run) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.setContent(PAGE, { waitUntil: "domcontentloaded" });
    return await run(page);
  } finally { await browser.close(); }
}

test("the observation pass names what a person would notice, and leaves ordinary text alone", browserTest, async (t) => {
  try { await import("playwright"); } catch { return t.skip("playwright not installed"); }
  const findings = await onPage(async (page) => observationFindings(await collectPageObservations(page)));
  const types = findings.map((f) => f.type);
  const titleFor = (type) => findings.find((f) => f.type === type)?.title || "";

  assert.ok(types.includes("low_contrast"), "faint text is reported");
  assert.match(titleFor("low_contrast"), /barely read|Hard to read/i);
  assert.ok(types.includes("placeholder_copy"), "lorem ipsum is reported");
  assert.match(titleFor("placeholder_copy"), /[Ll]orem ipsum/);
  assert.ok(types.includes("clipped_text"), "text cut off by its box is reported");
  assert.ok(types.includes("tiny_text"), "9px body text is reported");
  assert.ok(types.includes("unlabelled_field"), "a field with no label is reported");
  assert.match(titleFor("unlabelled_field"), /mystery/, "and it is the one with nothing to say what it is");
  assert.doesNotMatch(findings.map((f) => f.title).join("\n"), /described/, "a field with a placeholder is not reported");
  assert.ok(types.includes("nameless_control"), "a control with no name is reported");
  assert.ok(types.includes("weak_page_title"), '"Document" is not a page title');
  assert.ok(types.includes("no_headline"), "a page with no h1 is reported");

  // Size and space are judged at phone width, where the answer is true.
  assert.ok(types.includes("phone_overflow"), "a page that scrolls sideways on a phone is reported");
  assert.match(titleFor("phone_overflow"), /On a phone/);
  assert.ok(types.includes("tiny_tap_target"), "a 28px button is reported");
  assert.match(titleFor("tiny_tap_target"), /On a phone/, "and said to be about a phone, not the desktop it was rendered at");

  // None of this is a defect, and the honest severity says so.
  for (const finding of findings) {
    assert.equal(finding.category, "polish", `${finding.type} is an observation, not a defect`);
    assert.ok(["low", "medium"].includes(finding.severity), `${finding.type} is never high or critical`);
  }
  assert.ok(OBSERVATION_SCOPE.length >= 6, "the report can say what was looked for");
});

test("the viewport is handed back exactly as it was found", browserTest, async (t) => {
  try { await import("playwright"); } catch { return t.skip("playwright not installed"); }
  const size = await onPage(async (page) => {
    await collectPageObservations(page);
    return page.viewportSize();
  });
  assert.deepEqual(size, { width: 1280, height: 800 }, "an exploration must not be left on a phone-sized window");
});

test("a page the pass cannot read costs nothing", async () => {
  const broken = { evaluate: async () => { throw new Error("execution context destroyed"); }, viewportSize: () => ({ width: 1280, height: 800 }) };
  assert.deepEqual(await collectPageObservations(broken), [], "an observation pass never fails a run");
  assert.deepEqual(observationFindings([{ kind: "something-new" }]), [], "an unknown observation is dropped, not rendered half-built");
});

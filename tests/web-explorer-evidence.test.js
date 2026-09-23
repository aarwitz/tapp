// Reproduces a field case: a third-party widget whose target element mounts
// asynchronously, well after the page's visible signature has already gone quiet (no spinner,
// nothing to make waitForWebStability wait longer). A single DOM snapshot cannot tell "this
// anchor is dead" from "the widget hasn't finished loading" — and even once a finding is
// genuinely earned, a report that names a specific control is only honest if its screenshot
// actually shows that control on screen, scrolled into view, not whatever the page looked like
// at the top of the initial navigation.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { buildQaReport } from "../mcp-server/src/report.js";

let chromium;
try { ({ chromium } = await import("playwright")); } catch {}
const skipRealBrowser = process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1";

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Schedule a tour</title></head>
<body style="font-family:sans-serif;padding:24px">
<h1>Schedule a tour</h1>
<p style="height:1200px">(spacer so the widget starts below the fold, like the real page)</p>
<p><a href="#tour-widget">Open Scheduler</a></p>
<p><a href="#nowhere">Book a call</a></p>
<p><a href="#">Contact us</a></p>
<script>
  // Simulates a slow third-party embed: no spinner, no busy indicator — the page's visible
  // signature is already stable by the time this fires, exactly like the real widget.min.js chain.
  setTimeout(() => {
    const el = document.createElement("div");
    el.id = "tour-widget";
    el.textContent = "Pick a time";
    document.body.appendChild(el);
  }, 1500);
</script>
</body></html>`;

test("an async-mounted widget target is not a false anchor_missing, and a genuine one carries scrolled-into-view evidence", { skip: skipRealBrowser || !chromium, timeout: 60_000 }, async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  const port = await listen(server);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-web-evidence-"));
  try {
    const { exploreWeb } = await import("../mcp-server/src/web-explorer.js");
    const result = await exploreWeb({ url: `http://127.0.0.1:${port}/`, maxActions: 10, timeoutSec: 60, outDir });
    const report = buildQaReport(result.markersPath, { platform: "web", target: `http://127.0.0.1:${port}/` });
    assert.ok(report, "markers parse into a report");

    const findingsByTarget = new Map(report.findings.map((f) => [f.target, f]));

    // The widget that shows up 1.5s late must NOT be reported dead.
    assert.equal(findingsByTarget.has("/#tour-widget"), false,
      "an anchor target that mounts within the recheck window is not a false positive");

    // #nowhere never mounts — that's a real, permanent defect and must still be caught.
    const nowhere = findingsByTarget.get("/#nowhere");
    assert.ok(nowhere, "a genuinely missing anchor target is still reported");
    assert.equal(nowhere.type, "anchor_missing");

    // Its evidence must be a real screenshot file, scrolled to the actual link (which sits
    // 1200px down the page) — not just the generic top-of-page screen capture.
    assert.ok(nowhere.evidence, "the finding carries an evidence screenshot");
    const evidencePath = path.join(outDir, nowhere.evidence);
    assert.ok(fs.existsSync(evidencePath), `evidence file exists at ${evidencePath}`);
    assert.ok(fs.statSync(evidencePath).size > 500, "evidence file is a real image, not an empty stub");

    // The labeled placeholder link ("Contact us", href="#") gets the same treatment.
    const contact = report.findings.find((f) => f.type === "placeholder_link" && f.target === "Contact us");
    assert.ok(contact, "a labeled placeholder link is reported");
    assert.ok(contact.evidence, "a labeled placeholder link's evidence can be located and captured");
    assert.ok(fs.existsSync(path.join(outDir, contact.evidence)));
  } finally {
    server.close();
  }
});

// End-to-end link audit against the field-report № 3 fixture page: eight known-bad or
// edge-case link/control cases on one page, served locally (the "external dead page that
// returns 200" is a second local server on another port — a different origin). The report
// expected a complete audit to produce 8 findings; this test pins exactly that.
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

test("field-report fixture: the complete link audit surfaces all eight cases", { skip: skipRealBrowser || !chromium, timeout: 120_000 }, async () => {
  const external = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Social</title><p>This content isn't available right now.</p>");
  });
  const externalPort = await listen(external);

  const page = (mainPort) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Link test</title></head>
<body style="font-family:sans-serif;padding:24px">
<h1>Link test page</h1>
<p><a href="/missing-page">Internal 404 link</a></p>
<p><a href="#nowhere">Anchor to missing id</a></p>
<p><a href="http://127.0.0.1:${externalPort}/dead">External dead page that returns 200</a></p>
<p><a href="https://nonexistent-host-zz9q.invalid/">External unresolvable host</a></p>
<p><a href="mailto:someone@nonexistent-domain-zz9q.invalid">Mail to domain with no MX</a></p>
<p><a href="#">Placeholder link</a></p>
<p><a href="/ok.html">Working internal link</a></p>
<button id="dead" type="button">Dead button</button>
<button id="live" type="button" onclick="document.getElementById('out').textContent='clicked'">Live button</button>
<p id="out"></p>
<details><summary>FAQ item</summary><p>Hidden answer text.</p></details>
<img src="/missing.jpg" alt="broken image">
</body></html>`;

  const main = http.createServer((req, res) => {
    if (req.url === "/" || req.url.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(main.address().port));
    } else if (req.url === "/ok.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>OK</title><h1>Working page</h1>");
    } else {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<!doctype html><title>404</title><h1>Not found</h1>");
    }
  });
  const mainPort = await listen(main);

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-link-audit-"));
  try {
    const { exploreWeb } = await import("../mcp-server/src/web-explorer.js");
    const result = await exploreWeb({ url: `http://127.0.0.1:${mainPort}/`, maxActions: 30, timeoutSec: 90, outDir });
    const report = buildQaReport(result.markersPath, { platform: "web", target: `http://127.0.0.1:${mainPort}/` });
    assert.ok(report, "markers parse into a report");

    const types = new Set(report.findings.map((f) => f.type));
    const expected = [
      "broken_link",          // /missing-page → 404
      "missing_asset",        // /missing.jpg → 404
      "placeholder_link",     // href="#"
      "anchor_missing",       // href="#nowhere"
      "unresolvable_host",    // *.invalid host
      "mailto_no_mx",         // mailto @ *.invalid
      "outbound_unavailable", // 200 + "isn't available" shell
      "unresponsive_element", // dead button (advisory)
    ];
    for (const type of expected) assert.ok(types.has(type), `expected finding type ${type}; got ${[...types].join(", ")}`);

    // Honest stop + per-action evidence.
    assert.equal(report.stopReason, "no-unexplored-in-scope-controls");
    assert.equal(report.inconclusive, false);
    assert.ok(report.trace.length >= 3, "trace has one entry per action");
    assert.ok(report.trace.every((a) => typeof a.type === "string"), "trace entries are typed");
    assert.ok(report.trace.some((a) => typeof a.t === "number"), "trace carries timestamp offsets");
    assert.ok(report.trace.some((a) => a.type === "tap" && /FAQ item/.test(a.target)), "details/summary toggles are exercised");
    assert.ok(report.checkedFor.some((item) => /outbound link reachability/.test(item)));
    assert.ok(report.checkedFor.some((item) => /mailto address domains/.test(item)));

    // Outbound findings are attributed to the page that CARRIED the link, not the last page
    // visited before the post-crawl audit ran.
    const unresolvable = report.findings.find((f) => f.type === "unresolvable_host");
    assert.match(String(unresolvable.url || ""), new RegExp(`127\\.0\\.0\\.1:${mainPort}/$`), "source-page attribution");

    // Policy v4: the browser-rendered unavailable-shell finding gates like every other
    // broken-link-class finding, and the run records its capture conditions.
    const shell = report.findings.find((f) => f.type === "outbound_unavailable");
    assert.equal(shell.evaluationTier, "deterministic");
    assert.equal(shell.severity, "medium");
    assert.deepEqual(report.captureContext, { device: null, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  } finally {
    main.close();
    external.close();
  }
});

test("an outbound link is checked as written, not with its query stripped", { skip: skipRealBrowser || !chromium, timeout: 120_000 }, async () => {
  // runtapp.com links to the VS Code marketplace as /items?itemName=lidi-solutions.tapp, which
  // returns 200; /items alone returns 404. Tapp checked the path only and reported a broken
  // link on its own landing page. For a great many URLs — store, marketplace, search — the
  // query *is* the resource.
  const external = http.createServer((req, res) => {
    if (req.url.startsWith("/items?")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>Extension</title><h1>The extension page</h1>");
      return;
    }
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<!doctype html><title>Not found</title><h1>404</h1>");
  });
  const externalPort = await listen(external);

  const main = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Home</title></head>
<body><h1>Home</h1>
<p><a href="http://127.0.0.1:${externalPort}/items?itemName=lidi-solutions.tapp">The extension</a></p>
</body></html>`);
  });
  const mainPort = await listen(main);

  try {
    const { exploreWeb } = await import("../mcp-server/src/web-explorer.js");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-outbound-query-"));
    await exploreWeb({ url: `http://127.0.0.1:${mainPort}/`, maxActions: 6, timeoutSec: 60, outDir });
    const markers = fs.readFileSync(path.join(outDir, "ocqa-markers.txt"), "utf8").split("\n");

    // The run must actually have checked the link, or this test proves nothing.
    const complete = markers.find((line) => line.startsWith("OCQA_COMPLETE:"));
    const outbound = JSON.parse(complete.slice("OCQA_COMPLETE:".length)).outbound;
    assert.equal(outbound.checked, 1, "the outbound link must have been checked");

    const issues = markers
      .filter((line) => line.startsWith("OCQA_ISSUE:"))
      .map((line) => JSON.parse(line.slice("OCQA_ISSUE:".length)));
    assert.deepEqual(
      issues.map((issue) => issue.title),
      [],
      "a link whose query makes it valid must not be reported broken",
    );
  } finally {
    await new Promise((resolve) => main.close(resolve));
    await new Promise((resolve) => external.close(resolve));
  }
});

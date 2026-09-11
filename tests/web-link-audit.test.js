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
  } finally {
    main.close();
    external.close();
  }
});

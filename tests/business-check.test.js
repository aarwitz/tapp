import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditWebSite } from "../mcp-server/src/web-audit.js";

async function businessFixture(run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.url === "/robots.txt") { res.end("User-agent: *\nDisallow: /private\n"); return; }
    if (req.url.startsWith("/api/") || req.url.startsWith("/unsubscribe") || req.url.startsWith("/private")) {
      res.setHeader("Content-Type", "application/json"); res.end('{"ok":true}'); return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html><head><title>Maya's Repair Service — synthetic review fixture</title>
      <meta name="viewport" content="width=device-width"><style>body{font:18px system-ui;max-width:700px;margin:60px auto;padding:24px}label{display:block;margin:20px 0}input,textarea,button{font:inherit;padding:8px}aside{background:#fff2cc;padding:12px}</style></head>
      <body><aside>Fictional business used to evaluate Tapp. No real customer data.</aside>
      <h1>Request a repair quote</h1><p>Our team normally replies within two business days.</p>
      <form id="quote"><label>Your email <input type="email" name="email"></label>
      <label>What needs fixing? <textarea name="message"></textarea></label><button>Send request</button></form>
      <p id="status">No request submitted.</p>
      <a href="/contact">Contact us</a> <a href="/unsubscribe?token=synthetic">Unsubscribe</a>
      <a href="/private">Staff area</a>
      <script>document.getElementById('quote').addEventListener('submit',e=>{e.preventDefault();fetch('/api/send',{method:'POST'});document.getElementById('status').textContent='Sent';});
      ${req.url.startsWith("/dynamic") ? "fetch('/api/read',{method:'POST'}).catch(()=>{document.getElementById('status').textContent='Status widget unavailable.'});new WebSocket('ws://'+location.host+'/stream');" : ""}
      </script></body></html>`);
  });
  let websocketConnections = 0;
  server.on("upgrade", (_request, socket) => { websocketConnections++; socket.destroy(); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const root = process.env.TAPP_BUSINESS_REVIEW_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "tapp-business-review-"));
  try { await run({ base: `http://127.0.0.1:${server.address().port}`, requests, root, websocketConnections: () => websocketConnections }); }
  finally { await new Promise(resolve => server.close(resolve)); if (!process.env.TAPP_BUSINESS_REVIEW_DIR) fs.rmSync(root, { recursive: true, force: true }); }
}

test("Maya: passive inspection records the contact page without submitting, following action links, or claiming delivery", { timeout: 90000 }, async () => {
  await businessFixture(async ({ base, requests, root }) => {
    const result = await auditWebSite({ url: `${base}/contact`, pages: 2, delayMs: 0,
      capturesDir: root, captureId: "maya-contact", observationOnly: true, recordVideo: true });
    assert.equal(requests.some(request => request.method === "POST"), false);
    assert.equal(requests.some(request => request.url.startsWith("/unsubscribe")), false, "An unsubscribe link may consume its token even on HEAD/GET");
    assert.equal(requests.some(request => request.url.startsWith("/private")), false, "robots exclusions must also apply to link probing");
    assert.match(result.pages[0].visibleText, /No request submitted/);
    assert.match(result.notChecked.join(" "), /nothing was pressed/);
    assert.ok(result.pages[0].recording);
    assert.ok(fs.statSync(path.join(result.capture.path, result.pages[0].recording)).size > 0);
    assert.ok(fs.readdirSync(result.capture.path).some(name => name.endsWith(".png")));
  });
});

test("Theo: a read widget using POST and a WebSocket are blocked and reported as observation limits", { timeout: 90000 }, async () => {
  await businessFixture(async ({ base, requests, root, websocketConnections }) => {
    const result = await auditWebSite({ url: `${base}/dynamic`, pages: 1, linkCheckLimit: 0,
      capturesDir: root, captureId: "theo-restricted-widget", observationOnly: true, recordVideo: true });
    assert.equal(requests.some(request => request.method === "POST"), false);
    assert.equal(websocketConnections(), 0);
    assert.equal(result.inconclusive, true);
    assert.match(result.observationLimits.join(" "), /POST/);
    assert.match(result.observationLimits.join(" "), /WebSockets/);
    assert.equal(result.pages.flatMap(page => page.findings).some(finding => finding.type === "network_error" && finding.target === "/api/read"), false);
    const report = JSON.parse(fs.readFileSync(path.join(result.capture.path, "report.json"), "utf8"));
    assert.equal(report.inconclusive, true);
  });
});

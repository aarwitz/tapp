import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditScope, parseRobots, robotsAllows, auditCaptureId } from "../mcp-server/src/web-audit.js";

const browserTest = { skip: process.env.TAPP_SKIP_REAL_BROWSER_TESTS === "1", timeout: 90_000 };

async function playwrightOrSkip(t) {
  try { const { chromium } = await import("playwright"); if (chromium) return true; } catch { /* fallthrough */ }
  t.skip("playwright not installed");
  return false;
}

// A small site: a healthy page that links to a dead one, a broken image, a 404 asset, a page
// wider than its viewport. Everything the audit claims to find, in one fixture.
async function serveSite() {
  const http = await import("node:http");
  const pages = {
    "/": `<!doctype html><title>Acme Plumbing</title><meta name="viewport" content="width=device-width"><body>
      <nav><a href="/services">Services</a> <a href="/pricing">Pricing</a> <a href="/about">About us</a> <a href="https://example.com/off-site">Instagram</a></nav>
      <img src="/img/hero.jpg" alt="Our van">
      <link rel="stylesheet" href="/styles/missing.css">
      <button id="quote">Get a quote</button>
      <script>document.getElementById('quote').addEventListener('click', () => {});</script>
    </body>`,
    "/services": `<!doctype html><title>Services</title><meta name="viewport" content="width=device-width"><body>
      <a href="/">Home</a><div style="width:3000px">wide</div><a href="#book">Book now</a>
    </body>`,
    "/about": `<!doctype html><title>About</title><body><a href="/">Home</a><p>We are Acme.</p></body>`,
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/robots.txt") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("User-agent: *\nDisallow: /about\n"); }
    const html = pages[url.pathname];
    if (!html) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("nope"); }
    if (req.method === "HEAD") { res.writeHead(200, { "content-type": "text/html" }); return res.end(); }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("the audit scope never claims a click", () => {
  const scope = auditScope({ linksChecked: { total: 12, checked: 10 }, pages: 1 });
  assert.match(scope.checkedFor.join("\n"), /first 10 of 12/);
  assert.match(scope.notChecked.join("\n"), /nothing was pressed, typed, submitted, or hovered/);
  assert.doesNotMatch(scope.checkedFor.join("\n"), /probe|click/i);
});

test("robots.txt: longest match wins, Allow beats Disallow at equal length, our own agent group takes precedence", () => {
  const groups = parseRobots(`
    User-agent: *
    Disallow: /private
    Allow: /private/ok
    Disallow: /tmp/*.html$

    User-agent: tapp
    Disallow: /only-for-us
  `);
  assert.equal(robotsAllows(groups, "/private/secret", "googlebot"), false);
  assert.equal(robotsAllows(groups, "/private/ok/page", "googlebot"), true);
  assert.equal(robotsAllows(groups, "/tmp/x.html", "googlebot"), false);
  assert.equal(robotsAllows(groups, "/tmp/x.htmlx", "googlebot"), true);
  assert.equal(robotsAllows(groups, "/public", "googlebot"), true);
  // our own group replaces the wildcard group entirely, as the standard says
  assert.equal(robotsAllows(groups, "/only-for-us", "tapp"), false);
  assert.equal(robotsAllows(groups, "/private/secret", "tapp"), true);
  assert.equal(robotsAllows([], "/anything"), true);
});

test("audit capture ids sort by time and read as web captures", () => {
  const id = auditCaptureId(new Date(2026, 9, 1, 9, 5, 7));
  assert.equal(id, "web-audit-20261001-090507");
  assert.ok(id.startsWith("web-"), "report.html recovery keys the platform off the id prefix");
});

test("one page: broken image, 404 asset, dead links, a page wider than its viewport — and nothing clicked", browserTest, async (t) => {
  if (!(await playwrightOrSkip(t))) return;
  const { server, base } = await serveSite();
  const home = path.join(os.tmpdir(), `tapp-audit-${process.pid}`);
  try {
    const { auditWebPage } = await import("../mcp-server/src/web-explorer.js");
    const result = await auditWebPage({ url: `${base}/`, capturesDir: path.join(home, "captures") });
    const titles = result.findings.map((f) => `${f.type}: ${f.title}`).join("\n");
    assert.match(titles, /broken_image: Image failed to load: \/img\/hero\.jpg/, titles);
    assert.match(titles, /missing_asset: 404 asset: \/img\/hero\.jpg/, titles);
    assert.match(titles, /missing_asset: 404 asset: \/styles\/missing\.css/, titles);
    assert.match(titles, /broken_link: Link “Pricing” → \/pricing answers 404/, titles);
    assert.doesNotMatch(titles, /Services|About us|Instagram|Get a quote/, "working links, off-site links and a wired button are never accused");
    assert.deepEqual(result.linksChecked, { total: 3, checked: 3 });
    assert.ok(result.checkedFor.length && result.notChecked.length, "an audit states its own scope");

    assert.ok(result.capture?.path && fs.existsSync(result.capture.path), "a capture directory was written");
    const files = fs.readdirSync(result.capture.path);
    assert.ok(files.some((f) => /^state_1_.*\.png$/.test(f)), `a page screenshot in explore layout: ${files}`);
    assert.ok(files.includes("ocqa-markers.txt") && files.includes("report.html") && files.includes("report.json") && files.includes("audit.json"), `${files}`);
    const image = result.findings.find((f) => f.type === "broken_image");
    assert.ok(image.evidence && files.includes(image.evidence), "the broken image got an element-scoped evidence shot");
    const markers = fs.readFileSync(path.join(result.capture.path, "ocqa-markers.txt"), "utf8");
    assert.match(markers, /^OCQA_CONTEXT:.*"readOnly":true/m);
    assert.match(markers, /^OCQA_STATE:.*"screen":"\/"/m);
    assert.match(markers, /^OCQA_ISSUE:.*"type":"broken_link"/m);
    assert.match(markers, /^OCQA_COMPLETE:.*"actions":0.*"stop":"audit-complete"/m);
    assert.doesNotMatch(markers, /^OCQA_ACTION:/m, "an audit performs no actions");
    const report = JSON.parse(fs.readFileSync(path.join(result.capture.path, "report.json"), "utf8"));
    assert.equal(report.kind, "tapp-structural-audit");
    assert.equal(report.inconclusive, false, "the exploration coverage floor does not apply to an audit");
    assert.match(report.headline, /without clicking anything/);
    assert.ok(report.findings.some((f) => f.type === "broken_link" && f.url), "report.json carries the findings with their page url");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("crawl: follows same-origin links breadth-first, honours robots.txt, one capture for the whole site", browserTest, async (t) => {
  if (!(await playwrightOrSkip(t))) return;
  const { server, base } = await serveSite();
  const home = path.join(os.tmpdir(), `tapp-audit-site-${process.pid}`);
  try {
    const { auditWebSite } = await import("../mcp-server/src/web-explorer.js");
    const visited = [];
    const result = await auditWebSite({ url: `${base}/`, pages: 5, delayMs: 0, capturesDir: path.join(home, "captures"), onPage: (p) => visited.push(new URL(p.url).pathname) });
    assert.equal(result.pagesAudited, 2, JSON.stringify(visited));
    assert.deepEqual(visited, ["/", "/services"]);
    assert.deepEqual(result.robotsBlocked, [`${base}/about`]);
    const services = result.pages[1];
    const titles = services.findings.map((f) => `${f.type}: ${f.title}`).join("\n");
    assert.match(titles, /horizontal_overflow: Page is \d+px wider/, titles);
    assert.match(titles, /anchor_missing: In-page link “Book now” points at #book/, titles);
    assert.ok(result.findingCounts.total >= 5, JSON.stringify(result.findingCounts));
    const files = fs.readdirSync(result.capture.path);
    assert.ok(files.some((f) => /^state_1_/.test(f)) && files.some((f) => /^state_2_services\.png$/.test(f)), `${files}`);
    const html = fs.readFileSync(path.join(result.capture.path, "report.html"), "utf8");
    assert.match(html, /Read-only audit|without clicking anything/);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

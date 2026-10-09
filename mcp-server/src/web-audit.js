// Read-only web audit: render a page, read it, never click it.
//
// This is the one analysis safe to point at a site you do not own, which is what makes it the
// primitive behind the outreach motion (find a prospect's broken site, show them proof). Everything
// here is an observation of a page as served: structurally dead controls, assets that failed to
// load, links that answer 404, mixed content, a layout wider than its viewport. No form is
// submitted, no button pressed, no navigation beyond the pages the caller asked for.
//
// The capture it writes uses the same layout as an explore run (state_*.png at the root,
// ocqa-markers.txt, report.html) so every existing consumer of a capture — `tapp report`, the
// Studio, Clien's evidence videos — reads an audit without a second code path.
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import {
  NAV_TIMEOUT_MS, loadPlaywright, webBrowserLaunchOptions, webContextOptions, installWebListenerTracking,
  waitForWebStability, captureElementEvidence, shouldReportWebRequestFailure, auditStructuralControls,
  auditFindingsFromControls, slug,
} from "./web-explorer.js";
import { buildQaReport } from "./report.js";
import { writeHtmlReport } from "./html-report.js";
import { buildUiMapFromMarkers, writeUiMap } from "./ui-map.js";
import { writeCaptureProvenance } from "./capture-provenance.js";

const require = createRequire(import.meta.url);
const VERSION = (() => { try { return require("../../package.json").version; } catch { return "0.0.0"; } })();

export const AUDIT_LINK_CHECK_LIMIT = 30;
export const AUDIT_CRAWL_DELAY_MS = 1000;
const LINK_CHECK_CONCURRENCY = 4;
const LINK_CHECK_TIMEOUT_MS = 10_000;

// What an audit does and does not look at. Spelled out so a report never borrows the exploration
// run's "checked for" list and claims clicks that never happened.
export function auditScope({ linksChecked = { total: 0, checked: 0 }, pages = 1 } = {}) {
  const checkedFor = [
    "controls that were never alive: dead in-page anchors, placeholder links, aria-controls naming nothing, buttons with no handler/form/link",
    "images that failed to load",
    "same-origin assets answering 404 and requests answering 5xx or failing during page load",
    "uncaught JavaScript exceptions during page load",
    "mixed content (http:// resources on an https:// page)",
    "page wider than its viewport (horizontal scrolling) and a missing viewport meta tag",
  ];
  if (linksChecked.total) {
    checkedFor.push(linksChecked.total > linksChecked.checked
      ? `same-origin links answering 404/410/5xx (first ${linksChecked.checked} of ${linksChecked.total}, HEAD then GET)`
      : "same-origin links answering 404/410/5xx (HEAD then GET)");
  }
  const notChecked = [
    "anything that needs a click: nothing was pressed, typed, submitted, or hovered (run `tapp explore` on an environment you own for that)",
    "off-site links (only same-origin links are fetched; outbound reachability is an explore check)",
    "app-specific business logic, content accuracy, privacy, brand, visual quality",
    pages > 1 ? `pages beyond the ${pages} audited` : "pages other than the one audited (pass --pages N to crawl same-origin links)",
  ];
  return { checkedFor, notChecked };
}

// robots.txt, the polite minimum: honour Disallow for `*` and for our own agent, longest match wins,
// Allow beats Disallow at equal length. Unparseable or unreachable → everything allowed.
export function parseRobots(text = "") {
  const groups = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      if (!current || current.rules.length) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
    } else if ((field === "disallow" || field === "allow") && current) {
      current.rules.push({ allow: field === "allow", prefix: value });
    }
  }
  return groups;
}

export function robotsAllows(groups, pathname, agent = "tapp") {
  const mine = groups.filter((g) => g.agents.some((a) => a === agent || agent.startsWith(a)));
  const applicable = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  let best = null;
  for (const group of applicable) {
    for (const rule of group.rules) {
      if (!rule.prefix) { if (!rule.allow && !best) best = { allow: true, len: 0 }; continue; }
      const re = new RegExp("^" + rule.prefix.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*").replace(/\\\$$/, "$"));
      if (re.test(pathname) && (!best || rule.prefix.length > best.len || (rule.prefix.length === best.len && rule.allow))) {
        best = { allow: rule.allow, len: rule.prefix.length };
      }
    }
  }
  return best ? best.allow : true;
}

// Page-level health, read from the DOM after load. Flagged elements are tagged like the structural
// scan does so the evidence shot is of the element the finding names.
async function auditPageHealth(page) {
  return page.evaluate(() => {
    const findings = [];
    let n = 0;
    const tag = (el) => { n += 1; el.setAttribute("data-tapp-audit-health", String(n)); return `[data-tapp-audit-health="${n}"]`; };
    const visible = (el) => el.getClientRects().length > 0;
    for (const img of document.images) {
      const src = img.getAttribute("src") || "";
      if (!src || src.startsWith("data:")) continue;
      if (img.complete && img.naturalWidth === 0) {
        findings.push({ kind: "broken_image", src: src.slice(0, 160), alt: (img.getAttribute("alt") || "").slice(0, 80), selector: visible(img) ? tag(img) : null });
      }
    }
    if (location.protocol === "https:") {
      for (const el of document.querySelectorAll("img[src], script[src], iframe[src], video[src], audio[src], source[src], link[rel~=stylesheet][href]")) {
        const value = el.getAttribute("src") || el.getAttribute("href") || "";
        if (/^http:\/\//i.test(value)) findings.push({ kind: "mixed_content", tagName: el.tagName.toLowerCase(), src: value.slice(0, 160), selector: visible(el) ? tag(el) : null });
      }
    }
    const doc = document.documentElement;
    const overflow = Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0) - window.innerWidth;
    if (overflow > 2) findings.push({ kind: "horizontal_overflow", overflow, viewport: window.innerWidth });
    if (!document.querySelector('meta[name="viewport"]')) findings.push({ kind: "no_viewport_meta" });
    const links = [];
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      if (!href || href.startsWith("#") || /^(mailto|tel|javascript|sms):/i.test(href)) continue;
      let abs;
      try { abs = new URL(href, location.href); } catch { continue; }
      if (!/^https?:$/.test(abs.protocol)) continue;
      abs.hash = "";
      links.push({ href: abs.href, label: (a.getAttribute("aria-label") || a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80), sameOrigin: abs.origin === location.origin });
    }
    return { findings, links };
  });
}

function healthFindings(raw = []) {
  const out = [];
  for (const h of raw) {
    if (h.kind === "broken_image") {
      out.push({ type: "broken_image", severity: "medium", title: `Image failed to load: ${h.src}${h.alt ? ` (alt “${h.alt}”)` : ""}`, target: h.src, selector: h.selector });
    } else if (h.kind === "mixed_content") {
      out.push({ type: "mixed_content", severity: "medium", title: `Mixed content: <${h.tagName}> loads ${h.src} over plain http on an https page (browsers block or warn)`, target: h.src, selector: h.selector });
    } else if (h.kind === "horizontal_overflow") {
      out.push({ type: "horizontal_overflow", severity: "low", title: `Page is ${h.overflow}px wider than the ${h.viewport}px viewport — it scrolls sideways on this screen size`, target: `overflow:${h.overflow}` });
    } else if (h.kind === "no_viewport_meta") {
      out.push({ type: "no_viewport_meta", severity: "low", title: "No <meta name=\"viewport\"> — phones render the page zoomed out at desktop width", target: "meta[name=viewport]" });
    }
  }
  return out;
}

// HEAD each same-origin link (GET when HEAD is refused). A link the server cannot answer is
// reported low — a WAF or rate limit answers that way too — while 404/410 and 5xx are the server's
// own word.
async function checkLinks(context, links, { limit, pageUrl }) {
  const unique = new Map();
  for (const link of links) {
    if (!link.sameOrigin || link.href === pageUrl) continue;
    if (!unique.has(link.href)) unique.set(link.href, link.label);
  }
  const targets = [...unique.entries()].slice(0, Math.max(0, limit));
  const findings = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const [href, label] = targets[cursor++];
      const where = label ? `“${label}”` : href;
      const pathOf = (() => { try { return new URL(href).pathname; } catch { return href; } })();
      try {
        let res = await context.request.fetch(href, { method: "HEAD", maxRedirects: 5, timeout: LINK_CHECK_TIMEOUT_MS, failOnStatusCode: false });
        if ([405, 501, 403].includes(res.status())) {
          res = await context.request.fetch(href, { method: "GET", maxRedirects: 5, timeout: LINK_CHECK_TIMEOUT_MS, failOnStatusCode: false });
        }
        const status = res.status();
        if (status === 404 || status === 410) findings.push({ type: "broken_link", severity: "medium", title: `Link ${where} → ${pathOf} answers ${status}`, target: href, url: href });
        else if (status >= 500) findings.push({ type: "broken_link", severity: "high", title: `Link ${where} → ${pathOf} answers ${status}`, target: href, url: href });
      } catch (error) {
        findings.push({ type: "broken_link", severity: "low", title: `Link ${where} → ${pathOf} could not be fetched (${String(error?.message || error).split("\n")[0].slice(0, 80)})`, target: href, url: href });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LINK_CHECK_CONCURRENCY, targets.length) }, worker));
  findings.sort((a, b) => String(a.target).localeCompare(String(b.target)));
  return { findings, total: unique.size, checked: targets.length };
}

// One page, inside an already-open context. Collects everything, then (if a capture is open) shoots
// the page and each named element and appends the markers.
async function auditOnePage(context, target, { timeoutMs, linkCheckLimit, capture }) {
  const page = await context.newPage();
  const bounded = Math.max(1000, Math.min(60_000, Number(timeoutMs) || NAV_TIMEOUT_MS));
  page.setDefaultTimeout(bounded);
  const origin = target.origin;
  const loadFindings = [];
  const seenLoad = new Set();
  const loadIssue = (type, severity, title, key) => {
    if (seenLoad.has(key)) return;
    seenLoad.add(key);
    loadFindings.push({ type, severity, title, target: key });
  };
  page.on("pageerror", (err) => loadIssue("js_exception", "high", `Uncaught JS exception: ${String(err.message || err).slice(0, 120)}`, `js:${String(err.message || err).slice(0, 120)}`));
  page.on("response", (res) => {
    try {
      const u = new URL(res.url());
      if (u.origin !== origin) return;
      if (res.status() >= 500) loadIssue("network_error", "high", `${res.status()} from ${u.pathname.slice(0, 80)}`, u.pathname);
      else if (res.status() === 404 && res.request().resourceType() !== "document") loadIssue("missing_asset", "medium", `404 asset: ${u.pathname.slice(0, 80)}`, u.pathname);
    } catch { /* unparseable url */ }
  });
  page.on("requestfailed", (req) => {
    try {
      const u = new URL(req.url());
      if (u.origin !== origin) return;
      const errorText = req.failure()?.errorText || "?";
      if (!shouldReportWebRequestFailure(errorText)) return;
      loadIssue("network_error", "medium", `Request failed: ${u.pathname.slice(0, 80)} (${errorText})`, u.pathname);
    } catch { /* unparseable url */ }
  });

  try {
    const response = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: bounded });
    if (response && response.status() >= 400) throw new Error(`Could not open ${target.href}: HTTP ${response.status()}`);
    await waitForWebStability(page, { timeoutMs: Math.min(5_000, bounded) });

    const controls = await auditStructuralControls(page);
    const health = await auditPageHealth(page);
    const links = await checkLinks(context, health.links, { limit: linkCheckLimit, pageUrl: page.url() });

    const structural = auditFindingsFromControls(controls.dead).map((f, i) => ({ ...f, selector: controls.dead[i].selector }));
    const findings = [...structural, ...healthFindings(health.findings), ...loadFindings, ...links.findings];
    const screen = target.pathname + target.search;
    for (const f of findings) { f.screen = screen; if (!f.url) f.url = page.url(); }

    if (capture) {
      capture.states += 1;
      const stateName = `state_${capture.states}_${slug(target.pathname === "/" ? (controls.title || "home") : target.pathname)}.png`;
      await page.screenshot({ path: path.join(capture.dir, stateName), fullPage: true }).catch(() => page.screenshot({ path: path.join(capture.dir, stateName) }).catch(() => {}));
      capture.emit("STATE", { screen, url: page.url(), elements: controls.controlCount, role: "page", controls: controls.dead.map((d) => d.label).filter(Boolean).slice(0, 40), inputs: [], settled: true, screenshot: stateName });
      for (const f of findings) {
        if (f.selector) {
          capture.evidence += 1;
          const name = `evidence_${capture.evidence}_${slug(f.type)}.png`;
          const shot = await captureElementEvidence(page, page.locator(f.selector), capture.dir, name);
          if (shot) f.evidence = shot;
        }
        capture.emit("ISSUE", { type: f.type, severity: f.severity, title: f.title, screen, ...(f.target ? { target: f.target } : {}), url: f.url, ...(f.evidence ? { evidence: f.evidence } : {}) });
      }
    }
    for (const f of findings) delete f.selector;

    return {
      url: page.url(),
      title: controls.title,
      controlsExamined: controls.controlCount,
      linksChecked: { total: links.total, checked: links.checked },
      findings,
      links: health.links,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

function openCapture(capturesDir, id) {
  const dir = path.join(capturesDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const markersFd = fs.openSync(path.join(dir, "ocqa-markers.txt"), "w");
  return {
    id, dir, states: 0, evidence: 0, markersFd,
    emit(kind, payload) { fs.writeSync(markersFd, `OCQA_${kind}:${JSON.stringify(payload)}\n`); },
    close() { try { fs.closeSync(markersFd); } catch { /* already closed */ } },
  };
}

export function auditCaptureId(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `web-audit-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

function finalizeCapture(capture, { startUrl, pages, findings, robotsBlocked, linksChecked }) {
  capture.emit("COMPLETE", { actions: 0, screens: pages.length, credentialsProvided: false, credentialsUsed: false, timedOut: false, stop: "audit-complete", readOnly: true, robotsBlocked });
  capture.close();
  const markers = path.join(capture.dir, "ocqa-markers.txt");
  const report = buildQaReport(markers, { platform: "web", target: startUrl });
  if (!report) return null;
  // The exploration report's coverage floor and wording assume clicks; an audit has none by design.
  const scope = auditScope({ linksChecked, pages: pages.length });
  const counts = report.deterministicFindingCounts || report.findingCounts || { critical: 0, high: 0, medium: 0, low: 0 };
  Object.assign(report, {
    kind: "tapp-structural-audit",
    readOnly: true,
    inconclusive: false,
    runStatus: "completed",
    stopReason: "audit-complete",
    headline: findings.length === 0
      ? `Read-only audit of ${pages.length} page(s) — nothing broken was observed. Nothing was clicked; this says the page is served without structural defects, not that the product works.`
      : `${findings.length} defect(s) observed on ${pages.length} page(s) without clicking anything (${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low).`,
    checkedFor: scope.checkedFor,
    notChecked: scope.notChecked,
    conditionsNotReached: [],
  });
  fs.writeFileSync(path.join(capture.dir, "report.json"), JSON.stringify(report, null, 2));
  // The capture-local UI map is what ties a page screenshot to the findings on that page for
  // every consumer that reads explore captures (the Studio, Clien's evidence slides).
  try { writeUiMap(path.join(capture.dir, "ui-map.json"), buildUiMapFromMarkers({ markersPath: markers, platform: "web", target: startUrl, runId: capture.id })); }
  catch { /* the map is a convenience; the report and markers are the evidence */ }
  writeHtmlReport(capture.dir, { report, label: "Read-only audit" });
  return report;
}

// Audit a site: the start page and, with pages > 1, same-origin links discovered on audited pages
// (breadth-first, robots.txt honoured, one request at a time with a pause between pages).
export async function auditWebSite({
  url, pages = 1, timeoutMs = NAV_TIMEOUT_MS, device = "", viewport = "",
  linkCheckLimit = AUDIT_LINK_CHECK_LIMIT, delayMs = AUDIT_CRAWL_DELAY_MS,
  capturesDir = "", captureId = "", onPage = null,
}) {
  let start;
  try { start = new URL(url); }
  catch { throw new Error("Audit needs a valid http(s) URL"); }
  if (!/^https?:$/.test(start.protocol)) throw new Error("Audit needs a valid http(s) URL");
  const maxPages = Math.max(1, Math.min(200, Number(pages) || 1));

  const { chromium, devices } = await loadPlaywright();
  const browser = await chromium.launch(webBrowserLaunchOptions(process.env, {}));
  const capture = capturesDir ? openCapture(capturesDir, captureId || auditCaptureId()) : null;
  const provenance = capture ? writeCaptureProvenance(capture.dir, { kind: "audit", platform: "web", target: start.href }) : null;
  try {
    const contextOptions = webContextOptions({ device, viewport, devices });
    // Identify ourselves to sites we do not own; the default UA is kept so rendering is unchanged.
    const probe = await browser.newContext(contextOptions);
    const defaultUa = contextOptions.userAgent || await (await probe.newPage()).evaluate(() => navigator.userAgent).catch(() => "");
    await probe.close();
    const context = await browser.newContext({ ...contextOptions, userAgent: `${defaultUa} tapp-audit/${VERSION} (+https://runtapp.com)`.trim() });
    await installWebListenerTracking(context);
    if (capture) capture.emit("CONTEXT", { ...(String(device || "").trim() ? { device: String(device).trim() } : {}), viewport: contextOptions.viewport, deviceScaleFactor: contextOptions.deviceScaleFactor ?? 1, mode: "audit", readOnly: true });

    let robots = [];
    if (maxPages > 1) {
      try {
        const res = await context.request.get(new URL("/robots.txt", start).href, { timeout: 5_000, failOnStatusCode: false });
        if (res.ok()) robots = parseRobots(await res.text());
      } catch { /* unreachable robots.txt: everything allowed */ }
    }

    const results = [];
    const robotsBlocked = [];
    const queued = new Set([start.href]);
    const queue = [start];
    let linksTotal = 0;
    let linksChecked = 0;
    while (queue.length && results.length < maxPages) {
      const target = queue.shift();
      if (results.length > 0) {
        if (!robotsAllows(robots, target.pathname)) { robotsBlocked.push(target.href); continue; }
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      }
      let result;
      try {
        result = await auditOnePage(context, target, { timeoutMs, linkCheckLimit, capture });
      } catch (error) {
        if (results.length === 0) throw error;
        result = { url: target.href, title: "", controlsExamined: 0, linksChecked: { total: 0, checked: 0 }, links: [],
          findings: [{ type: "broken_link", severity: "medium", title: `Page ${target.pathname} did not open: ${String(error?.message || error).slice(0, 120)}`, target: target.href, url: target.href, screen: target.pathname }] };
      }
      linksTotal += result.linksChecked.total;
      linksChecked += result.linksChecked.checked;
      const { links, ...pageResult } = result;
      results.push(pageResult);
      if (typeof onPage === "function") onPage(pageResult, results.length);
      // A link the HEAD check already found broken is reported; opening it would only repeat the finding.
      const broken = new Set(pageResult.findings.filter((f) => f.type === "broken_link").map((f) => f.target));
      for (const link of links) {
        if (!link.sameOrigin || queued.has(link.href) || broken.has(link.href) || queued.size >= maxPages * 4) continue;
        let next;
        try { next = new URL(link.href); } catch { continue; }
        if (/\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|mp3|css|js|xml|ico)$/i.test(next.pathname)) continue;
        queued.add(next.href);
        queue.push(next);
      }
    }

    const findings = results.flatMap((r) => r.findings);
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings) if (f.severity in bySeverity) bySeverity[f.severity] += 1;
    const scope = auditScope({ linksChecked: { total: linksTotal, checked: linksChecked }, pages: results.length });
    const summary = {
      kind: "tapp-structural-audit",
      readOnly: true,
      url: start.href,
      pagesAudited: results.length,
      pagesQueued: queue.length,
      robotsBlocked,
      findingCounts: { ...bySeverity, total: findings.length },
      checkedFor: scope.checkedFor,
      notChecked: scope.notChecked,
      pages: results,
      capture: null,
    };
    if (capture) {
      finalizeCapture(capture, { startUrl: start.href, pages: results, findings, robotsBlocked, linksChecked: { total: linksTotal, checked: linksChecked } });
      summary.capture = { id: capture.id, path: capture.dir, report: path.join(capture.dir, "report.html"), provenance };
      fs.writeFileSync(path.join(capture.dir, "audit.json"), JSON.stringify(summary, null, 2));
    }
    return summary;
  } finally {
    if (capture) capture.close();
    await browser.close().catch(() => {});
  }
}

// One page. The shape existing callers and tests rely on, plus `capture` when a captures dir is given.
export async function auditWebPage({ url, timeoutMs = NAV_TIMEOUT_MS, device = "", viewport = "", linkCheckLimit = AUDIT_LINK_CHECK_LIMIT, capturesDir = "", captureId = "" }) {
  const site = await auditWebSite({ url, pages: 1, timeoutMs, device, viewport, linkCheckLimit, capturesDir, captureId });
  const page = site.pages[0];
  return {
    url: page.url,
    title: page.title,
    controlsExamined: page.controlsExamined,
    linksChecked: page.linksChecked,
    findings: page.findings,
    checkedFor: site.checkedFor,
    notChecked: site.notChecked,
    capture: site.capture,
  };
}

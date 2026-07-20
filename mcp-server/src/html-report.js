// Static HTML evidence report for a capture — the human-shareable artifact of a QA run.
// One self-contained page written INTO the capture dir, referencing the sibling
// screenshots by relative path, so the whole dir travels as a unit (zip it, attach it,
// open it). No dependencies, no network, works from file://.
//
// This is the "champion artifact": the free-tool user forwards it to the person who can
// buy the gate. Keep it honest — it renders exactly what the verdict pipeline produced.

import fs from "fs";
import path from "path";
import { buildQaReport } from "./report.js";

const BADGE = { ready: "🟢 SHIP-READY", caution: "🟡 CAUTION", blocked: "🔴 BLOCKED" };
const SEV_COLOR = { critical: "#cf222e", high: "#bc4c00", medium: "#9a6700", low: "#57606a" };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Two capture layouts exist: web runs write state_*.png at the capture root; iOS runs
// export XCUITest attachments into screenshots/ as UUID files with a manifest carrying
// the human-readable state_N_<Screen> names.
function collectShots(captureDir) {
  const root = fs
    .readdirSync(captureDir)
    .filter((f) => f.endsWith(".png") && f.startsWith("state_"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => ({ src: f, caption: f.replace(/^state_\d+_/, "").replace(/\.png$/, "").replace(/[-_]/g, " ") }));
  if (root.length) return root;

  const maniPath = path.join(captureDir, "screenshots", "manifest.json");
  if (!fs.existsSync(maniPath)) return [];
  try {
    const mani = JSON.parse(fs.readFileSync(maniPath, "utf8"));
    return mani
      .flatMap((m) => m.attachments || [])
      .filter((a) => /^(state|final_state)_/.test(a.suggestedHumanReadableName || ""))
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      .map((a) => ({
        src: "screenshots/" + a.exportedFileName,
        caption:
          (a.suggestedHumanReadableName || "")
            .replace(/^final_state_\d*_?/, "final state ")
            .replace(/^state_\d+_/, "")
            .replace(/_?\d*_?[0-9A-F]{8}-[0-9A-F-]{27}\.png$/i, "")
            .replace(/\.png$/, "")
            .replace(/[-_]/g, " ")
            .trim() || "screen",
      }));
  } catch {
    return [];
  }
}

export function writeHtmlReport(captureDir, { report, label = "" } = {}) {
  const r = report || buildQaReport(path.join(captureDir, "ocqa-markers.txt"));
  if (!r) return null;

  const shots = collectShots(captureDir);
  const video = ["exploration.webm", "exploration.mov"].find((f) => fs.existsSync(path.join(captureDir, f)));

  const findingsHtml = r.findings.length
    ? r.findings
        .map(
          (f) => `<li>
  <span class="sev" style="background:${SEV_COLOR[f.severity] || "#57606a"}">${esc(f.severity)}</span>
  ${esc(f.title)}${f.screen ? ` <span class="dim">— on ${esc(f.screen)}</span>` : ""}
  ${f.aiAnalysis ? `<div class="ai">why: ${esc(f.aiAnalysis)}</div>` : ""}
  ${f.suggestedFix ? `<div class="ai">fix: ${esc(f.suggestedFix)}</div>` : ""}
</li>`
        )
        .join("\n")
    : "<li>None found ✨</li>";

  const shotsHtml = shots
    .map(
      (s) =>
        `<figure><a href="${esc(s.src)}"><img loading="lazy" src="${esc(s.src)}" alt="${esc(s.caption)}"></a><figcaption>${esc(s.caption)}</figcaption></figure>`
    )
    .join("\n");

  const videoHtml = video
    ? `<h2>Recording — the full exploration</h2>\n<video controls preload="metadata" style="width:100%;border:1px solid #d0d7de;border-radius:8px" src="${esc(video)}"></video>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tapp report — ${esc(label || path.basename(captureDir))}</title>
<style>
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #1f2328; }
  h1 { font-size: 1.6rem; margin-bottom: 0.2rem; }
  .meta { color: #57606a; margin-bottom: 1.2rem; }
  .headline { background: #f6f8fa; border-radius: 8px; padding: 0.9rem 1.1rem; margin: 1rem 0; }
  .sev { color: #fff; border-radius: 4px; padding: 0.05rem 0.45rem; font-size: 0.78rem; font-weight: 600; margin-right: 0.4rem; }
  ul.findings { padding-left: 1.1rem; } ul.findings li { margin-bottom: 0.6rem; }
  .ai { color: #57606a; font-size: 0.88rem; margin: 0.15rem 0 0 0.2rem; }
  .dim { color: #57606a; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.8rem; }
  figure { margin: 0; } figure img { width: 100%; border: 1px solid #d0d7de; border-radius: 6px; }
  figcaption { font-size: 0.8rem; color: #57606a; text-align: center; padding-top: 0.2rem; }
  footer { margin: 2.5rem 0 1rem; color: #57606a; font-size: 0.85rem; border-top: 1px solid #d0d7de; padding-top: 0.8rem; }
</style>
</head>
<body>
<h1>${BADGE[r.verdict] || esc(r.verdict)} <span class="dim">· confidence ${r.confidence}/100</span></h1>
<div class="meta">${esc(label)} · ${r.screensExplored} screens · ${r.actionsPerformed} actions · ${r.findingCounts.total} finding(s)</div>
<div class="headline">${esc(r.headline)}</div>
<h2>Findings</h2>
<ul class="findings">
${findingsHtml}
</ul>
<h2>Evidence — every screen explored</h2>
<div class="grid">
${shotsHtml || "<p class='dim'>No screenshots captured.</p>"}
</div>
${videoHtml}
<footer>Generated by <a href="https://github.com/aarwitz/tapp">Tapp</a> — autonomous QA with a deterministic ship/no-ship verdict. Ship with proof.</footer>
</body>
</html>
`;
  const out = path.join(captureDir, "report.html");
  fs.writeFileSync(out, html);
  return out;
}

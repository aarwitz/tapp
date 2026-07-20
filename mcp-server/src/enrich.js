// Post-run finding enrichment — the node port of the desktop app's FindingEnriching seam
// (AISeams.swift), with the same contract: post-run only, deduped, capped, concurrent,
// additive/best-effort (a failure leaves the heuristic finding untouched), and it NEVER
// changes severity/verdict/gate. Attaches `aiAnalysis` (root cause) + `suggestedFix` per
// finding when a model backend is configured; without one the caller skips it entirely.

const ENRICH_CAP = 5; // findings are pre-sorted by severity, so this enriches the worst
const TIMEOUT_MS = 20_000;

function parseEnrichment(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const brace = t.indexOf("{");
  if (brace > 0) t = t.slice(brace);
  try {
    const o = JSON.parse(t);
    const rootCause = String(o.rootCause || o.root_cause || o.analysis || "").trim();
    const suggestedFix = String(o.suggestedFix || o.suggested_fix || o.fix || "").trim();
    if (!rootCause && !suggestedFix) return null;
    return { rootCause, suggestedFix };
  } catch {
    return null;
  }
}

export async function enrichFindings(findings, { backend, callModel, screens = [], appLabel = "" }) {
  const targets = findings.slice(0, ENRICH_CAP);
  const system =
    "You are a senior mobile/web QA engineer. Given one defect found by autonomous UI exploration, " +
    "reply with ONLY a JSON object {\"rootCause\": \"...\", \"suggestedFix\": \"...\"} — one concrete, " +
    "app-specific sentence each. No markdown, no prose around the JSON.";
  await Promise.all(
    targets.map(async (f) => {
      const userText =
        `App under test: ${appLabel || "unknown"}\n` +
        `Screens observed: ${screens.slice(0, 15).join(", ") || "n/a"}\n` +
        `Defect: type=${f.type} severity=${f.severity} screen=${f.screen ?? "?"}\n` +
        `Title: ${f.title}`;
      try {
        const res = await Promise.race([
          callModel(backend, { system, userText, model: process.env.AUTOTAP_FINDING_MODEL || "claude-haiku-4-5-20251001", maxTokens: 300 }),
          new Promise((r) => setTimeout(() => r({ error: "timeout" }), TIMEOUT_MS)),
        ]);
        const parsed = res && !res.error ? parseEnrichment(res.text) : null;
        if (parsed) {
          if (parsed.rootCause) f.aiAnalysis = parsed.rootCause;
          if (parsed.suggestedFix) f.suggestedFix = parsed.suggestedFix;
        }
      } catch {
        /* best-effort: heuristic finding stands */
      }
    })
  );
  return findings;
}

export function productJourneyFlags({ status = {}, hasTarget = false, hasEvidence = false } = {}) {
  return [
    true,
    hasTarget,
    status.explored === true,
    status.reviewComplete === true,
    // A committed or promoted contract is not proof that it replayed on the
    // current revision. Only current validation evidence completes this step.
    status.validated === true,
    hasEvidence,
  ];
}

export function operationIsPending(status) {
  return ["queued", "claimed", "running"].includes(String(status || ""));
}

// What a person typed into "What should tapp test?" — classified the same way on the server.
// Order matters: a GitHub URL is a URL, so it is checked before the generic http(s) rule.
export function classifyPrompt(raw) {
  const input = String(raw || "").trim();
  if (!input) return { kind: "empty", value: "" };
  const github = input.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/i) || input.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/);
  if (github && !/^https?:\/\/(?!(?:www\.)?github\.com)/i.test(input) && !input.startsWith("/") && !input.startsWith("~")) {
    return { kind: "github", value: github[1].replace(/\.git$/, "") };
  }
  if (/^https?:\/\//i.test(input)) return { kind: "url", value: input };
  if (/\.apk$/i.test(input)) return { kind: "apk", value: input };
  if (/\.app\/?$/i.test(input) && /[\/~]/.test(input)) return { kind: "app", value: input.replace(/\/$/, "") };
  // Reverse-DNS reads as a bundle id (com.company.app); a hostname puts the TLD last (company.com).
  if (/^(?:com|org|net|io|co|dev|app|ai|me|us|uk|de|fr|se|edu|gov)\.[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/i.test(input)) return { kind: "bundle", value: input };
  if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(input)) return { kind: "url", value: `https://${input}` };
  if (input.startsWith("/") || input.startsWith("~") || input.startsWith("./") || input.startsWith("../")) return { kind: "path", value: input };
  return { kind: "business", value: input };
}

// Renders one engine progress line as a chat line: an emoji and the engine's own words. The
// text is never rewritten beyond trimming; the icon is derived from what the engine said.
const RULES = [
  [/^(?:Opened|Open(?:ing)?) /i, "📍"],
  [/^(?:Reached|Navigated to|Now on) /i, "🧭"],
  [/^(?:Tapped|Tap(?:ping)?|Clicked|Pressed) /i, "👆"],
  [/^(?:Typed|Filled|Entered|Type) /i, "⌨️"],
  [/^(?:Swiped|Swiping|Edge-swiping|Scrolled|Scrolling)/i, "↕️"],
  [/^(?:Went back|Back|Finished with .* going back|Going back)/i, "◀️"],
  [/^(?:Probing|Looking for|Checking)/i, "🔎"],
  [/^(?:Switching to|Switched to)/i, "🗂️"],
  [/sign(?:ed|ing)? in|login|logged in|credentials/i, "🔐"],
  [/screenshot|captured frame|snapshot/i, "📸"],
  [/^(?:Building|Compiling|Build )/i, "🔨"],
  [/^(?:Installing|Installed|Install )/i, "📦"],
  [/^(?:Launching|Launched|Booting|Booted|Starting the app|Opening the)/i, "📱"],
  [/^(?:Cloning|Connected |Cloned)/i, "🐙"],
  [/^(?:Inspecting|Detected|Found \d+ target|Reading the repository)/i, "🔎"],
  [/^(?:Audited|Auditing|Opening .* read-only)/i, "🔍"],
  [/^(?:Exploring|Explore )/i, "🧭"],
  [/^(?:Replaying|Replay |Running flow|Flow )/i, "▶️"],
  [/^(?:Gate|Release gate|Evaluating)/i, "⚖️"],
  [/^\d+\/\d+ actions/i, "⏳"],
  [/waiting|waited|settling/i, "⏳"],
  [/^(?:Timed out|Failed|Error|Could not)/i, "⚠️"],
];

export function narrate(entry = {}, { platform = "" } = {}) {
  const text = String(entry.text || "").trim().replace(/\s+/g, " ");
  if (!text) return null;
  const progress = text.match(/^(\d+)\/(\d+) actions(?: · (\d+) (?:states?|pages?|screens?)[^·]*)?/i);
  if (progress) return { kind: "progress", icon: "⏳", text, current: Number(progress[1]), total: Number(progress[2]), states: progress[3] ? Number(progress[3]) : null };
  for (const [pattern, icon] of RULES) {
    if (pattern.test(text)) {
      const kind = /^(?:Timed out|Failed|Error|Could not)/i.test(text) ? "warning" : "step";
      const deviceIcon = icon === "📱" ? (platform === "web" ? "🌐" : platform === "android" ? "🤖" : "📱") : icon;
      return { kind, icon: deviceIcon, text };
    }
  }
  return { kind: entry.phase && !["explore", "runtime"].includes(entry.phase) ? "phase" : "step", icon: entry.phase === "runtime" ? "⚙️" : "•", text };
}

export function narrateFinding(finding = {}) {
  const severity = String(finding.severity || "info").toLowerCase();
  const icon = { critical: "🔴", high: "🟠", medium: "🟡", low: "⚪️" }[severity] || "•";
  const where = finding.screen ? ` on ${finding.screen}` : "";
  return { kind: "finding", severity, icon, text: `${finding.title || finding.message || finding.type || "Finding"}${where}` };
}

// The summary card at the end of a run: the gate's outcome when there is one, otherwise what the
// engine's headline says it observed. Never a score.
export function summarize(name, result = {}, { access = "" } = {}) {
  const report = result?.report || result;
  const gateOutcome = report?.gate?.outcome || (report?.gate?.failed === true ? "fail" : report?.gate ? "pass" : null);
  if (name === "audit") {
    const issues = result.issueCount || 0;
    // A visitor only ever gets the read-only look; say what the next step is, because the
    // interesting part of any real application is behind its sign-in.
    const next = access === "anonymous" ? " Sign in and tapp will go inside — and ask you for a test account if it meets a sign-in." : "";
    return { tone: issues ? "caution" : "ready", pill: issues ? `${issues} issue${issues === 1 ? "" : "s"} found` : "✓ Nothing broken observed", text: `${result.pagesAudited || 0} page(s) rendered read-only — nothing was clicked. ${issues ? "Each issue is listed in the run detail with the pages it appears on." : "This says the pages are served without structural defects, not that the site works."}${next}` };
  }
  if (gateOutcome) {
    const tone = { pass: "ready", fail: "blocked", inconclusive: "caution" }[gateOutcome] || "caution";
    const pill = { pass: "✓ Ready to merge", fail: "× Do not merge", inconclusive: "◐ Inconclusive" }[gateOutcome];
    return { tone, pill, text: (report.gate?.reasons || [report.headline || "Release gate completed."]).join(" · ") };
  }
  if (report?.inconclusive) return { tone: "caution", pill: "◐ Inconclusive", text: report.headline || "Exploration could not see enough to conclude." };
  if (report?.headline) return { tone: "neutral", pill: `${report.screensExplored || 0} screens · ${report.actionsPerformed || 0} actions · ${(report.findings || []).length} findings`, text: /not a release decision/i.test(report.headline) ? report.headline : `${report.headline} An observation, not a release decision.` };
  return { tone: "neutral", pill: "Done", text: `${name} completed.` };
}

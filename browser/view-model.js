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
    // Two numbers, never merged: what is broken, and what a person would notice and not like.
    const noticed = result.observationCount || 0;
    const pill = issues ? `${issues} issue${issues === 1 ? "" : "s"}${noticed ? ` · ${noticed} to notice` : ""}` : noticed ? `${noticed} thing${noticed === 1 ? "" : "s"} a person would notice` : "✓ Nothing broken observed";
    const noticedText = noticed ? ` It also found ${noticed} thing${noticed === 1 ? "" : "s"} a person would notice — faint text, controls too small to tap on a phone, copy nobody finished — listed under “Worth a look”.` : "";
    return { tone: issues ? "caution" : noticed ? "caution" : "ready", pill, text: `${result.pagesAudited || 0} page(s) rendered read-only — nothing was clicked. ${issues ? "Each issue is listed in the run detail with the pages it appears on." : "Nothing is broken."}${noticedText}${next}` };
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

// ---------------------------------------------------------------------------
// Findings, grouped so a run can be read (TM-794)
// ---------------------------------------------------------------------------
// The engine keeps every finding distinct — its signature is type|screen|target, so two dead
// buttons on one screen stay two findings and fixing one while breaking the other still reads as
// a change. That identity is right for regressions and wrong for reading: one site-wide contrast
// problem arrives as thirty-four lines and buries the two things worth fixing. Grouping is
// therefore a view concern only. Nothing here drops a finding; every one of them is inside a group.

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];
const severityRank = (value) => {
  const index = SEVERITY_ORDER.indexOf(String(value || "info").toLowerCase());
  return index === -1 ? SEVERITY_ORDER.length : index;
};

function prettyType(value) {
  const text = String(value || "finding").replace(/[_-]+/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "Finding";
}

// The group's name is the engine's own words where the group agrees on them: the longest prefix
// every title shares, cut back to a word boundary. Thirty-four titles starting `Hard to read: "…`
// name themselves "Hard to read". When they share too little to be a name, fall back to the type.
function groupLabel(items, type) {
  const titles = items.map((item) => String(item?.title || "")).filter(Boolean);
  if (!titles.length) return prettyType(type);
  if (titles.length === 1) return titles[0];
  let prefix = titles[0];
  for (const title of titles.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < title.length && prefix[index] === title[index]) index += 1;
    prefix = prefix.slice(0, index);
    if (!prefix) break;
  }
  // The shared prefix usually stops inside a word — `Hard to read: "S` for "Services" and
  // "Scope…". Drop that partial word, unless the prefix is a whole title (identical titles on
  // different screens), where the last word really is the engine's and keeping it is right.
  const cut = titles.includes(prefix) ? prefix : prefix.replace(/\S+$/u, "");
  const trimmed = cut.replace(/[\s"'‘’“”:;,.\-—(\[]+$/u, "").trim();
  return trimmed.length >= 8 ? trimmed : prettyType(type);
}

export function groupFindings(findings = []) {
  const groups = new Map();
  for (const finding of findings) {
    if (!finding) continue;
    const type = String(finding.type || finding.category || "finding");
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(finding);
  }
  return [...groups.entries()]
    .map(([type, items]) => {
      const severity = [...items].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0]?.severity || "info";
      const screens = [...new Set(items.map((item) => item.screen).filter(Boolean))];
      return {
        type,
        label: groupLabel(items, type),
        severity: String(severity).toLowerCase(),
        count: items.length,
        screens,
        // Worst first inside the group too, so opening it does not start on a trailing low.
        items: [...items].sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
      };
    })
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.count - a.count || a.label.localeCompare(b.label));
}

// The row of counts above the list, worst kind first. It is counted from the findings
// themselves, so it can never claim a severity the list below it does not show.
export function severityTally(items = []) {
  const counts = new Map();
  for (const item of items) {
    if (!item) continue;
    const severity = String(item.severity || "info").toLowerCase();
    counts.set(severity, (counts.get(severity) || 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => severityRank(a) - severityRank(b))
    .map(([severity, count]) => ({ severity, count }));
}

// ---------------------------------------------------------------------------
// Coverage: the shape of what a run walked through (TM-794)
// ---------------------------------------------------------------------------
// Every capture already holds the map the engine built from its own markers: screens it reached,
// and the action that led from one to the next. Nothing here measures anything — it arranges what
// the engine recorded into columns by distance from the screen the run started on, and joins each
// screen to the stills written beside it. A screen the engine saw but never recorded a way into
// is listed as such rather than quietly placed next to the others.

const screenKey = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// `tap "Pricing"`, `open /solutions`, `back` — the engine's own action, not a sentence about it.
export function transitionLabel(action = {}) {
  const type = String(action?.type || "").trim() || "goes to";
  const target = String(action?.target || "").trim();
  return target ? `${type} “${target}”` : type;
}

export function coverageGraph(uiMap, shots = [], { platform = "" } = {}) {
  const nodes = Array.isArray(uiMap?.nodes) ? uiMap.nodes : [];
  const edges = Array.isArray(uiMap?.edges) ? uiMap.edges : [];
  if (!nodes.length) return { screens: [], columns: [], counts: { screens: 0, transitions: 0 }, entryId: "", unreachable: [] };

  // The stills are named for the screen they are of (`state_3_pricing.png`), which is the node's
  // own key with its separators spelled differently. Match on that and nothing cleverer: a screen
  // with no still shows as a named card, never as a guess at someone else's picture.
  const byKey = new Map();
  for (const shot of shots) {
    const key = screenKey(shot?.caption);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(shot.src);
  }

  const entryId = uiMap?.app?.entryNodes?.[platform] || Object.values(uiMap?.app?.entryNodes || {})[0] || nodes[0].id;
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!outgoing.has(edge?.from)) continue;
    outgoing.get(edge.from).push(edge);
  }

  const depth = new Map([[entryId, 0]]);
  let frontier = [entryId];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      for (const edge of outgoing.get(id) || []) {
        if (!edge?.to || depth.has(edge.to) || !outgoing.has(edge.to)) continue;
        depth.set(edge.to, depth.get(id) + 1);
        next.push(edge.to);
      }
    }
    frontier = next;
  }

  const reachedDepth = Math.max(0, ...[...depth.values()]);
  const unreachable = nodes.filter((node) => !depth.has(node.id)).map((node) => node.id);
  const nameById = new Map(nodes.map((node) => [node.id, node.name || node.semanticKey || node.id]));

  const screens = nodes.map((node) => {
    const key = screenKey(node.semanticKey || node.name);
    // The engine marks a screen it met in a second structural state (`variant`, with the screen it
    // is a state of in `baseSemanticKey`). The stills are captioned by title, so they cannot tell
    // those apart. Fall back to the base screen's still for a variant and say that is what it is,
    // rather than either showing nothing or implying the picture is of this exact state.
    const base = node.variant ? screenKey(node.baseSemanticKey) : "";
    const matched = byKey.get(key) || (base ? byKey.get(base) || [] : []);
    const borrowed = !(byKey.get(key) || []).length && matched.length > 0;
    return {
      id: node.id,
      name: node.stateLabel || node.name || node.semanticKey || "Screen",
      key: node.semanticKey || key,
      variantOf: node.variant ? (node.name || node.baseSemanticKey || "") : "",
      // A screen the run never found a recorded way into sits in a column of its own, after the
      // ones it did — never implied to follow from the last screen simply by being drawn there.
      column: depth.has(node.id) ? depth.get(node.id) : reachedDepth + 1,
      reached: depth.has(node.id),
      shot: matched[0] || null,
      shotCount: matched.length,
      // True when the picture is of this screen in a different state than the one recorded here.
      shotIsOfBaseScreen: borrowed,
      controls: (node.controls || []).length,
      outgoing: (outgoing.get(node.id) || []).map((edge) => ({
        label: transitionLabel(edge.action),
        to: edge.to,
        toName: nameById.get(edge.to) || "",
      })),
    };
  });

  const columns = [];
  for (const screen of screens) {
    (columns[screen.column] ||= []).push(screen.id);
  }

  return {
    screens,
    columns: columns.map((column) => column || []),
    counts: { screens: nodes.length, transitions: edges.length },
    entryId,
    unreachable,
  };
}

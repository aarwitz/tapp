// Pure report/gate logic shared by the MCP server (index.js) and the CI gate CLI
// (ci-report.js). Turns a capture's OCQA markers into the same ship/no-ship report the Tapp
// app produces, and diffs two runs' findings into the CI regression gate. No shell, no server —
// keep it dependency-free so the CI path stays importable and testable.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

export function parseOcqaMarkers(markersFilePath) {
  if (!fs.existsSync(markersFilePath)) {
    return null;
  }

  const raw = fs.readFileSync(markersFilePath, "utf8");
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const counts = {
    STATE: 0,
    ACTION: 0,
    TRANSITION: 0,
    ISSUE: 0,
    PROGRESS: 0,
    COMPLETE: 0,
  };

  const states = [];
  const actions = [];
  const transitions = [];
  const issues = [];
  let complete = null;

  for (const line of lines) {
    if (!line.startsWith("OCQA_")) continue;

    const sep = line.indexOf(":");
    const key = sep >= 0 ? line.slice(0, sep) : line;
    const payload = sep >= 0 ? line.slice(sep + 1).trim() : "";
    const category = key.replace("OCQA_", "");

    if (Object.prototype.hasOwnProperty.call(counts, category)) {
      counts[category] += 1;
    }

    let parsed = payload;
    if (payload.startsWith("{")) {
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = payload;
      }
    }

    if (category === "STATE") states.push(parsed);
    if (category === "ACTION") actions.push(parsed);
    if (category === "TRANSITION") transitions.push(parsed);
    if (category === "ISSUE") issues.push(parsed);
    if (category === "COMPLETE") complete = parsed;
  }

  return {
    markersFilePath,
    relativeMarkersFilePath: path.relative(repoRoot, markersFilePath),
    totalLines: lines.length,
    counts,
    uniqueScreens: Array.from(
      new Set(
        states
          .map((state) => (state && typeof state === "object" ? state.screen : null))
          .filter((screen) => typeof screen === "string" && screen.trim().length > 0)
      )
    ),
    complete,
    recentActions: actions.slice(-5),
    recentTransitions: transitions.slice(-5),
    recentIssues: issues.slice(-5),
  };
}

// Map harness OCQA_ISSUE `type` -> Tapp FindingCategory. Crashes are always critical.
export const ISSUE_CATEGORY = {
  crash: "crash",
  app_hang: "app_hang",
  auth_failed: "auth_failure",
  submit_failed: "unresponsive_element",
  error_surface: "network_error_surface",
  unresponsive_element: "unresponsive_element",
  dead_end: "navigation_dead_end",
  navigation_loop: "repeated_loop",
  navigation_trap: "navigation_dead_end",
  blank_screen: "blank_screen",
  limited_surface: "blank_screen",
  performance_timeout: "performance_timeout",
  explore_timeout: "performance_timeout",
};
export const CRITICAL_ISSUE_TYPES = new Set(["crash"]);

export function severityRank(s) {
  return { critical: 0, high: 1, medium: 2, low: 3 }[s] ?? 4;
}

// Turn a capture's OCQA markers into the same ship/no-ship report Tapp produces:
// deduped findings + a trustworthy verdict with a coverage floor (mirrors OrchestratorService).
export function buildQaReport(markersFilePath, { platform = "ios" } = {}) {
  const base = parseOcqaMarkers(markersFilePath);
  if (!base) return null;

  const raw = fs.readFileSync(markersFilePath, "utf8");
  const rawIssues = [];
  const screens = new Set();
  const inputsByScreen = new Map();
  const screenElementCounts = {}; // screen -> max elements observed (content-collapse detection)
  let anySecure = false;
  let actions = 0;

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("OCQA_ISSUE:")) {
      try {
        const o = JSON.parse(t.slice("OCQA_ISSUE:".length));
        let sev = String(o.severity || "medium").toLowerCase();
        if (CRITICAL_ISSUE_TYPES.has(o.type)) sev = "critical";
        // `target` gives a finding its identity beyond type|screen — two dead buttons on the
        // same screen are two findings, and fixing one while breaking another is a regression.
        const target = (typeof o.control === "string" && o.control) || (typeof o.target === "string" && o.target) || null;
        rawIssues.push({ type: o.type, severity: sev, title: o.title, screen: o.screen || null, target, step: o.step ?? null });
      } catch {
        /* ignore malformed */
      }
    } else if (t.startsWith("OCQA_ACTION:")) {
      actions += 1;
    } else if (t.startsWith("OCQA_STATE:{")) {
      try {
        const s = JSON.parse(t.slice("OCQA_STATE:".length));
        if (typeof s.screen === "string" && s.screen.trim()) screens.add(s.screen);
        if (typeof s.screen === "string" && s.screen.trim() && Number.isFinite(s.elements)) {
          screenElementCounts[s.screen] = Math.max(screenElementCounts[s.screen] || 0, s.elements);
        }
        if (typeof s.screen === "string" && Array.isArray(s.inputs) && s.inputs.length) {
          const fields = s.inputs
            .map((f) => ({ label: f.label || f.placeholder || f.key || "", secure: !!f.secure }))
            .filter((f) => f.label);
          if (fields.length && !inputsByScreen.has(s.screen)) inputsByScreen.set(s.screen, fields);
          if (fields.some((f) => f.secure)) anySecure = true;
        }
      } catch {
        /* ignore */
      }
    }
  }

  const inputFieldsEncountered = Array.from(inputsByScreen.entries()).map(([screen, fields]) => ({ screen, fields }));

  // Dedup by stable signature (type|screen|target) so repeated detections count once —
  // but DIFFERENT controls failing on the same screen each count.
  const seen = new Set();
  const findings = [];
  for (const i of rawIssues) {
    const key = `${i.type}|${i.screen}|${i.target ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ ...i, category: ISSUE_CATEGORY[i.type] || i.type });
  }
  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  const screensExplored = screens.size || base.uniqueScreens.length;
  const actionsPerformed =
    actions || (base.complete && typeof base.complete === "object" ? base.complete.actions || 0 : 0);
  const crit = findings.filter((f) => f.severity === "critical").length;
  const high = findings.filter((f) => f.severity === "high").length;
  const med = findings.filter((f) => f.severity === "medium").length;
  const low = findings.filter((f) => f.severity === "low").length;

  // Coverage floor: a verdict is only trustworthy if the app was actually exercised.
  const inconclusive = screensExplored < 2 || actionsPerformed < 3;
  let confidence = Math.max(0, Math.min(100, 100 - crit * 25 - high * 10 - med * 3));
  if (inconclusive) confidence = Math.min(confidence, 40);

  let verdict;
  if (crit > 0) verdict = "blocked";
  else if (inconclusive) verdict = "caution";
  else if (confidence < 50) verdict = "blocked";
  else if (high > 0 || confidence < 80) verdict = "caution";
  else verdict = "ready";

  const headline = inconclusive
    ? `Inconclusive — only ${screensExplored} screen(s) / ${actionsPerformed} action(s) explored. The app may have crashed on launch, be stuck behind a sign-in wall, or otherwise prevent exploration. Absence of issues is NOT a pass.`
    : verdict === "ready"
    ? "Ship-ready — no release-blocking issues found."
    : verdict === "caution"
    ? `Proceed with caution — ${findings.length} issue(s) to review.`
    : `Not ready — ${findings.length} issue(s): ${crit} critical, ${high} high, ${med} medium, ${low} low.`;

  // The verdict's own honesty label: exactly which defect classes this run checked, which
  // it structurally could NOT check, and which conditions never came up — so "checked" is
  // never claimed for a state the run didn't reach. Platform-aware: a web run doesn't
  // inherit iOS keyboard assertions and vice versa.
  const conditionsNotReached = [];
  let checkedFor;
  let notChecked;
  if (platform === "web") {
    checkedFor = [
      "page errors (uncaught exceptions)", "failed/5xx requests", "broken links (404)",
      "dead buttons", "error text on pages", "load timeouts",
    ];
    notChecked = [
      "app-specific business logic (cover with Flows: record or generate, then assert)",
      "visual correctness — layout/images/clipping (vision review; needs an API key)",
      "only the first few visible buttons per page are probed (web beta)",
      "content & reachability regressions require a baseline",
    ];
  } else if (platform === "android") {
    checkedFor = [
      "crashes / process exits", "dead controls", "error surfaces", "blank screens",
      "navigation reachability", "form interaction",
    ];
    notChecked = [
      "app-specific business logic (cover with committed Flows)",
      "visual correctness — layout/images/clipping",
      "push notifications / system integrations",
      "content & reachability regressions require a baseline",
    ];
  } else {
    checkedFor = [
      "crashes (launch + in-run)", "hangs / stuck loading",
      "dead controls (incl. navigation)", "error surfaces", "blank screens",
      "navigation traps/loops", "keyboard-covered actions",
      "lost field state (persistent-class fields)",
    ];
    notChecked = [
      "app-specific business logic (cover with Flows: record or generate, then assert)",
      "visual correctness — layout/images/clipping (vision review; needs an API key)",
      "push notifications / system integrations",
      "content & reachability regressions require a baseline" ,
    ];
  }
  // "Failed sign-ins" is only a claim when a sign-in surface was actually encountered.
  if (anySecure) checkedFor.splice(2, 0, "failed sign-ins");
  else conditionsNotReached.push("sign-in (no login form encountered this run)");

  return {
    verdict,
    // `releaseScore` is the honest name: a heuristic quality score from fixed deductions,
    // NOT calibrated statistical confidence. `confidence` is kept as an alias for
    // compatibility (baselines, desktop app, existing consumers).
    confidence,
    releaseScore: confidence,
    headline,
    inconclusive,
    checkedFor,
    notChecked,
    conditionsNotReached,
    platform,
    screensExplored,
    actionsPerformed,
    findingCounts: { critical: crit, high, medium: med, low, total: findings.length },
    findings,
    screens: Array.from(screens),
    screenElementCounts,
    inputFieldsEncountered,
    loginEncountered: anySecure,
    complete: base.complete,
    relativeMarkersFilePath: base.relativeMarkersFilePath,
  };
}

// Content-collapse regression: screens that were rich in the baseline but are near-empty now.
// The app "works" (renders, navigates, no errors) while its content pipeline is broken — the
// class NO per-run detector can catch deterministically (a silent empty feed looks like a legit
// empty state). Cross-run, it's unambiguous. Found via corpus bug-seeding: a broken API host in
// a real HN client produced SHIP-READY 100/100 until this comparison existed.
const COLLAPSE_MIN_BASELINE = 10; // only screens that clearly HAD content
const COLLAPSE_RATIO = 0.4;       // current below 40% of baseline = collapsed
export function computeContentCollapse(currentCounts, baselineCounts) {
  if (!currentCounts || !baselineCounts) return [];
  const findings = [];
  for (const [screen, base] of Object.entries(baselineCounts)) {
    const cur = currentCounts[screen];
    if (cur === undefined || base < COLLAPSE_MIN_BASELINE) continue;
    if (cur <= base * COLLAPSE_RATIO) {
      findings.push({
        type: "content_collapse",
        severity: "high",
        category: "content_collapse",
        title: `Screen lost most of its content (${base} → ${cur} elements)`,
        screen,
        step: null,
      });
    }
  }
  return findings;
}

// Reachability-loss regression: screens the baseline explored that this run never reached
// at all. Content-collapse can't see them (nothing to compare against) — but a screen
// vanishing from the same-budget exploration usually means navigation regressed (a dead
// back button trapping the explorer, a broken link, a crash short-circuiting a flow).
// Found via subtle-bug seeding: a dead back button stranded the run on one screen and
// SHIP-READY passed with 3 of 6 baseline screens missing. Guarded: only fires when the
// current run had a comparable action budget (≥60% of baseline actions), so a legit
// short run doesn't spray false losses.
export function computeReachabilityLoss(current, baseline) {
  if (!current?.screens || !baseline?.screens) return [];
  const baseActions = baseline.actionsPerformed || 0;
  if (baseActions > 0 && (current.actionsPerformed || 0) < baseActions * 0.6) return [];
  const reached = new Set(current.screens);
  return baseline.screens
    .filter((s) => !reached.has(s))
    .map((screen) => ({
      type: "screen_unreachable",
      severity: "high",
      category: "navigation_dead_end",
      title: "Screen explored in the baseline was never reached this run",
      screen,
      step: null,
    }));
}

// Cross-run regression: diff this run's deduped findings against a baseline (the `findings` array a
// prior tapp_run_qa returned), matched by the same stable signature the dedup uses (type|screen).
// Mirrors the Swift FindingRegression.compute. Returns null when no baseline is supplied (first run).
// The `gate` block is the CI signal: a wrapper sets a non-zero exit when gate.failed is true.
export function computeRegression(current, baseline) {
  if (!Array.isArray(baseline)) return null;
  // Identity is type|screen|target when a target (control id) is known — type|screen alone
  // would classify "Save fixed, Delete Account newly broken on Settings" as one persisting
  // dead_button and let the new defect through the gate. Coarse matching remains as a
  // migration fallback ONLY when one side predates target identity (old baselines), so
  // upgrading never sprays false "new" findings.
  const fine = (f) => `${f.type}|${f.screen ?? null}|${f.target ?? ""}`;
  const coarse = (f) => `${f.type}|${f.screen ?? null}`;
  const baseFine = new Set(baseline.map(fine));
  const baseCoarseAll = new Set(baseline.map(coarse));
  const baseCoarseNoTarget = new Set(baseline.filter((f) => f.target == null).map(coarse));
  const currFine = new Set(current.map(fine));
  const currCoarseAll = new Set(current.map(coarse));
  const currCoarseNoTarget = new Set(current.filter((f) => f.target == null).map(coarse));

  const currentMatches = (f) =>
    baseFine.has(fine(f)) ||
    (f.target == null && baseCoarseAll.has(coarse(f))) ||
    (f.target != null && baseCoarseNoTarget.has(coarse(f)));
  const baselineMatched = (b) =>
    currFine.has(fine(b)) ||
    (b.target == null && currCoarseAll.has(coarse(b))) ||
    (b.target != null && currCoarseNoTarget.has(coarse(b)));

  const newFindings = current.filter((f) => !currentMatches(f));
  const persisting = current.filter((f) => currentMatches(f));
  const resolved = baseline.filter((b) => !baselineMatched(b));
  const newCritical = newFindings.filter((f) => f.severity === "critical").length;
  const newHigh = newFindings.filter((f) => f.severity === "high").length;

  return {
    hadBaseline: true,
    counts: { new: newFindings.length, persisting: persisting.length, resolved: resolved.length },
    newFindings,
    resolved,
    // CI gate: fail the build when this run introduced new high/critical findings vs. the baseline.
    gate: { newCritical, newHigh, failed: newCritical + newHigh > 0 },
  };
}

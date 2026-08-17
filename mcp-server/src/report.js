// Pure report/gate logic shared by the MCP server (index.js) and the CI gate CLI
// (ci-report.js). Turns a capture's OCQA markers into a scoreless exploration observation,
// and applies explicit policy separately in the CI gate. No shell, no server —
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
  placeholder_link: "broken_link",
  dead_end: "navigation_dead_end",
  navigation_loop: "repeated_loop",
  navigation_trap: "navigation_dead_end",
  blank_screen: "blank_screen",
  limited_surface: "blank_screen",
  performance_timeout: "performance_timeout",
  explore_timeout: "performance_timeout",
};
export const CRITICAL_ISSUE_TYPES = new Set(["crash"]);
export const WEB_SAMPLED_ISSUE_TYPES = new Set(["unresponsive_element"]);

export function severityRank(s) {
  return { critical: 0, high: 1, medium: 2, low: 3 }[s] ?? 4;
}

export function findingEvaluationTier(finding, platform = "ios") {
  return platform === "web" && WEB_SAMPLED_ISSUE_TYPES.has(finding?.type) ? "sampled" : "deterministic";
}

// The deterministic block-by-findings rule, expressed over verdict-tier finding COUNTS — not the
// score scalar and not the `verdict` label — so the CI gate survives removal of verdict/releaseScore
// from exploration output. It encodes exactly what `verdict === "blocked"` used to: a critical
// finding always blocks; otherwise, on a CONCLUSIVE run, a risk threshold blocks. The risk threshold
// is kept as an explicit, chosen rule (ADR-0005) — `riskFromCounts` is the single source of that
// formula, shared with buildQaReport's verdict label. Inconclusive runs are a separate gate outcome,
// never a findings-block, so a thin run reports `inconclusive`, not `fail`.
export function riskFromCounts({ critical = 0, high = 0, medium = 0 } = {}) {
  return Math.max(0, Math.min(100, 100 - critical * 25 - high * 10 - medium * 3));
}
export function findingsBlock(deterministicFindingCounts = {}, { inconclusive = false } = {}) {
  if ((deterministicFindingCounts.critical || 0) > 0) return true;
  if (inconclusive) return false;
  return riskFromCounts(deterministicFindingCounts) < 50;
}

// Exploration OBSERVES; it never renders a ship verdict or score (ADR-0005). These label the
// observation honestly. The release decision (pass/fail/inconclusive) is the gate's, shown separately.
export function observationBadge(report) {
  return report?.inconclusive ? "🟡 INCONCLUSIVE (exploration)" : "🔭 EXPLORED";
}

export function observationSummary(report) {
  const n = report?.findingCounts?.total || 0;
  return `${report?.screensExplored || 0} screens · ${report?.actionsPerformed || 0} actions · ${n} finding(s) · observation only`;
}

// Turn a capture's OCQA markers into a scoreless observation with deduped findings and an
// explicit coverage floor. Release judgment is applied later by evaluateGate.
export function buildQaReport(markersFilePath, { platform = "ios", target = null } = {}) {
  const base = parseOcqaMarkers(markersFilePath);
  if (!base) return null;

  const raw = fs.readFileSync(markersFilePath, "utf8");
  const rawIssues = [];
  const screens = new Set();
  const inputsByScreen = new Map();
  const screenElementCounts = {}; // screen -> max elements observed (content-collapse detection)
  let anySecure = false;
  let loginAttempted = false;
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
      try {
        const action = JSON.parse(t.slice("OCQA_ACTION:".length));
        if (action?.type === "login" || String(action?.type || "").startsWith("login_")) loginAttempted = true;
      } catch {
        /* ignore malformed */
      }
    } else if (
      t === "OCQA_STATE:login_preamble_submitted" ||
      t === "OCQA_STATE:login_preamble_two_step_submitted"
    ) {
      loginAttempted = true;
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

  // Web resource failures belong to the resource, not every route that referenced it.
  // Chromium can also surface one 404 through both response and requestfailed listeners;
  // keep the concrete missing-asset finding and discard that transport-level duplicate.
  const normalizedIssues = rawIssues.map((issue) => {
    if (platform !== "web") return issue;
    if (issue.type === "placeholder_link" && issue.target) return { ...issue, screen: null };
    if (!["missing_asset", "network_error"].includes(issue.type)) return issue;
    const title = String(issue.title || "");
    const match = issue.type === "missing_asset"
      ? title.match(/^404 asset:\s+(\S+)/i)
      : title.match(/^Request failed:\s+(\S+)/i);
    const resource = String(issue.target || match?.[1] || "").replace(/[?#].*$/, "");
    return resource ? { ...issue, screen: null, target: resource } : issue;
  });
  const missingResources = new Set(normalizedIssues
    .filter((issue) => issue.type === "missing_asset" && issue.target)
    .map((issue) => issue.target));
  // Older native captures represented the caller's wall-clock budget as a high-severity app
  // finding. A timeout makes the evidence partial/inconclusive; it does not prove an app
  // performance defect (the harness has a separate app_hang detector for that).
  const timeBudgetExhausted = base.complete?.timedOut === true || normalizedIssues.some((issue) => issue.type === "explore_timeout");
  const reportIssues = normalizedIssues.filter((issue) =>
    issue.type !== "explore_timeout" &&
    !(issue.type === "network_error" && issue.target && missingResources.has(issue.target) && /^Request failed:/i.test(String(issue.title || ""))));

  // Dedup by stable signature (type|screen|target) so repeated detections count once —
  // but DIFFERENT controls failing on the same screen each count.
  const seen = new Set();
  const findings = [];
  for (const i of reportIssues) {
    const key = `${i.type}|${i.screen}|${i.target ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      ...i,
      category: ISSUE_CATEGORY[i.type] || i.type,
      // Structural evidence authority (ADR-0005): marker-derived findings are deterministic. The
      // default gate consumes only deterministic-authority evidence; model-observed findings
      // (vision/assert_ai) carry authority:"model-observed" and are advisory, never gate fails.
      authority: "deterministic",
      ...(platform === "web" ? { evaluationTier: findingEvaluationTier(i, platform) } : {}),
    });
  }
  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  const screensExplored = screens.size || base.uniqueScreens.length;
  // Some native recovery operations are counted by the harness budget but intentionally do not
  // emit a public action narrative. Preserve the larger authoritative completion count instead of
  // understating coverage whenever at least one narrated action exists.
  const actionsPerformed = Math.max(
    actions,
    base.complete && typeof base.complete === "object" ? base.complete.actions || 0 : 0,
  );
  const crit = findings.filter((f) => f.severity === "critical").length;
  const high = findings.filter((f) => f.severity === "high").length;
  const med = findings.filter((f) => f.severity === "medium").length;
  const low = findings.filter((f) => f.severity === "low").length;
  const verdictFindings = platform === "web"
    ? findings.filter((finding) => finding.evaluationTier !== "sampled")
    : findings;
  const verdictCrit = verdictFindings.filter((f) => f.severity === "critical").length;
  const verdictHigh = verdictFindings.filter((f) => f.severity === "high").length;
  const verdictMed = verdictFindings.filter((f) => f.severity === "medium").length;
  const verdictLow = verdictFindings.filter((f) => f.severity === "low").length;
  const sampledFindings = platform === "web" ? findings.filter((finding) => finding.evaluationTier === "sampled") : [];

  // Coverage floor: exploration is inconclusive if the app wasn't actually exercised. Exploration
  // OBSERVES — it does not render a ship verdict or score (ADR-0005). Judgment (pass/fail/
  // inconclusive) is the gate's job (evaluateGate), computed from these findings + coverage + policy.
  // A one-page web target can still be swept exhaustively: page errors, requests, links, assets,
  // placeholder anchors, and visible controls do not require a second route. Native exploration
  // retains the stronger multi-screen/action floor. A credentialless single-screen login remains
  // inconclusive so a login wall can never turn into a clean pass.
  const coverageFloorMet = platform === "web"
    ? screensExplored >= 1 && actionsPerformed >= 1
    : screensExplored >= 2 && actionsPerformed >= 3;
  const credentiallessLoginWall = anySecure && !loginAttempted && screensExplored <= 1;
  const inconclusive = !coverageFloorMet || credentiallessLoginWall || timeBudgetExhausted;
  const stopReason = credentiallessLoginWall ? "login-wall-no-credentials"
    : timeBudgetExhausted ? "time-budget-exhausted"
    : coverageFloorMet ? "completed" : "coverage-floor-not-met";

  const headline = timeBudgetExhausted
    ? `Inconclusive — exploration reached its ${base.complete?.timeoutSeconds || "configured"}s time budget after ${actionsPerformed} action(s) across ${screensExplored} screen(s). Findings are partial; this is not an app performance finding. Increase --timeout or request fewer actions.`
    : inconclusive
    ? `Inconclusive — only ${screensExplored} screen(s) / ${actionsPerformed} action(s) explored. The app may have crashed on launch, be stuck behind a sign-in wall, or otherwise prevent exploration. Absence of issues is NOT a pass.`
    : findings.length === 0
    ? platform === "web"
      ? "Automated web checks completed — no deterministic findings in the exercised surfaces. Sampled control probes are advisory. An observation, not a release decision, and not a content, privacy, brand, or business-claim review."
      : "No issues surfaced in the exercised surfaces. An observation, not a release decision."
    : `${findings.length} issue(s) surfaced for review (${crit} critical, ${high} high, ${med} medium, ${low} low). An observation, not a release decision.`;

  // The observation's honesty label: exactly which defect classes this run checked, which
  // it structurally could NOT check, and which conditions never came up — so "checked" is
  // never claimed for a state the run didn't reach. Platform-aware: a web run doesn't
  // inherit iOS keyboard assertions and vice versa.
  const conditionsNotReached = [];
  let checkedFor;
  let notChecked;
  if (platform === "web") {
    checkedFor = [
      "page errors (uncaught exceptions)", "failed/5xx requests", "broken links (404)",
      "placeholder links with no destination", "sampled dead-button probes (advisory)", "error text on pages", "load timeouts",
    ];
    notChecked = [
      "app-specific business logic (cover with Flows: record or generate, then assert)",
      "content and claim accuracy (including copy versus API data)",
      "privacy or API data minimization",
      "brand and SEO consistency",
      "visual credibility or asset quality (vision review; needs an API key)",
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
  // "Failed sign-ins" is only a claim when credentials were actually submitted. Merely seeing a
  // password field proves that a login surface was reached, not that authentication was exercised.
  if (loginAttempted) checkedFor.splice(2, 0, "failed sign-ins");
  else if (anySecure) notChecked.push("sign-in behavior (login form reached, no test credentials supplied)");
  else conditionsNotReached.push("sign-in (no login form encountered this run)");
  if (timeBudgetExhausted) notChecked.push("the full requested action budget (run reached its wall-clock timeout)");

  return {
    // An ExplorationRun observation: findings + coverage + evidence, NO ship verdict or score
    // (ADR-0005). The gate (evaluateGate) turns this into a pass/fail/inconclusive release outcome.
    kind: "tapp-exploration-run",
    schemaVersion: 1,
    // Complete ExplorationRun contract (ADR-0005 §4). runStatus/stopReason describe HOW the run
    // ended; coverage/evidence/uiMap/comparison are the structured observation. uiMap and comparison
    // are populated by consumers that build the map / diff a baseline (null in the bare observation).
    runStatus: inconclusive ? "limited" : "completed",
    stopReason,
    headline,
    inconclusive,
    coverage: { screensExplored, actionsPerformed, screens: Array.from(screens) },
    evidence: { markers: base.relativeMarkersFilePath },
    uiMap: null,
    comparison: null,
    checkedFor,
    notChecked,
    conditionsNotReached,
    platform,
    target: typeof target === "string" && target.trim() ? target.trim() : null,
    screensExplored,
    actionsPerformed,
    findingCounts: { critical: crit, high, medium: med, low, total: findings.length },
    deterministicFindingCounts: {
      critical: verdictCrit,
      high: verdictHigh,
      medium: verdictMed,
      low: verdictLow,
      total: verdictFindings.length,
    },
    sampledFindingCounts: {
      critical: sampledFindings.filter((f) => f.severity === "critical").length,
      high: sampledFindings.filter((f) => f.severity === "high").length,
      medium: sampledFindings.filter((f) => f.severity === "medium").length,
      low: sampledFindings.filter((f) => f.severity === "low").length,
      total: sampledFindings.length,
    },
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
        authority: "deterministic",
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
      authority: "deterministic",
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

  // Comparison ONLY — no gate/pass/fail signal (ADR-0005). Exploration surfaces this diff; the merge
  // decision is the gate's job. evaluateGate derives its regression fail from `newFindings` severities.
  return {
    hadBaseline: true,
    counts: { new: newFindings.length, persisting: persisting.length, resolved: resolved.length },
    newFindings,
    resolved,
  };
}

// The gate's public outcome model (ADR-0005). A merge gate is ultimately block / don't-block, but
// callers need to distinguish WHY: a deterministic violation is not the same as "we couldn't get
// the evidence." Exit codes are the CI contract; precedence is fail > inconclusive > pass.
export const GATE_EXIT = { pass: 0, fail: 1, error: 2, inconclusive: 3 };
// Bump when the gate's decision semantics change (NOT the npm version). Recorded on every GateRun.
export const GATE_POLICY_VERSION = "2";

// Pure gate evaluator: frozen evidence + policy → a GateRun decision. Extracted verbatim from the
// former inline logic in ci-report.js so the `[char]` characterization tests keep passing — the
// merge decision (block/don't-block) is unchanged; this only classifies each reason as a
// deterministic `fail` or an evidence-absent `inconclusive` and folds them by precedence. Reason
// MESSAGES are preserved exactly (several are asserted by tests).
//
// DECOUPLED FROM THE SCORE (ADR-0005): the block-by-findings decision reads `deterministicFindingCounts` +
// `inconclusive` via `findingsBlock`, NOT the score scalar or the `verdict` label. `verdict`/
// `releaseScore` can therefore be removed from exploration output without changing any merge
// decision. The `riskScore < 50` threshold is retained deliberately (kept explicit, inside
// `findingsBlock`) and locked by the `[char]` risk-threshold test.
export function evaluateGate({ report, regression = null, flows = [], scenarios = [], contracts = [], prPlan = null, baseline = null, failOn = "gate" } = {}) {
  const reasons = []; // { kind: "fail" | "inconclusive", message }
  const fail = (message) => reasons.push({ kind: "fail", message });
  const inconclusive = (message) => reasons.push({ kind: "inconclusive", message });

  // Classify each replayed suite by evidence authority (ADR-0005): a DETERMINISTIC step failure (or
  // a non-model failure like an aborted/missing run) is a real fail; a suite with no deterministic
  // failure that carries a model-observed (assert_ai) assertion cannot be decided by the default
  // deterministic gate → inconclusive/needs-review (it must not silently pass, and a model verdict
  // must not masquerade as a deterministic fail). No `--policy probabilistic` opt-in in 0.17.
  const deterministicFail = (s) => s.deterministicFailed === true || (s.passed === false && !s.modelObserved);
  const classify = (s) => (deterministicFail(s) ? "fail" : s.modelObserved ? "needs-review" : "pass");
  for (const [label, suites] of [["flow", flows], ["multi-actor scenario", scenarios], ["release contract", contracts]]) {
    const failed = suites.filter((s) => classify(s) === "fail");
    if (failed.length) fail(`${failed.length} ${label}(s) failed`);
    const needsReview = suites.filter((s) => classify(s) === "needs-review");
    if (needsReview.length) inconclusive(`${needsReview.length} ${label}(s) contain assert_ai (model-observed); the deterministic gate cannot decide them — review, or add an explicit probabilistic policy`);
  }
  // A submitted sign-in that remains on the login surface is an explicit exercised guarantee,
  // not ordinary pre-existing UI debt. Letting it pass without a baseline would produce the
  // contradictory public result "failed sign-in detected" + gate PASS. Keep sampled probes out,
  // but fail every deterministic auth failure under every gate policy (including with a baseline).
  const authFailures = (report.findings || []).filter((finding) =>
    finding?.type === "auth_failed" &&
    finding?.authority !== "model-observed" &&
    finding?.evaluationTier !== "sampled"
  );
  if (authFailures.length) fail(`${authFailures.length} deterministic sign-in attempt(s) failed`);
  // Selected-but-unexecuted work is missing evidence, not an observed violation → inconclusive.
  if (prPlan?.execution?.notRun) inconclusive(`${prPlan.execution.notRun} selected release contract(s) did not run`);
  if (prPlan?.execution?.explorationFailed) inconclusive(`${prPlan.execution.explorationFailed} planned PR exploration target(s) failed or were not reached`);

  if (failOn === "any") {
    if (report.findingCounts.total > 0) fail(`${report.findingCounts.total} finding(s) (fail-on: any)`);
    // "any" is the strictest policy — an inconclusive run (evidence not obtained) must never pass it.
    if (report.inconclusive) inconclusive("run was inconclusive (coverage floor not met)");
  } else if (failOn === "absolute" || (failOn === "gate" && !regression)) {
    if (findingsBlock(report.deterministicFindingCounts, { inconclusive: report.inconclusive })) fail("blocking deterministic finding(s)");
    if (report.inconclusive) inconclusive("run was inconclusive (coverage floor not met)");
  } else {
    if (regression?.newFindings?.length) {
      const newCritical = regression.newFindings.filter((f) => f.severity === "critical").length;
      const newHigh = regression.newFindings.filter((f) => f.severity === "high").length;
      if (newCritical + newHigh > 0) fail(`${newCritical} new critical + ${newHigh} new high vs. baseline`);
    }
    if (findingsBlock(report.deterministicFindingCounts, { inconclusive: report.inconclusive })) fail("blocking deterministic finding(s)");
    if (report.inconclusive && !baseline?.inconclusive) inconclusive("run became inconclusive vs. baseline (app may no longer launch/explore)");
  }

  const outcome = reasons.some((r) => r.kind === "fail") ? "fail"
    : reasons.some((r) => r.kind === "inconclusive") ? "inconclusive"
    : "pass";
  return {
    policy: failOn,
    outcome,
    exitCode: GATE_EXIT[outcome],
    failed: outcome !== "pass", // retained for markdown/JSON consumers during migration
    reasons: reasons.map((r) => r.message),
    reasonDetails: reasons,
    policyVersion: GATE_POLICY_VERSION,
  };
}

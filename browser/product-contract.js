// Executable contract for Tapp's one browser surface: the Studio served by `tapp app`.
// It is a run viewer — start a run against a repository target or a URL, watch it live, open
// its evidence — not a second Command Center (ADR-0006, owner decision of 2026-10-15). The
// hosted control plane embeds these same assets unchanged.
export const customerProductContract = Object.freeze({
  schemaVersion: 2,
  product: "Tapp",
  interface: "customer-browser",
  // What tapp has a driver for — this list is what the engine can actually drive (ADR-0010).
  // Windows desktop is not a target (owner decision, 2026-11-25).
  targetPlatforms: ["ios", "android", "web", "macos"],
  // A repository is opened by path (`tapp app /path/to/repo`); a website by URL in the Studio.
  repositorySources: ["local-path", "github"],
  entryLayers: ["repository", "website"],
  views: [
    { id: "overview", label: "Overview", capabilities: ["target-selection", "release-check", "live-feed", "progress-transcript", "live-session", "flow-recording", "latest-evidence"] },
    { id: "runs", label: "Runs", capabilities: ["run-history", "run-detail", "evidence-page", "website-audit"] },
    // Findings and Coverage are how a run is READ. The engine keeps every finding distinct, by
    // type|screen|target, so a regression stays visible; that same identity makes one site-wide
    // problem arrive as thirty-four lines. Findings groups them for reading and drops none of
    // them. Coverage draws the screens the run reached, and the action between each pair, from
    // the map the engine already wrote beside the run. Neither measures anything, and neither
    // judges: they show what a run recorded (TM-794, restoring what ADR-0006 moved out on
    // 2026-10-15 — the report page kept the findings but never had the map).
    { id: "findings", label: "Findings", capabilities: ["finding-groups", "finding-detail", "run-selection"] },
    { id: "coverage", label: "Coverage", capabilities: ["screen-map", "transition-labels", "run-selection"] },
    // Only an owner of this deployment ever sees this one (TAPP_ADMIN_EMAILS); to anybody else
    // the nav item is absent and the route is a 404.
    // Says what tapp drives, what THIS Studio can start, and what to do about the difference.
    { id: "platforms", label: "Platforms", capabilities: ["platform-matrix", "self-host-command", "platform-interest"] },
    { id: "admin", label: "Admin", capabilities: ["deployment-usage", "account-list", "platform-demand"] },
  ],
  operations: ["initialize", "session-start", "session-act", "session-save-flow", "session-end", "gate", "audit", "agent", "agent-stop"],
  invariants: [
    "The Studio shows runs; it never scores or judges them. Only the deterministic gate decides.",
    "Every run's evidence is the report.html the engine wrote; the Studio links to it rather than re-rendering it.",
    "A website audit is read-only: nothing is clicked, typed, submitted, or hovered.",
    "Repositories are opened from the machine the Studio runs on; nothing is uploaded or cloned by the Studio.",
    "Deterministic replay and ordinary merge decisions are keyless.",
    "The admin view reports counts about this deployment; credentials are encrypted and are never decrypted to be shown.",
    "Findings groups for reading only: every finding the engine reported is inside exactly one group, and grouping never changes what was found or how a finding is identified.",
    "Coverage draws only transitions the engine recorded. A screen it reached with no recorded way in is shown as such, never implied to follow from the screen drawn beside it.",
    "The Platforms view states what this machine can start, computed from the machine; a platform with no driver says so in those words and is never described as needing different hardware.",
  ],
});

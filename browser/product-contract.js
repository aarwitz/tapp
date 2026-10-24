// Executable contract for Tapp's one browser surface: the Studio served by `tapp app`.
// It is a run viewer — start a run against a repository target or a URL, watch it live, open
// its evidence — not a second Command Center (ADR-0006, owner decision of 2026-10-15). The
// hosted control plane embeds these same assets unchanged.
export const customerProductContract = Object.freeze({
  schemaVersion: 2,
  product: "Tapp",
  interface: "customer-browser",
  targetPlatforms: ["ios", "android", "web"],
  // A repository is opened by path (`tapp app /path/to/repo`); a website by URL in the Studio.
  repositorySources: ["local-path", "github"],
  entryLayers: ["repository", "website"],
  views: [
    { id: "overview", label: "Overview", capabilities: ["target-selection", "release-check", "live-feed", "progress-transcript", "live-session", "flow-recording", "latest-evidence"] },
    { id: "runs", label: "Runs", capabilities: ["run-history", "run-detail", "evidence-page", "website-audit"] },
    // Only an owner of this deployment ever sees this one (TAPP_ADMIN_EMAILS); to anybody else
    // the nav item is absent and the route is a 404.
    { id: "admin", label: "Admin", capabilities: ["deployment-usage", "account-list"] },
  ],
  operations: ["initialize", "session-start", "session-act", "session-save-flow", "session-end", "gate", "audit"],
  invariants: [
    "The Studio shows runs; it never scores or judges them. Only the deterministic gate decides.",
    "Every run's evidence is the report.html the engine wrote; the Studio links to it rather than re-rendering it.",
    "A website audit is read-only: nothing is clicked, typed, submitted, or hovered.",
    "Repositories are opened from the machine the Studio runs on; nothing is uploaded or cloned by the Studio.",
    "Deterministic replay and ordinary merge decisions are keyless.",
    "The admin view reports counts about this deployment; credentials are encrypted and are never decrypted to be shown.",
  ],
});

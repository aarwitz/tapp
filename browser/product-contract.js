// Executable contract for Tapp's one browser surface: the Studio served by `tapp app`.
// It is a run viewer — start a run against a repository target or a URL, watch it live, open
// its evidence — not a second Command Center (ADR-0006, owner decision of 2026-10-15). The
// hosted control plane embeds these same assets unchanged.
export const customerProductContract = Object.freeze({
  schemaVersion: 2,
  product: "Tapp",
  interface: "customer-browser",
  // What tapp has a driver for. macOS and Windows desktop applications are shown in the
  // Studio's Platforms view as having no driver yet — declared honestly, never counted here,
  // because this list is what the engine can actually drive (ADR-0010).
  targetPlatforms: ["ios", "android", "web"],
  // A repository is opened by path (`tapp app /path/to/repo`); a website by URL in the Studio.
  repositorySources: ["local-path", "github"],
  entryLayers: ["repository", "website"],
  views: [
    { id: "overview", label: "Overview", capabilities: ["target-selection", "release-check", "live-feed", "progress-transcript", "live-session", "flow-recording", "latest-evidence"] },
    { id: "runs", label: "Runs", capabilities: ["run-history", "run-detail", "evidence-page", "website-audit"] },
    // Only an owner of this deployment ever sees this one (TAPP_ADMIN_EMAILS); to anybody else
    // the nav item is absent and the route is a 404.
    // Says what tapp drives, what THIS Studio can start, and what to do about the difference.
    { id: "platforms", label: "Platforms", capabilities: ["platform-matrix", "self-host-command", "platform-interest"] },
    { id: "admin", label: "Admin", capabilities: ["deployment-usage", "account-list", "platform-demand"] },
  ],
  operations: ["initialize", "session-start", "session-act", "session-save-flow", "session-end", "gate", "audit"],
  invariants: [
    "The Studio shows runs; it never scores or judges them. Only the deterministic gate decides.",
    "Every run's evidence is the report.html the engine wrote; the Studio links to it rather than re-rendering it.",
    "A website audit is read-only: nothing is clicked, typed, submitted, or hovered.",
    "Repositories are opened from the machine the Studio runs on; nothing is uploaded or cloned by the Studio.",
    "Deterministic replay and ordinary merge decisions are keyless.",
    "The admin view reports counts about this deployment; credentials are encrypted and are never decrypted to be shown.",
    "The Platforms view states what this machine can start, computed from the machine; a platform with no driver says so in those words and is never described as needing different hardware.",
  ],
});

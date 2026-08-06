// Executable parity contract for Tapp's one customer-facing browser product.
// Both the local adapter and hosted adapter must serve this same application.
export const customerProductContract = Object.freeze({
  schemaVersion: 1,
  product: "Tapp",
  interface: "customer-browser",
  targetPlatforms: ["ios", "android", "web"],
  repositorySources: ["local-folder", "github"],
  views: [
    { id: "overview", label: "Overview", capabilities: ["release-decision", "onboarding-progress", "current-operation", "latest-evidence"] },
    { id: "runs", label: "Runs", capabilities: ["run-history", "run-detail", "timeline", "screenshots", "recordings", "logs", "artifacts"] },
    { id: "findings", label: "Findings", capabilities: ["finding-list", "severity-filter", "regression-state", "evidence"] },
    { id: "coverage", label: "Coverage", capabilities: ["application-model", "ui-map", "screens", "transitions", "controls", "task-coverage", "contract-coverage"] },
    { id: "contracts", label: "Contracts", capabilities: ["release-plan-review", "task-generation", "contract-generation", "deterministic-validation", "explicit-promotion"] },
    { id: "settings", label: "Settings", capabilities: ["target-selection", "runner-status", "runtime-inputs", "actors", "credentials", "ai-consent", "ci-installation"] },
  ],
  operations: ["initialize", "session-start", "session-act", "session-save-flow", "session-end", "review", "generate", "validate", "promote", "gate", "baseline", "ci-preview", "ci-install"],
  invariants: [
    "Browser is the Tapp customer interface; web is one target platform.",
    "Repository paths are selected by the server or imported into isolated workspaces.",
    "AI is optional for planning; deterministic replay and ordinary merge decisions are keyless.",
    "Generated Tasks and contracts remain untrusted until real replay passes and promotion is explicit.",
    "The internal fleet console is not a customer product surface.",
  ],
});

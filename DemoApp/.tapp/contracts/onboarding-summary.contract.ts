import { defineContract } from "@aarwitz/tapp/contracts";

export default defineContract({
  name: "newCustomerReachesDailySummary",
  title: "A new customer completes onboarding and reaches Daily Summary",
  businessValue: "First-run activation and the product's primary summary surface remain available.",
  criticality: "high",
  platforms: ["ios"],
  policy: { always: true, prRelevant: true, tags: ["activation", "summary"] },
  app: "io.github.aarwitz.tapp.demoapp",
  actors: {
    customer: { session: "isolated", role: "new customer" },
  },
  steps: [
    { actor: "customer", task: "completeOnboarding", reason: "A first-run customer must enter the product." },
    { actor: "customer", task: "openDailySummary", reason: "The primary summary must remain reachable after activation." },
    { actor: "customer", expect: { screen: "Daily Summary", eventually: { timeoutMs: 6000, pollMs: 250 } } },
  ],
  coverage: {
    nodes: ["get-started", "dashboard"],
    edges: ["edge_32dc8ecd97e7d5ec"],
    capabilities: ["onboarding", "daily summary"],
  },
});

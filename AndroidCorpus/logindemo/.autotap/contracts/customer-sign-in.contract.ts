import { defineContract } from "tapp-mcp/contracts";

export default defineContract({
  name: "existingCustomerCanSignIn",
  title: "An existing Android customer can sign in and reach their profile",
  businessValue: "Authentication does not prevent existing customers from entering the product.",
  criticality: "critical",
  platforms: ["android"],
  policy: { always: true, prRelevant: true, tags: ["authentication", "activation"] },
  app: "io.tapp.corpus.login",
  actors: {
    customer: {
      session: "isolated",
      role: "existing customer",
      credentials: { email: "$TEST_EMAIL", password: "$TEST_PASSWORD" },
    },
  },
  steps: [
    { actor: "customer", task: "signIn", with: { email: "$EMAIL", password: "$PASSWORD" } },
    { actor: "customer", expect: { text: { of: "account_summary", contains: "$EMAIL" }, eventually: { timeoutMs: 6000, pollMs: 250 } } },
    { actor: "customer", expect: { exists: "Profile", eventually: { timeoutMs: 6000, pollMs: 250 } } },
  ],
  coverage: {
    nodes: ["sign-in", "home"],
    edges: ["edge_1812e10e60342047"],
    capabilities: ["authentication", "profile access"],
    sourcePaths: ["build.gradle"],
  },
});

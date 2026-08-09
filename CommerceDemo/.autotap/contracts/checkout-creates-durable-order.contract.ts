import { defineContract } from "@aarwitz/tapp/contracts";

export default defineContract({
  name: "checkoutCreatesDurableOrder",
  title: "Checkout creates an order that remains in order history",
  businessValue: "Protect the revenue path and prove its resulting order survives navigation into customer order history.",
  criticality: "critical",
  platforms: ["web"],
  policy: { always: true, prRelevant: true, nightly: true, tags: ["revenue", "checkout", "order", "persistence"] },
  actors: { customer: { role: "customer" } },
  setup: [{ request: { method: "POST", path: "/__tapp/reset", status: 200 } }],
  steps: [
    { actor: "customer", task: "completeCheckout", with: { product: "Tapp Pro Plan" }, save: { orderedProduct: "ORDERED_ITEM" } },
    { actor: "customer", task: "openOrders" },
    { actor: "customer", expect: { exists: "$ORDERED_ITEM", eventually: { timeoutMs: 10000, pollMs: 250 } } },
  ],
  teardown: [{ request: { method: "POST", path: "/__tapp/reset", status: 200 } }],
  coverage: {
    nodes: ["shop", "cart", "checkout", "order-confirmed", "orders"],
    edges: ["edge_12f3f5e050e91249", "edge_b7f4d683df5b99ea", "edge_ab3b15aad18f1368"],
    capabilities: ["checkout", "order creation", "order persistence"],
    sourcePaths: ["app.js", "server.js"],
  },
});

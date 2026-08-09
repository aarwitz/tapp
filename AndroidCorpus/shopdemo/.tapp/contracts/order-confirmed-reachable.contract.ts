import { defineContract } from "@aarwitz/tapp/contracts";

export default defineContract({
  "name": "orderConfirmedReachable",
  "title": "Order Confirmed remains reachable",
  "description": "Draft generated from approved release-plan item proposal_f03d19f34d1a1dae.",
  "businessValue": "Protect access to the observed Order Confirmed product surface.",
  "criticality": "critical",
  "platforms": [
    "android"
  ],
  "policy": {
    "prRelevant": true
  },
  "actors": {
    "customer": {
      "role": "customer",
      "session": "default"
    }
  },
  "steps": [
    {
      "actor": "customer",
      "task": "openTrailBackpack"
    },
    {
      "actor": "customer",
      "task": "openCart"
    },
    {
      "actor": "customer",
      "task": "openCheckout"
    },
    {
      "actor": "customer",
      "task": "openOrderConfirmed"
    }
  ],
  "coverage": {
    "capabilities": [],
    "nodes": [
      "screen_1c42ddc0285b9c25",
      "screen_5aa7616809c53215",
      "screen_8d9001d32c6a703d",
      "screen_c7761e58969f7edd",
      "screen_d822b1ec5f43f3a3"
    ],
    "edges": [
      "edge_48dd9dad6d6dcc88",
      "edge_493030be0bc86ae1",
      "edge_aa43be8f52a023ea",
      "edge_b180705630132e71"
    ],
    "sourcePaths": []
  }
});

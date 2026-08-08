import { defineContract } from "runtapp/contracts";

export default defineContract({
  "name": "checkoutReachable",
  "title": "Checkout remains reachable",
  "description": "Draft generated from approved release-plan item proposal_6c350caab7e83f8a.",
  "businessValue": "Protect access to the observed Checkout product surface.",
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
    }
  ],
  "coverage": {
    "capabilities": [],
    "nodes": [
      "screen_1c42ddc0285b9c25",
      "screen_5aa7616809c53215",
      "screen_8d9001d32c6a703d",
      "screen_c7761e58969f7edd"
    ],
    "edges": [
      "edge_48dd9dad6d6dcc88",
      "edge_aa43be8f52a023ea",
      "edge_b180705630132e71"
    ],
    "sourcePaths": []
  }
});

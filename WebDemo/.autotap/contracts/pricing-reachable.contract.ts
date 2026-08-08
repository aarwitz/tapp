import { defineContract } from "runtapp/contracts";

export default defineContract({
  "name": "pricingReachable",
  "title": "Pricing remains reachable",
  "description": "Draft generated from approved release-plan item proposal_11eec2a32ab8e47b.",
  "businessValue": "Protect access to the observed Pricing product surface.",
  "criticality": "medium",
  "platforms": [
    "web"
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
      "task": "openPricing"
    }
  ],
  "coverage": {
    "capabilities": [],
    "nodes": [
      "screen_1e2ea6d9b72e685b",
      "screen_47b5df0fe3a1b613"
    ],
    "edges": [
      "edge_02e491cfcf17fba2"
    ],
    "sourcePaths": [
      "pricing.html"
    ]
  }
});

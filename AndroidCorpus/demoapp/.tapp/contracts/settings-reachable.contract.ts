import { defineContract } from "@aarwitz/tapp/contracts";

export default defineContract({
  "name": "settingsReachable",
  "title": "Settings remains reachable",
  "description": "Draft generated from approved release-plan item proposal_7a978be219ca61cd.",
  "businessValue": "Protect access to the observed Settings product surface.",
  "criticality": "medium",
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
      "task": "openDashboard"
    },
    {
      "actor": "customer",
      "task": "openSettings"
    }
  ],
  "coverage": {
    "capabilities": [],
    "nodes": [
      "screen_60383486aeb8b6e4",
      "screen_66cd9688a2ae0682",
      "screen_cde0fb0dec1400c5"
    ],
    "edges": [
      "edge_038e34b8d3887fff",
      "edge_ec9498989826c7a4"
    ],
    "sourcePaths": []
  }
});

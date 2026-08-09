import { defineContract } from "@aarwitz/tapp/contracts";

export default defineContract({
  "name": "updateProfileReachable",
  "title": "Update Profile remains reachable",
  "description": "Draft generated from approved release-plan item proposal_b521734abe46c98b.",
  "businessValue": "Protect access to the observed Update Profile product surface.",
  "criticality": "medium",
  "platforms": [
    "ios"
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
      "task": "completeOnboarding"
    },
    {
      "actor": "customer",
      "task": "openUpdateProfile"
    }
  ],
  "coverage": {
    "capabilities": [],
    "nodes": [
      "screen_2b007d1294e54401",
      "screen_66cd9688a2ae0682",
      "screen_cde0fb0dec1400c5"
    ],
    "edges": [
      "edge_6782e0b802e6cc98",
      "edge_a86a28a62e1a1e8a"
    ],
    "sourcePaths": [
      "Sources/SettingsView.swift"
    ]
  }
});

import { defineContract } from "tapp-mcp/contracts";

export default defineContract({
  "name": "profileReachable",
  "title": "Profile remains reachable",
  "description": "Draft generated from approved release-plan item proposal_0d561e9f3f0c0204.",
  "businessValue": "Protect access to the observed Profile product surface.",
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
      "session": "default",
      "credentials": {
        "email": "$TEST_EMAIL",
        "password": "$TEST_PASSWORD"
      }
    }
  },
  "steps": [
    {
      "actor": "customer",
      "task": "signIn",
      "with": {
        "email": "$EMAIL",
        "password": "$PASSWORD"
      }
    },
    {
      "actor": "customer",
      "task": "openProfile"
    }
  ],
  "coverage": {
    "capabilities": [],
    "nodes": [
      "screen_1900eab6c028483d",
      "screen_48d7c508cc0ca58a",
      "screen_4ea140588150773c"
    ],
    "edges": [
      "edge_1812e10e60342047",
      "edge_662df0725c0129e3"
    ],
    "sourcePaths": []
  }
});

# Tapp SocialDemo

A dependency-free shared-state fixture for Tapp's multi-actor Scenario contract. Alice and Bob run in isolated browser contexts against one backend. The committed Scenario proves cross-account post visibility, a reaction, and bidirectional messaging while the backend deliberately delays propagation.

```bash
npm start --prefix SocialDemo
ALICE_EMAIL=alice@example.test ALICE_PASSWORD=demo BOB_EMAIL=bob@example.test BOB_PASSWORD=demo \
  tapp contract run SocialDemo/.tapp/contracts/social-system.contract.ts --platform web
```

`.tapp/project.json` stores the actor roles, isolation/provisioning policy, and the names of those four environment variables. It never stores their values. The committed release contract and low-level Scenario both resolve the same bindings at replay time; neither needs AI or a coding agent.

For the seeded-fault benchmark, start with `SOCIAL_DEMO_FAULT=hide-cross-actor-posts` or `SOCIAL_DEMO_FAULT=drop-cross-actor-messages`. The same deterministic Scenario must fail; Tapp must not retry the defect into a pass.

The checked-in measured result is [`benchmarks/multi-actor-gate.json`](benchmarks/multi-actor-gate.json).

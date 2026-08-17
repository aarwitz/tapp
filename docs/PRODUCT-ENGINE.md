# One Tapp product engine

Status: current product-engine contract as of 2026-08-08.

Tapp has several interfaces, not several products. The source of truth for customer-critical
operations is [`mcp-server/src/product-operations.js`](../mcp-server/src/product-operations.js).
An interface may validate its transport and render a result; it must not redefine onboarding,
review, trust, baseline, or gate semantics.

## Product operation contract

The shared engine owns these operations:

| Operation | Authoritative result |
|---|---|
| `initializeProductProject` | detected targets, real exploration, Application Model, UI Map, release plan |
| `readProductProject` | one current, read-only product snapshot for any interface |
| `reviewProductPlan` | explicit approve/reject/defer decisions |
| `generateProductPlan` | compile-checked but untrusted Task/contract drafts |
| `validateProductPlan` | real-target, deterministic replay evidence |
| `promoteProductPlan` | canonical Tasks/contracts, refreshed model/plan, updated map coverage |
| `prepareProductCi` / `installProductCi` | target-aware workflow and machine-readable CI manifest |
| `runProductGate` | autonomous evidence plus the committed deterministic suite and one gate decision |
| `createProductBaseline` | conclusive, platform-and-target-specific comparison state |

Deterministic contract execution is in
[`mcp-server/src/product-execution.js`](../mcp-server/src/product-execution.js). It invokes platform
executors directly; MCP does not shell through the CLI, and the browser does not shell through MCP.

## Interfaces

```text
Browser Release Studio ─┐
CLI                     ├── product-operations ── application model / UI Map / Tasks / contracts
MCP                     ┘             │
                                      └── deterministic executors / portable gate / evidence

VS Code ── MCP client
Desktop ── canonical artifact reader (migration to operation client remains)
Action  ── portable gate adapter
Hosted  ── tenant-aware SaaS adapter + queued isolated shared-operation workers (not built)
```

Current convergence:

- the browser calls only shared product operations;
- CLI initialization, plan lifecycle, deterministic draft validation, promotion, gate/baseline
  lifecycle, and CI installation call the same operations. Native build preparation remains at the
  adapter boundary and passes a resolved `.app` or APK into the shared gate;
- MCP initialization, plan lifecycle, deterministic draft validation, promotion, baseline, and CI
  installation call the same operations;
- the GitHub Action and `runProductGate` call the same portable gate and evidence protocol;
- VS Code remains a thin MCP client;
- desktop reads the same `.tapp` artifacts but still has legacy import/build orchestration. It is
  retained, not the launch UX, until that orchestration is removed;
- `cloud/runner` is retained prototype evidence for exact checkout, versioned operation envelopes,
  leases, and cleanup. It is not the production hosted adapter or an adequate arbitrary-customer
  isolation boundary. The new SaaS must call these shared operations only through a tenant-aware,
  queued worker contract (defined in the private source repository's SaaS architecture doc).

## Canonical repository protocol

New product behavior writes only `.tapp/`:

```text
.tapp/
  project.json              # actors, env binding names, controlled lifecycle; never secret values
  application-model.json    # detected/observed/declared product facts
  ui-map.json               # grounded screen/action/transition graph
  release-plan.json         # proposals and explicit human decisions
  tasks/                    # reusable deterministic semantic operations
  contracts/                # reviewed business guarantees
  baselines/<platform>/     # conclusive target-specific comparison state
  ci.json                   # generated CI installation manifest
```

`.tapp.yml` is the canonical run configuration, and `.tapp/` holds repository artifacts. These are
the only names the runtime reads; the pre-rename `.autotap.yml`, `.autotap/`, and `AUTOTAP_*` inputs
are no longer supported. Do not add another configuration format, and do not reintroduce a legacy
reader. Only an explicit reviewed operation may write new repository artifacts.

## Anti-duplication rules

0. Exploration (`explore`, formerly `qa`) observes and surfaces findings + evidence + UI Map; it must
   not render a release outcome. Only the gate (`runProductGate`) applies versioned deterministic
   policy to findings + coverage + selected suites + an optional baseline and computes
   `pass | fail | inconclusive` (ADR-0005, in the private source repository).
1. Trust states (`pending`, `approved`, `validated-draft`, `promoted`) are computed by the engine.
2. Interfaces render `readProductProject`; they do not infer readiness from file existence.
3. Re-exploration refreshes evidence while preserving reviewed decisions everywhere.
4. Promotion refreshes the Application Model immediately; no interface may show stale pre-promotion
   requirements.
5. Baselines are identified by platform and stable target id everywhere.
6. An adapter-specific feature is not complete until its engine operation is useful without that
   adapter.
7. Equivalence tests should assert artifacts and structured results, not merely matching copy.

## Remaining migration

The next safe convergence work is deliberately narrow:

1. replace desktop import/build orchestration with a local product-operation client;
2. delete the two desktop detection/scaffolding paths only after equivalence fixtures pass;
3. implement managed account, organization, and tenant authorization before connecting repositories;
4. implement scoped GitHub authorization, private evidence, and disposable per-job
   identity/simulator/credential isolation before accepting customer code;
5. preserve CLI/MCP/VS Code/Action as adapters—do not rebuild their product logic.

# Application model and `tapp init`

`tapp init` is the deterministic import, exploration, and planning entrypoint of Tapp's customer
journey. It turns a repository into three platform-neutral, repository-native artifacts:

- `.tapp/ui-map.json` — observed UI states, controls, and transitions from real exploration;
- `.tapp/application-model.json` — what Tapp can support with evidence;
- `.tapp/release-plan.json` — the compact set of committed and proposed business guarantees a
  customer must review before generation.

Plain `tapp init` performs source/artifact inspection only. `tapp init --explore` additionally uses
the same keyless QA engine as `tapp explore` to build/install/launch or connect to one selected real
target, merge the observed map, and construct the model and plan from that runtime evidence. It
does not generate or approve tests, call AI, or claim contract validation. When iOS repository
resolution actually builds and installs the detected Xcode container, the model records the exact
scheme as runtime-observed validation and removes the corresponding confirmation blocker. Merely
supplying a bundle id or prebuilt `.app` does not prove repository build configuration.

A repository with more than one detected application target is never resolved by detection order
during explicit initialization, even when a prior default exists. Bare `tapp init . --explore`
prompts in a human TTY; non-interactive CLI/MCP callers receive
exact `--platform`/`--target` commands before any build or write, and MCP also carries them as
structured `target-selection-required` choices. The selected run records that target as the default
for later bare `tapp explore`, but the application model retains the repository's other detected
targets and their unmet coverage. The selected init run reports other-target setup gaps as deferred
information rather than presenting them as failures of the target that was actually explored.

## First inspection

```bash
# Read-only preview. For web, provide the owned runtime URL if already known.
tapp init . --url http://127.0.0.1:3000 --dry-run \
  --json-out /tmp/tapp-init-preview.json

# Create canonical artifacts. Existing files are never overwritten implicitly.
tapp init . --url http://127.0.0.1:3000

# Build/start the detected web target, explore it, persist its UI Map, then stop it.
tapp init . --explore --platform web --actions 40 --timeout 600

# Or connect to an already-running owned environment.
tapp init . --explore --platform web --url http://127.0.0.1:3000 \
  --actions 40 --timeout 600

# iOS can resolve a repository/Xcode container/.app/bundle id and build when needed.
tapp init . --explore --platform ios --target .

# Android can install an APK, then launch the explicit application id.
tapp init . --explore --platform android \
  --apk app/build/outputs/apk/debug/app-debug.apk --app-id com.acme.app

# Re-inspect after source/UI Map changes while preserving explicit review decisions.
tapp init . --url http://127.0.0.1:3000 --refresh

# Re-explore after review without losing approve/reject/defer choices.
tapp init . --refresh --explore --platform web --url http://127.0.0.1:3000
```

MCP clients use `tapp_init` with `operation: inspect|write|refresh|explore`. `inspect` is the safe
default. `explore` writes real evidence, so the CLI rejects `--explore --dry-run`; the CLI also
refreshes existing model/plan artifacts through the same decision-preserving semantics. Credentials
are passed only to the runtime and are never written into the model, map, or plan.

Successful repository-driven iOS build validation is portable and durable. The application model
stores the repository-relative container, scheme, configuration, bundle id, and a
`tapp-capture:<id>` evidence reference—never the local DerivedData or checkout path. A later
source-only `tapp init --refresh` retains that validation when it still names the same detected
container. Tapp does not infer equivalent proof from an installed application, an explicit bundle
id, or a prebuilt artifact; those paths can demonstrate runtime reachability but cannot silently
confirm the repository's Xcode scheme.

## Actors and credential bindings

Configure named actors once instead of repeating credentials or session policy across tests:

```bash
tapp actor set alice . --role member --session isolated --provisioning seeded \
  --credential email=ALICE_EMAIL --credential password=ALICE_PASSWORD
tapp actor set bob . --role member --session isolated --provisioning seeded \
  --credential email=BOB_EMAIL --credential password=BOB_PASSWORD
tapp actor list .
tapp init . --refresh
```

This writes `.tapp/project.json`. The file contains roles, `default`/`isolated` session policy,
provisioning mode, same-origin lifecycle declarations, and environment-variable *names*. The CLI
and MCP `tapp_actor_config` reject credential values and refuse to replace an actor without an
explicit `--replace`/`replace: true`. Contracts refer to `$ALICE_EMAIL`-style placeholders. Tapp
merges those reviewed placeholders with the central configuration, blocks missing/conflicting
bindings, and never copies resolved values into the application model, release plan, UI Map, CI
manifest, or generated workflow.

When web `--url` is omitted, Tapp selects one detected browser target, runs only its internally
derived lockfile-backed install command, runs its declared build script when present, and starts its
`start`, `dev`, `serve`, or `preview` package script with argument-array process execution (never
generated shell source). A static site with no script uses Tapp's local read-only static server. The
runtime binds to an available loopback port, writes its log under the Tapp runtime directory, and is
terminated after exploration even when QA fails. Multiple web targets, an unlocked dependency
graph, an unrecognized start path, or backend-specific configuration produce explicit remediation;
provide `--target` and/or an already-running owned `--url` in those cases. Running repository build
scripts executes repository code and should only be used for a checkout the customer trusts.
The managed loop never persists its ephemeral loopback URL as customer configuration. The model
records `runtime.management: tapp-managed`, and the portable gate/Action reconstructs the same
start/wait/stop lifecycle later. An explicitly supplied owned URL remains `customer-managed`.

## What the model records

Application Model v1 records:

- detected iOS simulator, Android application, and browser targets;
- inspectable build commands, project/module/container paths, scheme candidates, application ids,
  owned URLs, missing confirmations, and exact runtime-observed target validation where Tapp itself
  completed the repository build/install path;
- actors, roles, provisioning modes, credential requirements/environment bindings, and
  session-isolation boundaries without credential values;
- business entities and capabilities explicitly declared by reviewed contracts or conservatively
  derived from reusable Task names;
- authored critical journeys, revenue paths, and cross-actor system invariants;
- the shared UI Map's observed state/transition/control counts and uncovered ids;
- the latest import exploration's finding count and explicit inconclusive status, when available;
- existing Tasks and contracts;
- blocking requirements and exact remediation.

Every fact identifies its evidence class. The current deterministic importer uses:

- `source-observed` for repository files and build metadata;
- `runtime-observed` for a successful exact target build/install/exploration, with portable evidence;
- `reviewed-artifact` for committed Tasks, contracts, and UI Map evidence;
- `task-derived` or another source-derived status when a fact still requires review;
- `authored-unvalidated` when a committed contract exists without current-revision replay proof.

Runtime observation, source inference, optional AI proposals, and human decisions must not be
collapsed into one confidence label. The artifact explicitly records that remote AI was not used.

## Release-plan quality

The deterministic planner starts with committed contracts, then proposes only evidence-grounded
gaps:

- a conservative cross-actor propagation guarantee when two explicitly configured isolated actors,
  deterministic setup/teardown, compatible authentication/precondition screens, and an exact
  content-producing Task output jointly prove that the proposal is grounded;
- reusable Tasks not composed by a reviewed contract;
- uncovered UI states carrying business signals such as authentication, pricing, checkout,
  account, messaging, or settings behavior.

Error pages, blank pages, loading surfaces, changelogs, and generic feature-description pages remain
visible as UI Map coverage gaps but do not automatically become business contracts. The target is
approximately 5–15 contracts for a sufficiently rich product, not an artificial quota for a small
fixture. Every proposal includes business value, risk, criticality, actors, platforms, grounding,
and the real-surface validation required before it can be trusted.

## Explicit review

```bash
tapp plan show .tapp/release-plan.json
tapp plan review .tapp/release-plan.json \
  --approve signInWorks,checkoutWorks \
  --reject marketingPageReachable \
  --defer adminAuditWorks

# Only after review: generate grounded Task + contract drafts under .tapp/proposals/.
tapp plan generate .tapp/release-plan.json --project-dir .

# Replay the draft on the real target and attach evidence to the plan.
# Omit --url to build/start/stop the detected managed browser target.
tapp plan validate .tapp/release-plan.json --project-dir . --platform web
# Or connect to an already-running owned environment.
tapp plan validate .tapp/release-plan.json --project-dir . \
  --platform web --url http://127.0.0.1:3000

# Explicitly accept only fully validated drafts into canonical reviewed locations.
tapp plan promote .tapp/release-plan.json --project-dir . \
  --item checkoutWorks
```

The MCP equivalent is `tapp_release_plan` with `read|review|generate|validate|promote`. Review
changes decision metadata only. It cannot silently
edit a Task, contract, selector, or assertion. On `tapp init --refresh`, decisions, constraints, and
review notes are carried forward by stable item id; reviewed items no longer derived from current
evidence are retained and marked stale instead of disappearing.

A source-only refresh preserves recorded replay evidence. `tapp init --refresh --explore` carries
the history forward but invalidates trust for affected generated Tasks and contracts: prior
platform results move to historical evidence, status becomes `requires-revalidation`, and replay is
required before the draft can be trusted against the newly observed revision. Exploration never
silently self-heals or accepts the prior selector path.

The macOS desktop Coverage experience reads these same files. Its **Application** tab explains
detected targets, actors, capabilities, journeys, Tasks, contracts, and exact remediation. Its
**Release Plan** tab writes explicit approve/reject/defer decisions atomically into the canonical
plan while preserving fields from newer engine versions; committed contract intent is not editable
through these proposal controls. Flow Map merges the repository `.tapp/ui-map.json` with current
run evidence instead of building a separate desktop-only graph.

Schema compatibility is exercised by the repository's protocol tests and retained desktop reader.

`plan generate` handles only explicitly approved proposals. Grounded cross-actor proposals preserve
actor-attributed Task calls, captured output variables, bounded eventual assertions, and the
reviewed project lifecycle, then compile through the isolated Scenario executor. Existing
Task-backed proposals compose those reviewed Tasks. For UI-Map-only proposals, it finds an observed path from each platform's
recorded entry state, deduplicates shared semantic transitions into compositional Task drafts under
`.tapp/proposals/tasks/`, grounds every Task in exact node/edge ids, and writes the contract draft
under `.tapp/proposals/contracts/`. Proposal Tasks are visible only to proposal contracts; an
ordinary committed contract or CI glob cannot silently consume one.

Generation blocks when entry-state evidence is missing, the target is unreachable, an observed
action cannot be represented deterministically, or platform paths require incompatible semantic
composition. It never overwrites a draft, statically compiles each declared platform, and marks all
outputs untrusted. Missing non-secret Task inputs stay blocked until the plan has explicit bindings;
standard email/password secrets remain placeholders. Successful grounding and compilation are not
real-surface evidence and never promote drafts into `.tapp/tasks` or `.tapp/contracts`.

`plan validate` invokes the ordinary deterministic contract executor and records pass/fail evidence
per declared platform. A multi-platform draft remains only partially validated until every declared
platform passes. Failed replay remains visible and sets `trusted: false`; there is no selector
substitution or automatic assertion update.

`plan promote` is the explicit acceptance boundary. It refuses any contract or generated Task that
has not passed every declared platform, preflights every destination, never overwrites a reviewed
artifact, moves accepted files from `.tapp/proposals/{tasks,contracts}` into
`.tapp/{tasks,contracts}`, and applies their exact node/edge coverage to the canonical UI Map.
Shared Task paths in still-unpromoted proposals are rewritten to the canonical file. Promotion does
not commit, push, or install CI; the resulting repository patch remains reviewable by the customer.

## Baseline and CI handoff

After promotion, complete the local onboarding loop with:

```bash
# Runs the ordinary exploration + committed suites gate. Builds native targets when possible;
# web targets can be detected, built, started, awaited, and stopped without a durable URL.
tapp baseline create . --platform web

# Or import an already-retained successful full-gate report after review.
tapp baseline create . --platform web --from /path/to/tapp-report.json

# Generate one target-aware job per model target plus a machine-readable manifest.
tapp ci install . --action-ref aarwitz/tapp@v0.13.1
```

Baseline creation rejects non-gate JSON, missing or mismatched target identity, platform mismatch,
failed Flows/Scenarios/contracts, `blocked`, and `inconclusive`. It writes atomically to
`.tapp/baselines/<platform>/<target-id>.json` and requires `--replace` to supersede reviewed
evidence. Capture-local paths are replaced with portable `tapp-capture:` references before the
repository artifact is written. The gate also checks baseline platform and target identity before
comparing findings. On iOS, the same validated launch arguments and string-valued launch
environment are passed to autonomous exploration and deterministic Flow/contract replay; invalid
JSON or unsupported value types fail before execution rather than silently testing different app
configurations.

CI installation writes `.github/workflows/tapp.yml` and `.tapp/ci.json`, never overwrites by
default, and refuses unresolved iOS schemes, Android ids, browser lockfiles, or runtimes. The
workflow uses exact contract paths, maps each actor environment binding to a same-named GitHub
Secret, uses the first/default actor for autonomous-login inputs, preserves the remaining bindings
for deterministic multi-actor replay, and supports managed web startup, Android emulator
provisioning, and the target-specific baseline. It does not commit,
push, enable branch protection, or create remote resources. Use MCP `tapp_ci_setup` for the same
read-only render, baseline import, and guarded install engine.

## Current boundary

Repository detection, one-target real exploration, first-map merge, evidence classification,
runtime-observed iOS scheme confirmation, durable source-only refresh, deterministic planning, safe
persistence, approve/reject/defer review, and compile-checked Task-backed draft generation are
implemented. An empty map or a latest exploration marked inconclusive remains a blocking
requirement; observing a login wall is not treated as useful coverage.

`tapp init` does not yet orchestrate every detected target in one invocation, provision arbitrary
web backends/services, automatically replay every approved draft, or promote validated drafts without
explicit customer acceptance. Baseline creation and a reviewable per-target GitHub CI patch are now
implemented as explicit post-promotion commands, but the generated workflow has not yet passed on
current GitHub-hosted iOS, Android, and web runners. Task generation currently handles observed
reachable navigation. Deterministic business planning is deliberately limited to cross-actor
content propagation and one checkout-to-order-history persistence pattern supported by exact Task
input/output, screen, actor, UI Map, and lifecycle evidence. General forms, broader payment shapes,
dynamic value capture, messaging/reactions, role-asymmetric invariants, and incompatible platform
journeys still require reviewed authoring. Optional
AI business reasoning is also not wired into this path. Those missing stages remain completion
blockers.

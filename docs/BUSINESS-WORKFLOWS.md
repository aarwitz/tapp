# Business workflows in one Tapp product

The business workflow map sits above the existing Flows, accounts, backend hooks,
contracts, Scenarios and release gate. Owners describe outcomes and review them in
conversation or `/workflows`; developers keep authoring the underlying proof in
their repositories. It does not replace or weaken the existing release gate.

## Implemented paths

- `tapp_workflows`: read the saved map, available targets/accounts/checks, proposed
  workflows, missing access, and scoped coverage.
- `tapp_workflows_save`: save a reviewed definition with optimistic revision checking.
- `tapp_workflow_run`: queue one confirmed workflow in a configured test environment.
- `/workflows?project=…`: edit outcomes and steps, choose roles/targets/checks, review,
  run, poll results, inspect evidence, and import/export the portable definition.
- `tapp workflows [repo]`: discover from the existing project snapshot and inspect
  `.tapp/business-workflows.json`. No source inspection or exploration happens implicitly.
- `tapp workflows [repo] --save definition.json [--confirm]`: persist a portable map.
  Use the current revision; confirmation reflects a human review. `--workflow ID`
  displays the execution plan and blockers for a saved workflow.

Discovery uses observed UI Map nodes, saved Flows, contract journeys, selected
targets, configured accounts and backend capabilities. Proposals remain unconfirmed.
The conversational agent can combine these with the owner's stated goals and save
an ordered map; this module does not call a model or invent backend integrations.
The top-level description and missing-outcome steps let a person start before any
recorded proof exists. Additional roles, systems and exception paths must be surfaced
and confirmed rather than inferred to be covered.

## Example journey and the first execution adapter

A booking journey can be represented as:

1. A named backend capability prepares run-scoped test data.
2. A saved web Flow signs in as the customer, creates a booking and asserts its UI result.
3. Another saved web Flow signs in as staff and asserts that the booking is visible.
4. A named backend verifier checks the expected record and run ID.
5. A named cleanup capability removes the run's fixtures.

This is an example of the implemented composition, **not a journey executed during
this change**. The flows, accounts, backend implementation and test environment must
actually exist. The planner names missing pieces and blocks unsupported steps.

Every Flow gets a new browser process/context, its selected account, and
`$TEST_RUN_ID`. Verification hooks receive the same unique ID through the existing
backend capability interface. Flows composed with a backend verifier must reference
that variable in their steps; their declared assertions must include at least one
deterministic assertion. A backend hook must genuinely associate the ID with the
business record; echoing an ID alone does not establish that an outcome occurred.

All referenced Flow files and required accounts are checked before external
mutation. File hashes are checked again before replay. Cross-origin browser
navigation stops the workflow before further actions; social sign-in requires a
supported authorization handoff rather than typing account secrets into a new origin.
Fixed run/account variables override Flow defaults for this hosted composition.
Other undeclared variables fail closed; custom per-step input mapping is not yet
part of the business runner.

Execution order is preparation → app activity → backend verification → cleanup.
On failure, later ordinary steps are skipped and configured cleanup is attempted.
Cleanup acknowledgement is not proof that all data was deleted. Process termination
or loss of the runner lease can prevent cleanup and needs operator recovery.
There is a 15-minute orchestration budget with up to two minutes per Flow replay;
target preparation/startup and final cleanup have their own adapter time bounds.
This is not yet an authoritative billable occupancy meter.

Web Flow recordings and screenshots live alongside the workflow report and are
uploaded using existing evidence ownership checks. Existing upload/count limits
still apply. A failed or killed browser may not finalize its recording; do not
promise a complete video unless it is present in the returned evidence.

## Definitions and advanced developer use

The portable JSON has `kind: "tapp-business-workflows"`, `schemaVersion: 1`, a
monotonic `revision`, a `description`, and up to 30 workflows. Each workflow has
`id`, `title`, `outcome`, `priority`, `decision` and 1–20 ordered steps. Each step
has `id`, `title`, `outcome`, `kind`, and optional `ref`, `actor`, `targetId`:

| Step kind | Reference | Initial automatic execution |
| --- | --- | --- |
| `flow` | Existing `.tapp/flows/name.yml`, `.yaml`, or `.json` | Web, with an explicit actor or `public`, target and artifact fingerprint |
| `capability` | A configured backend action name | Prepare, verify or cleanup according to its saved configuration |
| `contract` | An existing contract artifact path | Use the existing repository gate; composition reports this limitation |
| `manual` | No proof yet | Remains blocked/unverified until a check is connected |

The shared modules are `business-workflows.js` (discovery, normalization, planning,
coverage), `business-workflow-runtime.js` (adapter orchestration), and
`business-workflow-files.js` (repository persistence). The existing product snapshot
exposes the repository definition and content hashes for saved Flows. Local inspection
does not import hosted execution history or claim a local verification from a hosted run.

Hosted definitions live in `product_business_workflows`; apply migration 0008 after
the connection migration. They are server-managed and cannot be overwritten by
worker artifact uploads. Owners/admins can edit; authorized members may request
execution; viewers can read. Cookie mutations require same-origin CSRF validation,
and MCP mutations require their declared OAuth scopes plus organization authorization.
Map writes use a project lock and expected revision and are blocked during active
operations or sessions. Execution admission uses the existing quotas, deduplication,
tenant grants, serialization and leases. It also rechecks the plan when delivering
the lease-scoped worker access payload.

Confirmation fingerprints the selected workflow and discovered execution context.
Changed Flow contents, targets or connection revisions invalidate that approval.
Hosted imports require a fresh review. The server strips caller-supplied results
and approval metadata: only actual completed worker operations supply observations.

## Reading coverage honestly

The map reports `needs-confirmation`, `blocked`, `unverified`, `observed`, `failed`,
`inconclusive` and `deferred`. Steps distinguish observed assertions from preparation
or cleanup acknowledgements. Changing the map revision makes older evidence stale;
changing linked execution context also requires review. A later infrastructure
failure prevents an older successful run from remaining the latest successful status.
Historical observations describe their execution time, not the application's health now.

There is no “percent of the entire business tested” score. Coverage counts refer
only to the explicitly listed workflows and assertions. Unlisted workflows, roles,
systems and exception paths remain unknown. The business runner returns an observation;
only the repository-connected deterministic gate issues a release verdict.

## Scope and remaining work

The first adapter supports sequential web roles and backend hooks within one project.
Native multi-role isolation, concurrent actor scenarios, cross-project orchestration,
native provider OAuth, automatic backend sandboxes, full business discovery and
automatic check authoring remain additional work. Existing developer workflows and
release gates continue through their existing tools. A test-environment label is
an operator assertion, not evidence of isolation.

This change has not been deployed or exercised against a customer app or ChatGPT.
No tests or new executable test fixtures were added or run. Production build,
TypeScript, lint and syntax checks are the available local validation. The next
runtime milestone is an owned app with two roles and a run-correlated backend
outcome, configured through this map and recorded end to end.

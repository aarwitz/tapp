# Multi-actor Scenarios

A Scenario is Tapp's low-level deterministic multi-actor execution format in `.tapp/scenarios/*.yml`. It uses the same semantic actions, polling assertions, timeouts, evidence markers, and merge policy as a Flow, but adds isolated named actors, shared variables, and explicit lifecycle steps. The customer-facing business authoring layer is a TypeScript **release contract**, which composes reusable Tasks and compiles to this runtime instead of duplicating UI steps.

Ordinary replay is keyless. AI may propose a Scenario during authoring, but no model, API key, or coding agent participates when CI executes it.

## Current support

Web replay is implemented through one isolated Playwright browser context per actor. Cookies, local storage, and in-browser session state cannot leak between actors; all contexts point at the same deployed application and backend. The Action, portable gate, CLI, and MCP surface all consume the same file.

iOS and Android still support sequential account switching inside ordinary Flows, but do not yet have first-class isolated multi-actor Scenario drivers. Tapp rejects those platform combinations instead of presenting sequential login/logout as equivalent proof.

## Contract

```yaml
name: Alice publishes and Bob sees it
kind: scenario
platform: web
url: http://127.0.0.1:4180
timeoutMs: 6000
vars:                         # shared deterministic data
  POST: Scenario post 7319
actors:
  alice:
    vars:                     # actor-scoped credentials/session inputs
      EMAIL: alice@example.test
      PASSWORD: demo
  bob:
    vars:
      EMAIL: bob@example.test
      PASSWORD: demo
setup:
  - request:                  # bounded, same-origin HTTP; never arbitrary shell
      method: POST
      path: /__tapp/reset
      status: 200
steps:
  - actor: alice
    type: { field: Email, value: $EMAIL }
  - actor: alice
    type: { field: Password, value: $PASSWORD }
  - actor: alice
    tap: Sign in
  - actor: alice
    type: { field: Post text, value: $POST }
  - actor: alice
    tap: Publish
  - actor: bob
    assert_exists: { target: $POST, timeoutMs: 6000 }
teardown:
  - request: { method: POST, path: /__tapp/reset, status: 200 }
```

- `actors` must contain at least two names. Every journey step names one of them.
- Actor variables override shared variables. A committed value such as `$ALICE_PASSWORD` resolves only that explicitly referenced environment variable at run time; Tapp does not serialize the surrounding environment.
- `setup` and `teardown` currently accept bounded HTTP request steps on the target origin. Teardown runs after a journey failure so state is still cleaned up.
- Flow assertions poll until their bounded timeout. This models eventual consistency without blind sleeps or unbounded retries. A condition that never becomes true fails visibly.
- Typed values are not written to step evidence. Results include actor, action, selector, status, and error; failures capture that actor's screen and final screenshots for all actors.
- A failed Scenario always blocks the release gate, independently of whether autonomous single-user exploration found a problem.

## Run it

```bash
tapp scenario validate .tapp/scenarios/social-system.yml
ALICE_EMAIL=alice@example.test ALICE_PASSWORD=demo \
BOB_EMAIL=bob@example.test BOB_PASSWORD=demo \
  tapp scenario run .tapp/scenarios/social-system.yml

tapp ci --platform web --url http://127.0.0.1:4180 \
  --scenarios '.tapp/scenarios/*.yml' \
  --json-out tapp-report.json --md-out tapp-report.md
```

GitHub Action:

```yaml
- uses: aarwitz/tapp@v0.17.1 # or pin the reviewed release commit SHA
  with:
    platform: web
    url: http://127.0.0.1:4180
    scenarios: .tapp/scenarios/*.yml
```

MCP clients call `tapp_scenario_run` with `scenarioPath`, or an inline reviewed Scenario. The structured result identifies `kind: scenario`, actual executed/total steps, and actor-tagged steps.

## Verified fixture and boundaries

`SocialDemo/.tapp/contracts/social-system.contract.ts` is the reference system guarantee; the Scenario remains its low-level execution proof and backwards-compatible escape hatch. On 2026-08-04 the contract passed 41/41 compiled steps using two isolated contexts against one delayed shared backend. With `SOCIAL_DEMO_FAULT=hide-cross-actor-posts`, the unchanged contract failed for Bob at 19/41 and the portable merge gate exited non-zero specifically because one release contract failed.

The fixture's `.tapp/project.json` is the central actor contract. It records Alice and Bob's
roles, isolated sessions, seeded provisioning, reset lifecycle, and four environment-variable
names. The release contract and Scenario consume those names; neither stores the public fixture
values. Customer values belong in the local environment or CI secret store.

This proves the contract and web implementation, not universal multi-user reliability. Real customers still need reset/provisioning hooks or dedicated test data, enough accessibility semantics to select controls, and a test backend whose eventual-consistency budget is known.

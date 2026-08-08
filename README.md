# tapp — ship with proof

[![CI](https://github.com/aarwitz/tapp/actions/workflows/ci.yml/badge.svg)](https://github.com/aarwitz/tapp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/runtapp?color=cb3837&label=npm)](https://www.npmjs.com/package/runtapp)
[![npm downloads](https://img.shields.io/npm/dw/runtapp?label=downloads)](https://www.npmjs.com/package/runtapp)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Install in Cursor](https://img.shields.io/badge/Cursor-Install_MCP-000000)](cursor://anysphere.cursor-deeplink/mcp/install?name=tapp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInRhcHAtbWNwIiwibWNwIl19)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_MCP-0098FF)](https://insiders.vscode.dev/redirect/mcp/install?name=tapp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22runtapp%22%2C%22mcp%22%5D%7D)

**Tapp is the release-contract and evidence layer for teams shipping agent-authored applications.**
It turns a repository and real product into an observed UI Map, a compact reviewed deterministic
suite, and an inspectable merge decision.

Coding agents can write the code, and (with Playwright & friends) they can even drive the app.
What nobody gives them is **judgment**: did it actually work? tapp explores your app like a user —
no test code, no app changes — detects what's broken, and commits to a verdict your merge queue
can trust: `ready`, `caution`, or `blocked`, with evidence.

Three platforms, one judgment layer:

- **iOS** — the missing Playwright for iOS. tapp is hands *and* judgment: a generic XCUITest
  harness drives any app on the simulator via the accessibility surface. Native — no Appium,
  no WebDriverAgent.
- **Android** — black-box native driving through ADB + UIAutomator. Install an APK, target its
  application id, and run the same QA, committed Flows, evidence, and regression gate. The app
  does not link a Tapp SDK.
- **Web (beta)** — built *on* Playwright. Your agent already has browser hands; tapp adds the
  autonomous exploration, the deterministic detectors (uncaught exceptions, failed requests,
  dead buttons, broken links, error pages), and the same verdict.

```
you:    "Add a logout button to the settings screen"
agent:  *writes the Swift*
agent:  *tapp: builds, opens the app, navigates to Settings, screenshots it*
agent:  "Done — and here it is working on the simulator: [screenshot]"
```

## Quickstart

Requirements: **Node ≥ 18**. iOS needs **macOS + Xcode**; Android needs `adb` plus a connected
emulator/device; web needs Playwright + Chromium.

**Launch experience — browser Release Studio.** Open the source chooser from anywhere:

```bash
npx -y runtapp app
```

Drag and drop a local repository folder or connect through your authenticated GitHub CLI and select
an authorized repository. To work directly in an existing writable checkout, use `tapp app .`.
The local, loopback-only workspace detects iOS, Android, and web targets. A single configured target
builds and explores automatically; Tapp asks only when selection is ambiguous or configuration is
genuinely missing. It renders the UI Map,
supports release-contract review and keyless validation, records live semantic actions as committed
Flows, and produces target-scoped gate, baseline, evidence, and CI artifacts. CLI, MCP, VS Code, and
the GitHub Action use the same product/gate operations; the retained managed-runner prototype is
being replaced by the future isolated SaaS worker boundary.

**Zero config — get a verdict right now.** From your app's repo, one command. No server, no
config file, no test code — you don't even need to know your bundle id:

```bash
cd YourApp
npx -y runtapp qa    # finds your Xcode project → builds → installs on the simulator → explores → verdict
```

The npm package was renamed from `tapp-mcp` to `runtapp` in 0.14.0. Existing
`npx tapp-mcp ...` configurations remain supported through the compatibility package.

To bootstrap maintained release infrastructure, preview the repository model and grounded plan
before Tapp writes anything:

```bash
npx -y runtapp init . --dry-run --json-out /tmp/tapp-init.json
# Build/start the detected web target, ground the first UI Map, then stop it.
npx -y runtapp init . --explore --platform web
# Or build/install the detected Xcode target, ground the map, and persist the validated scheme.
npx -y runtapp init . --explore --platform ios --target .
# Or connect to an already-running owned URL:
npx -y runtapp init . --explore --platform web --url http://127.0.0.1:4173
# If the app has roles/accounts, bind names once; values stay in local/CI secrets.
npx -y runtapp actor set alice . --role member --session isolated \
  --credential email=ALICE_EMAIL --credential password=ALICE_PASSWORD
# Review-only path: tapp init . → tapp plan show → tapp plan review --approve ...

# After approved drafts replay and are promoted, establish the selected target's baseline
# through the ordinary full gate, then generate the reviewable GitHub workflow.
npx -y runtapp baseline create . --platform web
npx -y runtapp ci install .
```

The baseline command writes only after autonomous QA and every selected deterministic suite pass
conclusively. It stores `.autotap/baselines/<platform>/<target-id>.json`; the generated workflow
uses that exact target identity so two apps on the same platform never share a baseline. `ci
install` writes `.github/workflows/tapp.yml` plus `.autotap/ci.json`, refuses unresolved build
configuration and existing-file collisions, and never commits, pushes, enables branch protection,
or creates GitHub resources. Review and pin the generated Tapp release reference to its immutable
commit SHA before production.

Every verb takes whatever you have: nothing (auto-detects the repo you're in, or the app
already on the simulator), a repo directory, a `path/to/App.app`, or a bundle id:

```bash
npx -y runtapp open [target]   # launch the app → screen summary + screenshot file
npx -y runtapp tree [target]   # accessibility tree of the current screen
npx -y runtapp shot            # screenshot the booted simulator
npx -y runtapp apps            # what's installed on the simulator (names + bundle ids)
npx -y runtapp build [dir]     # just build + install (scheme auto-detected)
```

Web (beta): `npx -y runtapp qa http://localhost:3000` *(one-time setup:
`npm i -g playwright && npx playwright install chromium`)*

Android:

```bash
npx -y runtapp qa path/to/app-debug.apk --platform android --app-id com.acme.app
npx -y runtapp open com.acme.app --platform android
```

Optional but recommended (prebuilds the test harness so the first run is fast):
```bash
npx -y runtapp install    # ~2 min, one time
npx -y runtapp doctor     # verify Xcode / simulators / toolchain
```

### MCP hookup (optional)

The MCP server adds the two things a CLI can't do: **screenshots inline in your agent's
context** (the model literally sees the screen) and the **interactive session loop**
(tap → read tree → type, with the app staying open between actions).

**Claude Code:**
```bash
claude mcp add tapp -- npx -y runtapp mcp
```

**Cursor / VS Code (Copilot)** — add to `~/.cursor/mcp.json` (Cursor) or `.vscode/mcp.json` (VS Code):
```json
{
  "servers": {
    "tapp": { "type": "stdio", "command": "npx", "args": ["-y", "runtapp", "mcp"] }
  }
}
```

**Codex CLI** — add to `~/.codex/config.toml`:
```toml
[mcp_servers.tapp]
command = "npx"
args = ["-y", "runtapp", "mcp"]
```

**Any other MCP client:** stdio command `npx -y runtapp mcp`.

Then ask your agent:
> "Run tapp qa on my app — is it ship-ready?"
> "Open com.mycompany.app on the simulator and screenshot the home screen."
> "Log in with test@example.com, drive to checkout, and record it as a replayable test."

## What the agent gets

| | Tool | What it does |
|---|---|---|
| 👁 | `tapp_open_app` | **See a screen** — launch the app, return screenshot + accessibility tree. Seconds. |
| 📸 | `tapp_screenshot` | Whatever's on the sim right now, as an inline image. |
| 🌳 | `tapp_ui_tree` | The accessibility tree of the current screen (ids, labels, hittability). |
| 🕹 | `tapp_session_start/act/end` | **Interactive driving** — the Playwright loop. App launches once; each act (tap/type/swipe/back/wait) returns the fresh tree. |
| 🧪 | `tapp_run_qa` | **Autonomous QA** — explores with no authored test, returns `{verdict, releaseScore, findings[]}`. Takes `appBundleId` (iOS), `androidAppId` (Android), or `url` (web). |
| 🧭 | `tapp_init` | **Repository import** — detect targets; optionally explore a real surface; persist the shared UI Map; construct the evidence-classified model and grounded release plan. |
| 👤 | `tapp_actor_config` | **Actor/session setup** — store roles, isolation/provisioning, and environment-variable names without accepting or persisting credential values. |
| ✅ | `tapp_release_plan` | **Release-plan lifecycle** — inspect, approve/reject/defer, generate, real-target validate, and explicitly promote proposed guarantees without silent test edits. |
| 🚦 | `tapp_ci_setup` | **Baseline and CI setup** — import a conclusive target baseline or render/install the same reviewable target-aware workflow as the CLI. |
| 🗺️ | `tapp_ui_map` | **Persistent UI Map** — build, inspect, merge, and diff observed states, controls, transitions, provenance, and coverage. |
| 🧩 | `tapp_task` | **Reusable deterministic Tasks** — validate and compile shared actions such as `signIn` against the UI Map; replay stays keyless. |
| 📜 | `tapp_release_contract` | **Business-level release contracts** — validate, compile, or run typed guarantees composed from Tasks and named actors. |
| 📋 | `tapp_pr_plan` | **PR-aware evolution** — select reviewed contracts, schedule bounded changed-surface exploration, and explicitly adopt observed coverage proposals without silent rewrites. |
| 🔁 | `tapp_flow_run` / `flow_save` / `flow_generate` | **Deterministic E2E execution (Flows)** — raw steps or reusable Task calls replay with exact assertions. |
| 👥 | `tapp_scenario_run` | **Multi-actor system tests** — isolated named browser sessions verify cross-account state with deterministic assertions. No AI at replay time. |
| 📱 | `tapp_list_simulators` / `boot_simulator` / `install_app` | Simulator + app management. |
| 🩺 | `tapp_health`, `tapp_capture*`, `tapp_parse_markers` | Diagnostics and capture history. |

Full agent playbook: [AGENTS.md](./AGENTS.md) — ships inside the package so agents can read it too.
Application-model and import contract: [`docs/application-model.md`](docs/application-model.md).
The desktop Coverage view reads the same `.autotap/application-model.json`,
`.autotap/release-plan.json`, and `.autotap/ui-map.json`, including explicit proposal review; it
does not maintain a separate product model. Map nodes identify both the real launch entry and the
deterministic per-platform navigation root used for bounded changed-surface replay.

## The verdict you can trust

**Adaptive exploration, deterministic judgment.** Exploration is adaptive — two runs may
traverse different paths through your app. Judgment is deterministic: the same evidence
trace always produces the same findings, the same score, and the same verdict — no LLM variability
in the decision loop. PR gating keys on the **regression diff**
(stable finding signatures vs. a baseline), so it reacts to what *changed*, not to
run-to-run path variance. For critical user journeys, committed **Tasks and Flows** provide the stable CI
suite: reusable semantic actions, exact assertions, condition-based waits, fresh launch state, bounded timeouts,
and evidence on failure. We call this *flake-resistant*, not magically flake-free—backend outages,
unstable test data, and poorly identified controls can still make any E2E test fail.

**A release score, not "confidence."** The 0–100 number is a heuristic quality score from
fixed, documented deductions — we don't call it confidence because it isn't calibrated
probability. Calibrating it against seeded-fault benchmarks is ongoing work; until then it
ranks runs, it doesn't promise odds.

`tapp_run_qa` explores like a user — accessibility surfaces on iOS/Android and a real browser on web —
and detects crashes, failed sign-ins, dead buttons, stuck loading screens, error surfaces,
navigation loops, and dead ends (plus, on web: uncaught JS exceptions, failed/5xx requests,
broken links and assets). The verdict is **deterministic** (no LLM in the run loop) and **honest**:

- `blocked` — a release-blocking issue was found.
- `caution` — issues to review, or the run couldn't see enough.
- `ready` — genuinely explored with no blockers. **A shallow run is never `ready`** — if the
  app crashed on launch or a login wall blocked exploration, you get `inconclusive: true`,
  not a false pass. Absence of findings is not a pass.

Apps behind a login? Pass `testEmail`/`testPassword` (typed into the login form automatically),
`appLaunchArgs` (e.g. `["--uitesting"]` if your app supports a bypass), or explicit `loginSteps`
for custom login UIs.

## CI gate

The same engine runs as a merge gate — explore on every PR, replay committed release contracts,
Flows, and multi-actor Scenarios, diff findings
against the last conclusive default-branch run, fail on regressions, post a sticky PR comment, and
upload screenshots, the recording, and machine-readable JSON:

```yaml
# .github/workflows/tapp.yml
name: Tapp release gate
on:
  pull_request:
  push:
    branches: [main] # refreshes the automatic baseline after merges

permissions:
  actions: read
  contents: read
  pull-requests: write

concurrency:
  group: tapp-${{ github.ref }}
  cancel-in-progress: true

jobs:
  tapp:
    runs-on: macos-15
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: aarwitz/tapp@main # pin to the newest release tag for production
        with:
          project: MyApp.xcodeproj # or MyApp.xcworkspace
          scheme: MyApp
```

On pull requests, the Action automatically reads the complete changed-file set from GitHub,
retaining old and new paths for renames. It always runs critical/`policy.always` contracts, adds
contracts related through reviewed source ownership, the UI Map, and transitive Task composition,
and records skipped contracts and coverage gaps in `tapp-pr-plan.json`. A selected contract that
does not execute blocks the merge. Set `pr-selection: "false"` only when intentionally running the
full contract set.

Changed weakly covered surfaces are not limited to direct web URLs. Reviewed Task source ownership
can compile one bounded native target (or up to five web targets) through observed UI Map edges,
with condition waits and stable target evidence. Missing or failed targets make the run
inconclusive; Tapp does not guess a path from a screen name.

The first successful, conclusive run on `main` seeds a repository-scoped Actions cache and a
90-day baseline artifact. Both are keyed by platform and stable application-model target id. Pull requests automatically restore it and fail only on **new**
high/critical findings or broken Flows—not pre-existing debt. No baseline commit or PAT is required.
If you prefer a reviewed, durable baseline, run `tapp baseline create` and commit the generated
`.autotap/baselines/<platform>/<target-id>.json`; `tapp ci install` wires its explicit path into the
corresponding job. The legacy `.autotap/baseline.json` is still recognized. Automatic baseline restore and the PR comment need `actions: read` and
`pull-requests: write` as shown above. Secrets are unavailable to workflows from forks, so
auth-gated apps should either use a non-secret UI-testing launch argument or skip the gate for
untrusted forks.

Already build the simulator app in another job, or use another CI provider? The portable command
accepts that `.app`, detects its bundle id, writes report artifacts, and exits non-zero when the
gate fails:

```bash
npx -y runtapp ci --app path/to/MyApp.app \
  --project-dir . --pr-base origin/main --pr-head HEAD \
  --target-key target_ios_myapp \
  --pr-plan-out tapp-pr-plan.json \
  --baseline path/to/last-main-report.json \
  --json-out tapp-report.json --md-out tapp-report.md
```

See the self-test at
[.github/workflows/autotap-gate-example.yml](.github/workflows/autotap-gate-example.yml) for
Flows, auth inputs, and other controls. GitHub-hosted iOS runs require a macOS runner; the first
run also builds the XCUITest harness, so budget roughly 5–10 minutes depending on app size.

Android CI runs on Linux with an emulator/device already connected. The Action can build the APK
or accept a prebuilt one:

```yaml
- uses: aarwitz/tapp@main
  with:
    platform: android
    android-app-id: com.acme.app
    android-project: android
    android-task: :app:assembleDebug
    flows: android/.autotap/flows/*.yml
```

For web, pass `platform: web` plus `web-target:` and Tapp uses the application model to run its
lockfile-backed install/build, start a detected package script or read-only static server, wait for
readiness, gate it, and stop it even on failure. Pass `url:` instead for an already-running owned
environment. Add
`scenarios: .autotap/scenarios/*.yml` to gate isolated cross-account journeys; see
[`docs/scenarios.md`](docs/scenarios.md). Automatic
baselines are isolated by platform and target, so two same-platform apps are never compared.

**The hosted service at `app.runtapp.com` is under development and is not currently offered for
customer repositories.** Do not upload private code or credentials to an old preview. The retained
cloud prototype is not the production SaaS boundary. Use the local Release Studio and the portable
GitHub Action in infrastructure you control until the new account, tenant authorization, private
evidence, and isolated-worker boundary passes security review.

## Make your repo agent-verified

Drop this into your repo's `AGENTS.md` (read by Codex, Cursor, Copilot, Devin, Zed, …) so
your agent proves its UI work instead of claiming it:

```markdown
## Verifying UI changes
This repo uses tapp (https://github.com/aarwitz/tapp) to verify UI work on a real app surface
(iOS simulator, Android emulator/device, or a browser for web). After any UI change, run `npx -y runtapp open` from the
repo root (it finds and builds the Xcode project itself) and look at the screenshot it saves as
proof. Before declaring a feature done, run `npx -y runtapp qa` (or `qa <url>` for web) and
report the ship/no-ship verdict. A change is not "done" until it has been seen working.
(If the tapp MCP server is connected, the tapp_* tools do the same with inline screenshots —
tapp_build builds + installs the app and returns the bundle id for tapp_run_qa.)
```

## How it works

Every driver speaks one protocol: structured `OCQA_*` markers (state, actions, issues,
transitions) that the judgment layer parses into trees, screenshots, findings, and the verdict.
On **iOS**, a generic **XCUITest harness** attaches to any app by bundle id — no SDK or app code
changes — and acts through the accessibility tree. On **Android**, ADB + UIAutomator provide the
same black-box driver contract. On **web** (beta), a deterministic **Playwright crawler** does the
same in a real browser. Same detectors' spirit,
same dedup, same regression gate, same honest verdict. Core exploration, evidence collection, and
verdict calculation run entirely locally — no telemetry, nothing phones home. Optional AI
features are explicit: finding enrichment requires `TAPP_ENABLE_REMOTE_AI=1` (an ambient
API key alone never changes data handling), and AI flow generation / `assert_ai` only run
when you invoke them; these send selected metadata (screen names, finding titles) to your
configured model provider. Env vars: `TAPP_*` preferred; `AUTOTAP_*` accepted as deprecated
aliases.

Committed Flow replay, recording a driven session, autonomous exploration, exact assertions,
regression comparison, and CI gating require **no API key and no coding agent at runtime**. AI is
only an optional authoring/enrichment layer (`tapp_flow_generate`, `assert_ai`, finding enrichment).

The first tool call builds the harness once (~2 min, cached in `~/.tapp`; rebuilt automatically
if you switch simulators). All captures land in `~/.tapp/captures/`.

## Desktop status

The macOS cockpit is frozen as a supported native interface and parity floor; it still reads the
canonical Application Model, release plan, and UI Map in Coverage. Its older import/build path is
not yet a thin client of the shared product-operation layer, so new product work is converging in
the browser without deleting or reducing the desktop experience.

## License

[MIT](./LICENSE)

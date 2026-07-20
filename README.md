# tapp — ship with proof

[![npm](https://img.shields.io/npm/v/tapp-mcp?color=cb3837&label=npm)](https://www.npmjs.com/package/tapp-mcp)
[![npm downloads](https://img.shields.io/npm/dw/tapp-mcp?label=downloads)](https://www.npmjs.com/package/tapp-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Install in Cursor](https://img.shields.io/badge/Cursor-Install_MCP-000000)](cursor://anysphere.cursor-deeplink/mcp/install?name=tapp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInRhcHAtbWNwIiwibWNwIl19)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_MCP-0098FF)](https://insiders.vscode.dev/redirect/mcp/install?name=tapp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22tapp-mcp%22%2C%22mcp%22%5D%7D)

**Your coding agent has hands. tapp gives it judgment** — autonomous QA with a deterministic
ship/no-ship verdict, for the apps your agent builds.

Coding agents can write the code, and (with Playwright & friends) they can even drive the app.
What nobody gives them is **judgment**: did it actually work? tapp explores your app like a user —
no test code, no app changes — detects what's broken, and commits to a verdict your merge queue
can trust: `ready`, `caution`, or `blocked`, with evidence.

Two platforms, one judgment layer:

- **iOS** — the missing Playwright for iOS. tapp is hands *and* judgment: a generic XCUITest
  harness drives any app on the simulator via the accessibility surface. Native — no Appium,
  no WebDriverAgent.
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

Requirements: **macOS + Xcode** (simulator runtimes installed), **Node ≥ 18**.

**Claude Code:**
```bash
claude mcp add tapp -- npx -y tapp-mcp mcp
```

**Cursor / VS Code (Copilot)** — add to `~/.cursor/mcp.json` (Cursor) or `.vscode/mcp.json` (VS Code):
```json
{
  "servers": {
    "tapp": { "type": "stdio", "command": "npx", "args": ["-y", "tapp-mcp", "mcp"] }
  }
}
```

**Codex CLI** — add to `~/.codex/config.toml`:
```toml
[mcp_servers.tapp]
command = "npx"
args = ["-y", "tapp-mcp", "mcp"]
```

**Any other MCP client:** stdio command `npx -y tapp-mcp mcp`.

Optional but recommended (prebuilds the test harness so the first tool call is fast):
```bash
npx -y tapp-mcp install    # ~2 min, one time
npx -y tapp-mcp doctor     # verify Xcode / simulators / toolchain
```

Then ask your agent:
> "Open com.mycompany.app on the simulator and screenshot the home screen."
> "Run autonomous QA on my app — is it ship-ready?"
> "Log in with test@example.com, drive to checkout, and record it as a replayable test."
> "Run autonomous QA on http://localhost:3000 — anything broken?" *(web beta — one-time
> setup: `npm i -g playwright && npx playwright install chromium`)*

## What the agent gets (19 tools)

| | Tool | What it does |
|---|---|---|
| 👁 | `tapp_open_app` | **See a screen** — launch the app, return screenshot + accessibility tree. Seconds. |
| 📸 | `tapp_screenshot` | Whatever's on the sim right now, as an inline image. |
| 🌳 | `tapp_ui_tree` | The accessibility tree of the current screen (ids, labels, hittability). |
| 🕹 | `tapp_session_start/act/end` | **Interactive driving** — the Playwright loop. App launches once; each act (tap/type/swipe/back/wait) returns the fresh tree. |
| 🧪 | `tapp_run_qa` | **Autonomous QA** — explores the app with no test code, returns `{verdict, confidence, findings[]}`. Streams live progress. Takes `appBundleId` (iOS) or `url` (web beta). |
| 🔁 | `tapp_flow_run` / `flow_save` / `flow_generate` | **Deterministic E2E tests (Flows)** — record a session as a replayable YAML test, generate one from a natural-language goal, replay with assertions. |
| 📱 | `tapp_list_simulators` / `boot_simulator` / `install_app` | Simulator + app management. |
| 🩺 | `tapp_health`, `tapp_capture*`, `tapp_parse_markers` | Diagnostics and capture history. |

Full agent playbook: [AGENTS.md](./AGENTS.md) — ships inside the package so agents can read it too.

## The verdict you can trust

`tapp_run_qa` explores like a user — the accessibility surface on iOS, a real browser on web —
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

The same engine runs as a merge gate — explore on every PR, replay committed Flows, diff findings
against a baseline, fail on regressions, post the report as a PR comment:

```bash
npx -y tapp-mcp ci --app path/to/MyApp.app --bundle-id com.mycompany.app
```

Or use the bundled GitHub Action (`action.yml`) on a macOS runner — see
[.github/workflows/autotap-gate-example.yml](.github/workflows/autotap-gate-example.yml).
Commit a `.autotap/baseline.json` from a main-branch run and PRs fail only on **new**
high/critical findings, not pre-existing debt.

**Hosted gate (early access).** Don't want to run Mac CI yourself? The tapp Release Gate
runs the same engine on our infrastructure: install a GitHub App, and every PR gets the
verdict as a check + comment with evidence and automatic regression gating — no runners,
no PATs, no YAML. We're onboarding a small number of design partners by hand —
[apply here](https://github.com/aarwitz/tapp/issues/new?title=Design-partner%20interest&body=Repo%3A%0AApp%20platform%20(iOS%2Fweb)%3A%0AWhat%20breaks%20your%20current%20CI%2FQA%20setup%3A).

## Make your repo agent-verified

Drop this into your repo's `AGENTS.md` (read by Codex, Cursor, Copilot, Devin, Zed, …) so
your agent proves its UI work instead of claiming it:

```markdown
## Verifying UI changes
This repo uses tapp (https://github.com/aarwitz/tapp) to verify UI work on a real app surface
(iOS simulator, or a browser for web). After any UI change: build/serve the app, then use the
tapp MCP tools (`npx -y tapp-mcp mcp`) to open the changed screen and screenshot it as proof.
Before declaring a feature done, run `tapp_run_qa` (appBundleId for iOS, url for web) and
report the ship/no-ship verdict. A change is not "done" until it has been seen working.
```

## How it works

Every driver speaks one protocol: structured `OCQA_*` markers (state, actions, issues,
transitions) that the judgment layer parses into trees, screenshots, findings, and the verdict.
On **iOS**, a generic **XCUITest harness** attaches to any app by bundle id — no SDK, no code
changes, no re-signing — and acts through the accessibility tree. On **web** (beta), a
deterministic **Playwright crawler** does the same in a real browser. Same detectors' spirit,
same dedup, same regression gate, same honest verdict. Everything runs locally on your Mac;
nothing leaves it.

The first tool call builds the harness once (~2 min, cached in `~/.tapp`; rebuilt automatically
if you switch simulators). All captures land in `~/.tapp/captures/`.

## Coming soon

**tapp.app** — a macOS cockpit around the same engine: import an iOS project, click Run, watch
autonomous QA live, and get the ship/no-ship decision card. Free download, in packaging.

## License

[MIT](./LICENSE)

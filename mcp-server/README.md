# AutoTap MCP server

Lets an MCP client — **GitHub Copilot in VS Code**, Claude, Cursor, etc. — drive Tapp's
autonomous iOS QA the way the Playwright MCP lets it drive a browser. Copilot can boot a
simulator, run autonomous QA against an installed app, get a structured **ship/no-ship verdict
with findings**, and inspect the screen (UI tree + screenshot).

It's a thin, real wrapper over the same harness + scripts the AutoTap app uses — no LLM in the
loop, deterministic output.

## Requirements

- macOS with Xcode + command-line tools (`xcodebuild`, `xcrun simctl`).
- Node ≥ 18.
- The AutoTap repo checked out (this server resolves paths relative to it).
- A built harness for `tapp_run_qa` / `tapp_ui_tree` (the tools auto-build it on first
  use, or run `scripts/deploy-and-build.sh --harness` once).

```bash
cd mcp-server && npm install
```

## Use it from Copilot in VS Code

Add `.vscode/mcp.json` to the AutoTap workspace (already included in this repo):

```json
{
  "servers": {
    "tapp": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/mcp-server/src/index.js"]
    }
  }
}
```

Then open Copilot Chat in **Agent mode** → the `tapp_*` tools appear in the tool picker.
(Other clients: point them at `node /abs/path/to/AutoTap/mcp-server/src/index.js` over stdio.)

### A typical Copilot session

1. `tapp_list_simulators` → pick a device, `tapp_boot_simulator` to boot it.
2. Install/launch the target app on that simulator (your normal build step, or Tapp's import).
3. `tapp_run_qa { appBundleId: "com.acme.app" }` → returns the verdict + findings.
4. `tapp_ui_tree` / `tapp_screenshot` to inspect a screen while debugging a finding.

## Tools

| Tool | What it does |
|---|---|
| **`tapp_run_qa`** | **The main one.** Autonomously explores an installed app on the booted sim and returns `{verdict: ready\|caution\|blocked, confidence, headline, screensExplored, actionsPerformed, findings[]}`. Args: `appBundleId` (required), `maxActions`, `timeout`, `testEmail`/`testPassword`, `inputOverrides`, `appLaunchArgs`, `appLaunchEnv`. Streams live progress. |
| `tapp_ui_tree` | Accessibility tree of the current screen — `{screenTitle, elements[]}`. The inspection primitive (one-shot). |
| `tapp_open_app` | **Just see a screen** — launch the app (optionally bypassing login) and return a screenshot + tree, no exploration (seconds). Use this, not `run_qa`, to view/screenshot a screen. |
| `tapp_screenshot` | Returns whatever is **currently** on the booted sim as an inline image (downscaled JPEG). Doesn't launch anything — use during a session or after `open_app`. |
| **`tapp_session_start` / `tapp_session_act` / `tapp_session_end`** | **Persistent interactive session** — the Playwright-style tap → inspect loop. The app launches once and stays up; each `act` (tap by id/label/coords, type, swipe, back, **wait**, screenshot, tree) returns the fresh `{screenTitle, elements[]}` without a cold relaunch. `start` takes `appLaunchArgs`/`appLaunchEnv`/`testEmail`/`testPassword`. One session at a time. |
| `tapp_list_simulators` | Available simulators (name/udid/state/runtime/booted). |
| `tapp_boot_simulator` | Boot a sim by `udid` or `name` (no-op if already booted). |
| `tapp_install_app` | Build a project/workspace + scheme for the booted sim and install it (best-effort). |
| `tapp_health` | Toolchain/workspace check (Xcode, simctl, repo). |
| `tapp_build` | Build the AutoTap app/harness (`clean`, `harness`). |
| `tapp_capture` | Lower-level capture (`screenshot`/`record`/`explore`/`tree`). |
| `tapp_parse_markers` | Parse a capture's OCQA markers into a summary. |
| `tapp_list_captures` / `tapp_capture_summary` | Browse past capture runs. |

## The verdict (what `tapp_run_qa` returns)

Mirrors the AutoTap app's deterministic logic, including the **coverage floor** — so a clean
result is trustworthy:

- `findings[]` — deduped issues with `{type, severity, category, title, screen}`. Detected types
  include `crash`, `auth_failed`, `submit_failed`, `error_surface`, `app_hang`,
  `unresponsive_element`, `navigation_loop`, `dead_end`, `blank_screen`.
- `verdict` — `blocked` if any critical; `caution` if shallow/inconclusive or has high issues or
  confidence < 80; `ready` only when the app was genuinely explored with no blockers.
- `inconclusive: true` when fewer than 2 screens / 3 actions were reached (crash on launch, a
  sign-in wall, etc.). In that case the verdict is **never** `ready` — absence of findings is not
  a pass.

## Auth

If `AUTOTAP_MCP_TOKEN` is set in the server's environment, the mutating tools (`tapp_build`,
`tapp_capture`, `tapp_run_qa`, `tapp_ui_tree`, `tapp_screenshot`,
`tapp_boot_simulator`, `tapp_install_app`, `tapp_session_*`) require a matching `authToken`
argument. Read-only tools are always open.

### Interactive session (Playwright-style)

```
tapp_session_start { appBundleId: "com.acme.app" }   // launch once → initial tree
tapp_session_act   { action: "tap", id: "email_field" }
tapp_session_act   { action: "type", text: "user@acme.com" }
tapp_session_act   { action: "tap", id: "sign_in_button" }   // → fresh tree of the next screen
tapp_session_end   {}
```

The app stays launched between `act` calls (no cold relaunch per action), driven via a file-IPC
command queue serviced by the harness's `testInteractiveSession`. The session starts from a
**fresh launch** (the app is terminated + relaunched), so it always begins at the app's launch
screen. `tap` matches by accessibility id, exact label, or a forgiving case-insensitive
*contains* on the visible label, or by `x`/`y` points. Use `wait` (`{action:"wait", id|text,
timeoutMs}`) after navigation/loading to block until an element appears. Every `act` returns the
post-action `{screenTitle, elements[]}`; call `tapp_screenshot` any time to see it visually.

### Real apps (backend override / login bypass)

For an app that needs a test backend or a login bypass, pass launch arguments/environment — both
`tapp_run_qa` and `tapp_session_start` accept them and forward them to the app's launch:

```
tapp_run_qa {
  appBundleId: "com.acme.app",
  appLaunchEnv: { "UI_TEST_BACKEND": "staging" },
  appLaunchArgs: ["--uitesting"],
  testEmail: "qa@acme.com", testPassword: "..."
}
```

### Live progress

`tapp_run_qa` streams progress while it explores: if the client passes a `progressToken`
(MCP standard `_meta.progressToken`), the server emits `notifications/progress` updates
(`N/max actions, K states visited`) as the harness runs — Copilot shows them during the call.

## Known limitations

- Tools run against the **locally booted** simulator on this Mac (no remote/device-farm yet).
- One interactive session at a time; an `act` is bounded by a 30s per-command timeout.

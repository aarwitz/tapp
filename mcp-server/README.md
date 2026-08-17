# Tapp MCP server

The Tapp MCP server gives coding agents eyes, hands, and release judgment on real iOS, Android, and
web application surfaces. It uses the same product operations as the CLI and local browser Release
Studio; MCP adds inline screenshots and a long-lived interactive session loop.

Normal exploration, deterministic Flow/Task/contract replay, evidence, regression comparison, and
release judgment do not require a model or Tapp cloud account.

## Recommended installation

Requirements:

- Node 18 or newer;
- iOS: macOS, Xcode, and a simulator runtime;
- Android: `adb` and a connected emulator/device;
- web: Playwright and Chromium.

Run directly from npm:

```bash
npx -y @aarwitz/tapp doctor
npx -y @aarwitz/tapp mcp
```

Example MCP client configuration:

```json
{
  "servers": {
    "tapp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@aarwitz/tapp", "mcp"]
    }
  }
}
```

For source development in this repository, use `node mcp-server/src/index.js` from the repository
root after `npm install`.

## Pick the right operation

- `tapp_open_app`: launch and inspect one screen quickly.
- `tapp_ui_tree` / `tapp_screenshot`: inspect the current surface.
- `tapp_session_start` → `tapp_session_act` → `tapp_session_end`: drive a persistent session.
- `tapp_explore`: autonomous multi-minute exploration → an observation (findings + evidence), not a ship verdict.
- `tapp_flow_save` / `tapp_flow_run` / `tapp_flow_generate`: record, replay, or ground a Flow.
- `tapp_init`, `tapp_release_plan`, `tapp_task`, `tapp_release_contract`, `tapp_ui_map`: operate the
  shared repository product model and reviewed release-contract lifecycle.
- `tapp_ci_setup`: create/review target-specific baseline and portable CI setup.
- platform diagnostics and management: health, simulators, app build/install, captures.

The full, versioned agent playbook is [`../AGENTS.md`](../AGENTS.md). Read the `elements[]` returned
after every action, tap fields before typing, and wait explicitly after navigation/network work.

## Typical session

```text
tapp_session_start { appBundleId: "com.acme.app" }
tapp_session_act   { action: "tap", id: "Email" }
tapp_session_act   { action: "type", text: "qa@example.com" }
tapp_session_act   { action: "tap", id: "Sign In" }
tapp_session_act   { action: "wait", text: "Home", timeoutMs: 10000 }
tapp_screenshot
tapp_session_end
```

Android uses `androidAppId` and optionally `apkPath`; web sessions use an owned `url`. Prefer stable
resource/accessibility ids or exact labels over coordinates.

## Observation and gate contract

`tapp_explore` returns a structured **observation** — `kind: "tapp-exploration-run"`, reached
screens/actions, findings (each with an `authority` tag), coverage limits, and `inconclusive` state.
It carries **no** ship verdict, release score, or confidence.

A crash-on-launch, login wall, missing device, or shallow trace is `inconclusive`, never a pass —
absence of findings is not a pass. Adaptive exploration can traverse different paths; the
**merge decision is the gate's**, not exploration's.

The **gate** (CI: reviewed contracts + committed Flows/Scenarios + baseline regressions) applies
versioned deterministic policy to that evidence and returns `pass | fail | inconclusive`
(`inconclusive` fails closed). The same captured evidence + contracts + baseline always produces the
same outcome. Promoted Flows/Tasks/contracts give critical journeys stable replay.

## Credentials, AI, and local data

Test credentials are typed into the target and must not be echoed into results or logs. Repository
artifacts store environment-variable binding names, not resolved values. Captures remain on the
machine/runner unless the user explicitly uploads or shares them.

Remote AI is optional and explicit. Finding enrichment requires `TAPP_ENABLE_REMOTE_AI=1` in
addition to a configured model backend; generation and `assert_ai` run only when deliberately
invoked. Deterministic replay and the normal gate remain keyless.

When `TAPP_MCP_TOKEN` is configured, protected MCP operations
require the matching `authToken`. This is process-level protection for a local server, not hosted
user authentication or multi-tenancy.

## Hosted status

The MCP server is a local/runner interface. It is not the account or authorization boundary for
the future hosted application, and an MCP token is not a customer login token. The hosted service is under
development and must not accept private repositories through a legacy preview.

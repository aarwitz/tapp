# Tapp for VS Code

Give Copilot agent mode the Tapp Agent Skill for testing real iOS, Android, and web applications.
The extension also contributes focused iOS simulator tools and an auto-refreshing screenshot
preview beside the editor. It is a preview, not an embedded Simulator or video stream.

| Need | Tapp exposure |
|---|---|
| Decide how to test the current app | bundled Tapp Agent Skill |
| Open/read/screenshot an iOS screen | `tapp_open_ios_app`, `tapp_read_ios_screen`, `tapp_ios_screenshot` |
| Tap, type, or sign in on iOS | `tapp_ios_tap`, `tapp_ios_type`, `tapp_ios_login` |
| Find iOS bugs autonomously | `tapp_explore_ios` — findings, coverage, evidence, and recording |
| Test Android or web | the skill uses the bundled Tapp CLI/MCP workflow |

Exploration is an observation, not permission to ship. It reports what Tapp found, what it covered,
and what it did not check. A deterministic `pass | fail | inconclusive` merge decision comes only
from the Tapp CI gate with reviewed policy and tests.

## Use it

Open an application repository in VS Code and ask Copilot in agent mode:

> Use Tapp to test this app.

For a focused task, say what you need:

> Use Tapp to open the iOS app, navigate to Settings, and show me a screenshot.

> Use Tapp to explore this web app and report evidence-backed findings. Let me watch the browser.

The skill chooses the smallest operation, asks you to select when a repository contains multiple
application targets, and keeps exploration findings separate from gate decisions.

## Requirements

- Node 18 or newer.
- iOS: macOS, Xcode, and an installed simulator runtime.
- Android: `adb` and a connected emulator/device.
- Web: Playwright and Chromium.

The engine is fetched locally from [`@aarwitz/tapp`](https://www.npmjs.com/package/@aarwitz/tapp).
The first iOS use builds a cached test harness under `~/.tapp`. No Tapp account or API key is
required for core testing, and the app under test does not link a Tapp SDK.

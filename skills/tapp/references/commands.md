# Tapp command reference

## Plain CLI

Run from the application repository. `[target]` is optional when Tapp can read the repository model
or detect one unambiguous target.

```bash
npx -y @aarwitz/tapp@latest init . --explore
npx -y @aarwitz/tapp@latest explore [target]
npx -y @aarwitz/tapp@latest open [target]
npx -y @aarwitz/tapp@latest tree [target] --json
npx -y @aarwitz/tapp@latest shot
npx -y @aarwitz/tapp@latest report latest
npx -y @aarwitz/tapp@latest doctor
```

Platform examples:

```bash
# Web: Tapp may build/start/stop a source target; --watch is human-visible.
npx -y @aarwitz/tapp@latest explore --platform web --target website --watch
npx -y @aarwitz/tapp@latest explore https://staging.example.com

# iOS: source repo, .app, or bundle id.
npx -y @aarwitz/tapp@latest explore MyApp.xcodeproj --platform ios
npx -y @aarwitz/tapp@latest open com.example.MyApp --platform ios

# Android: app id is required; APK is optional if already installed.
npx -y @aarwitz/tapp@latest explore app-debug.apk --platform android --app-id com.example.app
```

Focused web evidence can perform one semantic interaction and wait for async content:

```bash
npx -y @aarwitz/tapp@latest open https://example.com --tap "Not now" --wait-for "Dashboard"
```

## MCP mapping

- `tapp_init`: inspect or initialize a source repository; `operation:"explore"` prepares and explores.
- `tapp_build`: build and install an iOS app without needing its bundle id first.
- `tapp_open_app`: launch and return a screen summary plus inline screenshot.
- `tapp_ui_tree` / `tapp_screenshot`: inspect the current real surface.
- `tapp_session_start` → `tapp_session_act` → `tapp_session_end`: drive one persistent journey.
- `tapp_explore`: autonomous iOS, Android, or web exploration; observation only.
- `tapp_flow_save` / `tapp_flow_run`: save a driven journey and replay it deterministically.
- `tapp_release_contract`: validate, compile, or run a reviewed business guarantee.
- `tapp_ci_setup`: create a target-scoped baseline or reviewable CI installation.

An iOS no-bundle-id MCP path is `tapp_build {projectDir:"."}` followed by `tapp_explore` with the
returned `bundleId`. Android uses `androidAppId` and optional `apkPath`; web uses `url` or
source-connected `tapp_init`.

## Interactive session loop

```text
tapp_session_start {appBundleId:"com.example.app"}
tapp_session_act   {action:"tap", id:"Email"}
tapp_session_act   {action:"type", text:"qa@example.com"}
tapp_session_act   {action:"tap", id:"Password"}
tapp_session_act   {action:"type", text:"..."}
tapp_session_act   {action:"tap", id:"Sign In"}
tapp_session_act   {action:"wait", text:"Home", timeoutMs:10000}
tapp_screenshot
tapp_session_end
```

Android sessions use `androidAppId`, optional `apkPath`, and the same action loop.

## Credentials and test configuration

For autonomous exploration, pass test-only values when authorized:

- CLI: `--email`, `--password`, repeated `--launch-arg`, and JSON `--launch-env`.
- MCP: `testEmail`, `testPassword`, `inputOverrides`, `appLaunchArgs`, `appLaunchEnv`, or explicit
  `loginSteps`.

Do not persist secrets in `.tapp/`. If the result reports input fields and no values were supplied,
ask the user rather than pretending the explored surface was complete.

## Replay and gating

Flow YAML belongs under `.tapp/flows/` and can replay without a model or API key:

```bash
npx -y @aarwitz/tapp@latest flow run .tapp/flows/smoke.yml
npx -y @aarwitz/tapp@latest ci
```

`tapp explore` observes. `tapp ci` applies versioned deterministic policy to evidence, selected
Flows/Scenarios/contracts, coverage, and any target-scoped baseline. Its outcomes are `pass`, `fail`,
or `inconclusive`; both `fail` and `inconclusive` block a merge.

## Platform prerequisites

- iOS: macOS, Xcode, and a booted simulator. First use builds a cached harness under `~/.tapp`.
- Android: `adb` and a connected authorized emulator/device.
- Web: Playwright and Chromium. If Tapp reports the browser missing, run
  `npx playwright install chromium` and retry.

Captures and screenshots are stored under `~/.tapp/captures/` and `~/.tapp/shots/`.

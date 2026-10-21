# Tapp command reference

Twelve verbs, one mental model: **explore → look → run/validate → plan → ci**. Older verbs
(`audit`, `focus`, `open`, `tree`, `shot`, `flow`, `task`, `contract`, `scenario`, `pr`, `map`,
`baseline`, `workflows`, `actor`, `install`, `build`, `apps`) still work for one minor version
and print their new form.

## Plain CLI

Run from the application repository. `[target]` is optional when Tapp can read the repository model
or detect one unambiguous target.

```bash
npx -y @aarwitz/tapp@latest init . --explore       # detect targets, write the model + plan, explore once
npx -y @aarwitz/tapp@latest explore [target]       # autonomous exploration → findings, map, evidence (observes; no verdict)
npx -y @aarwitz/tapp@latest explore --goal "Save storefront settings visible above keyboard" [target]  # source-locate + shortest observed route
npx -y @aarwitz/tapp@latest explore --read-only https://example.com --pages 5 --json   # never clicks: safe on production or a site you do not own
#   several URLs or --urls FILE batch sites · --device "iPhone 13" audits the mobile rendering · --json FILE writes the result · exit 1 = defects found
npx -y @aarwitz/tapp@latest look [target]          # one screen: summary + screenshot file
npx -y @aarwitz/tapp@latest look [target] --tree --json   # + the accessibility tree (every element with --json)
npx -y @aarwitz/tapp@latest look latest             # a finished run: its screens and when each was reached
npx -y @aarwitz/tapp@latest look latest --at 6      # that screen's frame, seeked out of the recording
npx -y @aarwitz/tapp@latest look latest --frames    # contact sheets: ~25 frames per image, for scanning
npx -y @aarwitz/tapp@latest report latest
npx -y @aarwitz/tapp@latest doctor                 # toolchain check · --install prebuilds the iOS harness (~2 min, once)
npx -y @aarwitz/tapp@latest feedback "short title" --body "what happened" --type bug|idea|question   # draft; add --submit to file (public)
```

Platform examples:

```bash
# Web: Tapp may build/start/stop a source target; --watch is human-visible.
npx -y @aarwitz/tapp@latest explore --platform web --target website --watch
npx -y @aarwitz/tapp@latest explore https://staging.example.com

# iOS: source repo, .app, or bundle id. `look` with no target reads the booted simulator.
npx -y @aarwitz/tapp@latest explore MyApp.xcodeproj --platform ios
npx -y @aarwitz/tapp@latest look com.example.MyApp --platform ios

# Android source: select a modeled target; Tapp builds, installs, and reaches the goal.
npx -y @aarwitz/tapp@latest explore --goal "About screen" . --target demoapp

# Android black-box entry: app id is required; APK is optional if already installed.
npx -y @aarwitz/tapp@latest explore app-debug.apk --platform android --app-id com.example.app
```

Focused web evidence can perform one semantic interaction and wait for async content:

```bash
npx -y @aarwitz/tapp@latest look https://example.com --tap "Not now" --wait-for "Dashboard"
```

## MCP tools (13)

- `tapp_init`: inspect or initialize a source repository; `operation:"explore"` prepares and explores.
- `tapp_explore`: autonomous iOS, Android, or web exploration; observation only. `readOnly:true`
  never clicks (production or a site you do not own); `goal:"…"` source-locates a named
  screen/control and takes the shortest observed route in the active session.
- `tapp_look`: the current real surface — screen summary plus inline screenshot; `tree:true` adds
  the accessibility tree (`full:true` for the complete raw element list when the default
  ≤160-element projection might omit the text you are checking for).
  Also reads a **finished run**: `capture:"<id>|<path>|latest"` returns the screens it observed
  with the moment each was reached, `at:"<n>|<screen>"` pulls that screen's frame out of the
  recording, `frames:true` returns contact sheets (many frames per image) for scanning a run
  cheaply. Prefer `at:` over `frames:` when you know which screen you want — it is one seek.
- `tapp_session`: one persistent journey. `action:"start"` → `tap|type|swipe|back|wait|tree|login`
  → `action:"end"`. `action:"save_flow"` keeps the driven journey as a Flow; `action:"draft_flow"`
  proposes one from a goal (an untrusted draft until replayed). Sessions begin from a **cold**
  launch: persisted data survives, but an app that gates each cold start behind sign-in shows its
  login wall first — make `login` the first act (`tapp_look` warm-resumes the foregrounded app,
  so it can look signed-in when a fresh session does not).
- `tapp_run`: replay a committed Flow, Task, contract, or Scenario; the kind comes from the file.
  Keyless and deterministic.
- `tapp_validate`: check a Flow/Task/contract/Scenario without launching (`compile:true` shows the
  executor form).
- `tapp_plan`: the release-plan lifecycle via `action`: `show|review|generate|validate|promote|pr|adopt|actor`.
  `actor` stores roles and environment-variable **names**, never values.
- `tapp_map`: build, inspect, merge, and diff the persistent UI Map.
- `tapp_ci`: create a target-scoped baseline or render/install the reviewable CI workflow. The gate
  itself runs from the CLI (`tapp ci`).
- `tapp_build`: `action:"build|install|list_simulators|boot"` — build and install an iOS app without
  knowing its bundle id first, or manage the simulator.
- `tapp_report`: this project's captures and one capture's summary/evidence paths.
- `tapp_doctor`: toolchain and prerequisite check with exact remediation.
- `tapp_feedback`: draft (or, with the user's OK, submit) an issue about Tapp itself.

An iOS no-bundle-id MCP path is `tapp_build {action:"build", projectDir:"."}` followed by
`tapp_explore` with the returned `bundleId`. Android uses `androidAppId` and optional `apkPath`.
Web can use an explicit owned `url`, or `tapp_session {action:"start", projectDir:".", focus:"..."}`
can build/start one unambiguous owned browser target and stop it with `action:"end"`.

## Interactive session loop

```text
tapp_session {action:"start", appBundleId:"com.example.app", focus:"Save storefront settings visible above keyboard", projectDir:"."}
tapp_explore {goal:"Save storefront settings visible above keyboard"}
tapp_session {action:"tap", id:"Email"}
tapp_session {action:"type", text:"qa@example.com"}
tapp_session {action:"tap", id:"Password"}
tapp_session {action:"type", text:"..."}
tapp_session {action:"tap", id:"Sign In"}
tapp_session {action:"wait", text:"Home", timeoutMs:10000}
tapp_look
tapp_session {action:"end"}
```

Android sessions use `androidAppId`, optional `apkPath`, and the same action loop.

## Credentials and test configuration

For autonomous exploration, pass test-only values when authorized:

- CLI: `--email`, `--password`, repeated `--launch-arg`, and JSON `--launch-env`.
- MCP: `testEmail`, `testPassword`, `inputOverrides`, `appLaunchArgs`, `appLaunchEnv`, or explicit
  `loginSteps`.
- Reusable: `tapp plan actor set NAME --email-env ENV --password-env ENV` stores env-var **names**
  (never values); replay resolves them via `tapp run FILE --actor NAME` or
  `tapp_run {actor:"NAME"}`. Re-running `actor set` on an existing actor requires `--replace` —
  idempotent setup scripts must include it.

Do not persist secrets in `.tapp/`. If the result reports input fields and no values were supplied,
ask the user rather than pretending the explored surface was complete.

## Replay and gating

Flow YAML belongs under `.tapp/flows/` and can replay without a model or API key:

```bash
npx -y @aarwitz/tapp@latest validate --example     # a complete starter Flow (step vocabulary: assert_screen = screen TITLE, assert_exists = text present; taps are label-only)
npx -y @aarwitz/tapp@latest validate .tapp/flows/smoke.yml
npx -y @aarwitz/tapp@latest run .tapp/flows/smoke.yml
npx -y @aarwitz/tapp@latest ci                     # the gate · ci install writes the workflow · ci baseline saves a target-scoped baseline
```

Web commands (`look`, `explore`, `run`) accept `--device "iPhone 13"` (any Playwright device
profile) or `--viewport 390x844` to render at mobile sizes, and `look` accepts `--full-page` for a
full-height screenshot — use these for "does it look right on a phone" checks. Web explores also
audit outbound links (DNS, HTTP status, unavailable-shell heuristic) and `mailto:` domains, report an
honest `stopReason` (`no-unexplored-in-scope-controls` when a small surface is swept before the
budget), and return a per-action `trace` in `--json`.

`tapp explore` observes. `tapp ci` applies versioned deterministic policy to evidence, selected
Flows/Scenarios/contracts, coverage, and any target-scoped baseline. Its outcomes are `pass`, `fail`,
or `inconclusive`; both `fail` and `inconclusive` block a merge.

## Platform prerequisites

- iOS: macOS, Xcode, and a booted simulator. First use builds a cached harness under `~/.tapp`.
- Android: `adb` and a connected authorized emulator/device; JDK 17 for source builds (not for a
  prebuilt APK).
- Web: Playwright and Chromium. If Tapp reports the browser missing, run
  `npx playwright install chromium` and retry.

Captures and screenshots are stored under `~/.tapp/captures/` and `~/.tapp/shots/`.

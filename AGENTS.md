# Tapp agent playbook

You (the agent) have Tapp: hands, eyes, and judgment on real app surfaces — iOS simulators,
Android emulators/devices, plus (beta) web apps in a real browser.

## No MCP connected? Just run the CLI

Every core capability works as a plain command — no server, no config. `[target]` is
optional: with nothing, tapp finds + builds the Xcode project in the cwd (or falls back to
the app already on the simulator); it also accepts a repo dir, a `path/to/App.app`, a
bundle id, or (web) an http(s) URL. You never need to know a bundle id up front.

```bash
npx -y @aarwitz/tapp explore [target]     # autonomous exploration → findings + evidence (observation, not a gate; ≈ tapp_explore)
npx -y @aarwitz/tapp explore https://your-app.example --watch  # web: visibly follow the same exploration
npx -y @aarwitz/tapp open [target]   # launch + screen summary + screenshot saved to a file (≈ tapp_open_app)
npx -y @aarwitz/tapp tree [target]   # accessibility tree, --json for every element (≈ tapp_ui_tree)
npx -y @aarwitz/tapp shot            # screenshot the booted sim → file path (≈ tapp_screenshot)
npx -y @aarwitz/tapp apps            # what's installed on the simulator, with bundle ids
npx -y @aarwitz/tapp build [dir]     # build the app in an Xcode repo + install it (≈ tapp_build)
npx -y @aarwitz/tapp explore app.apk --platform android --app-id com.acme.app
npx -y @aarwitz/tapp flow run .tapp/flows/smoke.yml  # committed, keyless E2E replay
```

If repository onboarding detects multiple application targets, target detection is deterministic but
the choice is the user's. Explicit `init --explore` asks even when the model has a saved default; a
later bare `explore` may consume that default. In a human TTY, Tapp displays a numbered selector and
continues in the same command. A non-interactive CLI prints the exact choices and exits before
building. MCP returns
`reason: "target-selection-required"` with structured `choices[]` (`platform`, `name`, `sourcePath`,
`selector`, and exact `command`). **Do not pick one yourself.** Present those choices to the user
with the client's native multiple-choice question UI when available, then rerun using the selected
`--platform` and `--target`. Plain chat can list the same choices when the client has no question
widget.

For focused web evidence, `open` and `tree` accept one semantic interaction plus an async content
wait: `tapp open https://example.com --tap "Not now" --wait-for "Dashboard"`. Tapp waits for the
page to stabilize before capturing it and warns honestly if the bounded wait ends while it is still
loading or changing.

**Seeing the screen, per client:** if you can read image files into your context (Claude
Code's Read tool, Codex's view-image), open the saved screenshot path the CLI prints —
that IS the screen. If you cannot (Cursor, VS Code Copilot), connect the MCP server
instead: its tool results carry the screenshot inline. Screen *recordings* are for the
human: on **iOS**, `tapp explore` records the full exploration and embeds it in the report.html
evidence page (Android does not currently record video) — tell the user the report path so they can
watch it. On **web**, explicit `--watch` opens the isolated Playwright Chromium window and overlays
Tapp's current action and pointer; the overlay is omitted from evidence screenshots. It does not
drive the person's existing/default browser profile.

The interactive session/record loop is MCP-only (it needs a long-lived process). Flow replay is
also available in the CLI. The rest of this playbook assumes the `tapp_*` MCP tools are connected. With
MCP, the no-bundle-id path is: `tapp_build {projectDir}` (auto-detects + builds +
installs, returns the bundle id) → `tapp_explore {appBundleId}`.

## Pick the right tool for the job

| The user wants… | Use | NOT |
|---|---|---|
| "Show me / screenshot a screen" | `tapp_open_app` (launch + screenshot + tree, ~15s) | `tapp_explore` (a full multi-minute QA exploration) |
| "Tap through / drive / fill a form / log in" | `tapp_session_start` → `session_act` loop | repeated `open_app` calls (cold relaunch each time) |
| "Is my app broken? Find bugs" | `tapp_explore` — `appBundleId` for iOS, `androidAppId` for Android, `url` for owned web apps; returns an observation (findings + evidence), not a ship verdict — gate a merge with the CI gate (`tapp ci` CLI / the GitHub Action) + a contract | a manual session (exploration is autonomous) |
| "Make this flow a repeatable test" | drive it in a session, then `tapp_flow_save`; replay with `tapp_flow_run` | re-driving it by hand every time |
| "What's on screen right now?" | `tapp_screenshot` / `tapp_ui_tree` | relaunching the app |

## Session driving (the Playwright loop)

```
tapp_session_start { appBundleId: "com.acme.app" }     → fresh launch + initial tree
tapp_session_act   { action: "tap",  id: "Email" }      → tap by a11y id OR visible label
tapp_session_act   { action: "type", text: "qa@x.com" } → types into the focused field
tapp_session_act   { action: "tap",  id: "Sign In" }
tapp_session_act   { action: "wait", text: "Home", timeoutMs: 10000 }  → block until it appears
tapp_screenshot                                          → see it
tapp_session_end
```

Android uses the same loop with `tapp_session_start { androidAppId: "com.acme.app", apkPath:
"path/to/app.apk" }`. Android selectors prefer resource id, then content description, exact text,
and text contains. The APK/app id replace the iOS bundle/simulator build inputs.

Rules that prevent 90% of failures:

1. **Read `elements[]` from the previous result before tapping.** Ids and labels shift between
   builds — never tap from memory. `tap` matches accessibility id, exact label, or a forgiving
   case-insensitive contains; `{x, y}` coordinates are the last resort.
2. **Check `hittable`.** A disabled control shows `hittable: false` — a Submit button that won't
   tap usually means the form isn't validly filled, not that the button is missing. Fill the
   fields first.
3. **`wait` after anything async** (navigation, network loads): `{action: "wait", id|text, timeoutMs}`.
   Never assume the next screen is instantly there.
4. **Tap the field before typing** — `type` goes to the focused field. Tap email → type email →
   tap password → type password.
5. Tap results: `ok` (landed), `not_hittable` (exists but disabled/covered — the harness
   auto-dismisses keyboards and retries), `not_found` (nothing matches — re-read the tree).
6. One session at a time. `session_start` always begins from a fresh app launch.

## Autonomous exploration (`tapp_explore`)

Exploration **observes** — it returns an observation, NOT a ship verdict or score. To get a release
decision, run the deterministic gate (`tapp ci` / the GitHub Action). It applies versioned policy to
the findings + coverage plus any selected Flows/Scenarios/contracts and an optional target-scoped
baseline (both optional — a clean bootstrap can pass without them) and returns `pass | fail |
inconclusive`.

Returns `{kind:"tapp-exploration-run", headline, inconclusive, screensExplored, actionsPerformed,
findingCounts, findings[]}` — **no** `verdict`, `confidence`, or `releaseScore`. Each finding carries
`authority` (`deterministic` — marker-derived; model/vision findings would be `model-observed` and
advisory). Report the finding counts and coverage; do not invent a scalar or a ship verdict.

- `inconclusive: true` means the run couldn't see enough (crash on launch, login wall). That is
  **not a pass** — tell the user what blocked exploration and what would unblock it.
- Login walls: pass `testEmail`/`testPassword` (auto-typed into login forms), `appLaunchArgs`
  (e.g. `["--uitesting"]` if the app has a test bypass), and/or `appLaunchEnv` (e.g. a staging
  backend URL). If the result shows `inputFieldsEncountered` and you have no credentials, **ask
  the user** for them rather than re-running blind.
- Diff two runs: pass the previous run's `findings` as `baselineFindings` → you get a
  `regression` **comparison** (`new` / `persisting` / `resolved`) — an observation, not a gate. To gate
  a merge on regressions, run the CI gate (`tapp ci` / the GitHub Action).
- On web, preserve scope: Tapp deterministically checks technical behavior such as failed requests,
  missing assets, and placeholder links. Dead-control probes are budget-capped advisory findings.
  Tapp does not validate marketing claims against APIs, API field privacy, brand consistency, or
  subjective marketplace credibility unless an explicit reviewed test/contract or verifier covers them.

## Flows (deterministic E2E tests)

Flow YAML is repository-native test code. Commit it under `.tapp/flows/`; CI can replay it
without a coding agent, model, subscription, or API key. AI generation and `assert_ai` are optional.

- **Record:** every successful `session_act` is recorded. After driving a flow, call
  `tapp_flow_save { name: "checkout" }` → writes `.tapp/flows/checkout.yml` with waits and
  a final screen assertion auto-inserted; typed credentials are templated to `$TEST_EMAIL`/`$TEST_PASSWORD`.
- **Replay:** `tapp_flow_run { flowPath: ".tapp/flows/checkout.yml" }` — exact steps,
  deterministic assertions, same result every time. A failed assertion is a finding.
- **Generate:** `tapp_flow_generate { goal: "log in and add the first item to cart" }` —
  grounded in the app's actually-explored screens, so it can't invent steps.

## Setup facts (tell the user when relevant)

- iOS runs locally on a Mac with Xcode + a simulator. Android needs `adb` and a connected
  emulator/device. Web needs Playwright + Chromium. `tapp doctor` reports each capability.
- First tool call builds the test harness once (~2 min, cached in `~/.tapp`). `tapp install`
  prebuilds it. Switching simulators triggers an automatic rebuild.
- The app under test must be **installed on the booted simulator** (`tapp_install_app` builds
  and installs from an Xcode project/workspace; or the user's normal build).
- A simulator must be booted (`tapp_list_simulators` → `tapp_boot_simulator`).
- Screenshots/captures land in `~/.tapp/captures/`.

## Honesty rules

- Never claim a screen/flow works without having actually driven or seen it via these tools.
- If a tool call fails twice for the same reason, stop and tell the user what's failing instead
  of retrying variations.
- When you show a screenshot as proof, say what it proves and what it doesn't ("login works;
  I haven't verified checkout").

# Tapp agent playbook

You (the agent) have Tapp: hands and eyes on real app surfaces — iOS simulators, Android
emulators/devices, plus (beta) web apps in a real browser. Release judgment belongs only to Tapp's
repository-connected deterministic gate.

## No MCP connected? Just run the CLI

The core inspect, explore, replay, and gate capabilities work as plain commands — no Tapp account,
server, or global install. `[target]` is optional: with a repository/model, Tapp selects and prepares
one conclusive web, iOS, or Android target; it also accepts a repo dir, `path/to/App.app`, bundle id,
APK plus app id, or an owned HTTP(S) URL. You never need to know an iOS bundle id up front.

```bash
npx -y @aarwitz/tapp@latest explore [target]     # autonomous exploration → findings + evidence (observation, not a gate; ≈ tapp_explore)
npx -y @aarwitz/tapp@latest focus "SCREEN OR CONTROL" [target] # source-locate + shortest observed route + screenshot
npx -y @aarwitz/tapp@latest explore https://your-app.example --watch  # web: visibly follow the same exploration
npx -y @aarwitz/tapp@latest open [target]   # launch + screen summary + screenshot saved to a file (≈ tapp_open_app)
npx -y @aarwitz/tapp@latest tree [target]   # accessibility tree, --json for every element (≈ tapp_ui_tree)
npx -y @aarwitz/tapp@latest shot            # screenshot the booted sim → file path (≈ tapp_screenshot)
npx -y @aarwitz/tapp@latest apps            # what's installed on the simulator, with bundle ids
npx -y @aarwitz/tapp@latest build [dir]     # build the app in an Xcode repo + install it (≈ tapp_build)
npx -y @aarwitz/tapp@latest explore app.apk --platform android --app-id com.acme.app
npx -y @aarwitz/tapp@latest flow run .tapp/flows/smoke.yml  # committed, keyless E2E replay
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
| "Show me / screenshot a screen" | `tapp_open_app` (launch + screenshot + tree, ~15s) | `tapp_explore` (a full multi-minute exploration) |
| "Find/reach this named screen or control" | `tapp_session_start` with `focus`, or `tapp_focus`; plain CLI: `tapp focus` | screenshot-by-screenshot wandering |
| "Tap through / drive / fill a form / log in" | `tapp_session_start` → `session_act` loop | repeated `open_app` calls (cold relaunch each time) |
| "Is my app broken? Find bugs" | `tapp_explore` — `appBundleId` for iOS, `androidAppId` for Android, `url` for owned web apps; returns an observation (findings + evidence), not a ship verdict — gate a merge with the CI gate (`tapp ci` CLI / the GitHub Action) + a contract | a manual session (exploration is autonomous) |
| "Make this flow a repeatable test" | drive it in a session, then `tapp_flow_save`; replay with `tapp_flow_run` | re-driving it by hand every time |
| "What's on screen right now?" | `tapp_screenshot` / `tapp_ui_tree` | relaunching the app |

## Session driving (the Playwright loop)

After an initial grounding exploration, use the source-connected fast path for any named
destination. Tapp searches the repository, matches the requested surface to `.tapp/ui-map.json`, and executes only the shortest
runtime-observed route. Source tells Tapp where intent lives; observed UI evidence authorizes taps.
If it returns source evidence without a route, inspect the cited file/navigation source—do not
wander blindly or invent a route. URL-only targets correctly have no source advantage.

```
tapp_session_start { appBundleId: "com.acme.app", focus: "Save storefront settings visible above keyboard", projectDir: "." }
tapp_session_start { focus: "Storefront Settings", projectDir: "." } → managed web target from the workspace
tapp_focus         { query: "Save storefront settings visible above keyboard" } → one-call shortest observed route
tapp_session_act   { action: "login", email: "qa@x.com", password: "…" } → atomic fill + submit + verify
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
   tap password → type password. For sign-in, prefer the atomic `login` action: it records a
   secret-templated replay step and avoids native secure-field refocus behavior.
5. Tap results: `ok` (landed), `not_hittable` (exists but disabled/covered — the harness
   auto-dismisses keyboards and retries), `not_found` (nothing matches — re-read the tree).
6. One session at a time. `session_start` always begins from a fresh **cold** launch
   (terminate + relaunch, for a deterministic starting screen). Persisted app data such as
   Keychain credentials survives, but the app opens on its launch screen, not a resumed
   foreground state — an app that gates each cold start behind sign-in WILL show its login
   wall, so plan `login` (or a bypass launch argument) as the first act. Plain `tapp tree` /
   `tapp screenshot` warm-resume the currently foregrounded app instead, which is why they can
   look signed-in when a fresh session does not.

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
- **Credentials at replay:** pass real values (`testEmail`/`testPassword`, CLI `--email`/
  `--password`), or name a configured actor (`actor: "coach"`, CLI `--actor coach`) and Tapp
  resolves `$TEST_EMAIL`/`$TEST_PASSWORD` from the env vars that actor binds. Actors store
  env-var **names** only — never values. `tapp actor set` refuses to overwrite an existing
  actor unless you pass `--replace`, so idempotent setup scripts must include it.
- **Generate:** `tapp_flow_generate { goal: "log in and add the first item to cart" }` —
  grounded in the app's actually-explored screens, so it can't invent steps.
- **Discover the file format without MCP:** `npx -y @aarwitz/tapp@latest flow example` prints a
  complete starter Flow; `tapp flow validate <file>` checks it without launching a target.

## Setup facts (tell the user when relevant)

- iOS runs locally on a Mac with Xcode + a simulator. Android needs `adb` and a connected
  emulator/device; source builds also need JDK 17, while prebuilt APK testing does not. Web needs
  Playwright + Chromium. `tapp doctor` reports each capability separately.
- First tool call builds the test harness once (~2 min, cached in `~/.tapp`). `tapp install`
  prebuilds it. Switching simulators triggers an automatic rebuild.
- The app under test must be **installed on the booted simulator** (`tapp_install_app` builds
  and installs from an Xcode project/workspace; or the user's normal build).
- A simulator must be booted (`tapp_list_simulators` → `tapp_boot_simulator`).
- Screenshots/captures land in `~/.tapp/captures/`.
- Driving `tapp mcp` from a raw stdio client: **consume or discard stderr** — the server logs
  progress there, and an unread stderr pipe can deadlock a naive client. The first
  `tapp_session_start` on a cold machine includes the one-time harness build, so it can take
  minutes before the first result arrives; that is startup cost, not a hang.
- Managed web targets always bind `127.0.0.1` and prefer the repository's declared or framework
  default port (vite → 5173, next → 3000). If the app's backend uses a CORS allowlist, pin the
  origin with `"web": { "port": 5173 }` in `.tapp/project.json` — an unexpected port surfaces as
  misleading fetch/CORS findings, and a busy pinned port is a hard error, never a silent
  ephemeral fallback.

## Honesty rules

- Never claim a screen/flow works without having actually driven or seen it via these tools.
- If a tool call fails twice for the same reason, stop and tell the user what's failing instead
  of retrying variations.
- When you show a screenshot as proof, say what it proves and what it doesn't ("login works;
  I haven't verified checkout").

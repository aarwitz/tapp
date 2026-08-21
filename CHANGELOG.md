# Changelog

## VS Code 0.3.2

- Keep language-model tool preparation on VS Code's stable API. Extension 0.3.1 returned the
  proposed `pastTenseMessage` field, so a real Marketplace install activated and listed its tools
  but VS Code rejected every invocation before Tapp's npm engine ran.
- Add a regression test that forbids the private preparation field. Verify the packaged extension
  in a real VS Code Extension Host by building and opening DemoApp, reading its accessibility tree,
  and returning a screenshot through the registered Tapp tools.

## 0.17.0-rc.14

**Fresh-machine-safe recovery guidance across every agent surface.**

- Make every actionable follow-up emitted by the CLI and MCP use
  `npx -y @aarwitz/tapp@latest`, including doctor, target selection, initialization, report,
  replay, baseline, and gate remediation. A user never needs a global `tapp` executable.
- Teach the skill to prefer `tapp_health` when MCP is connected and otherwise run the explicit
  npm doctor command.
- Lock the no-global-command rule across the user-facing runtime sources and ship the same updated
  skill in Claude, npm, the MCP Registry, and VS Code 0.3.1.

## 0.17.0-rc.13

**Stale-global-safe one-line invocation.**

- Use `npx -y @aarwitz/tapp@latest` throughout the Agent Skill, agent playbook, CLI guidance, and
  current public documentation. The explicit tag makes npm run the selected registry package even
  when an older globally installed `tapp` binary is already on `PATH`.
- Lock that invariant in the agent-surface suite so the short agent and human journeys cannot drift
  back to npm's ambiguous unversioned shorthand.
- Launch the Claude plugin's MCP through an exact-version `npx` package spec. Claude's npm plugin
  cache copies package contents without hydrating dependencies, so directly executing the cached
  `bin/tapp.js` could not load the MCP SDK; the same-version registry invocation is self-contained.
- Replace the stale public MCP Registry metadata (`tapp-mcp`, iOS+web, ship/no-ship) with the scoped
  package and current iOS/Android/web observe-and-gate contract.

## 0.17.0-rc.12

**Agent Skill distribution and installed-workspace correctness.**

- Ship one canonical `tapp` Agent Skill in the npm artifact and public repository, discoverable by
  the open `skills` installer and bundled into the official Claude plugin and VS Code extension.
- Make the Claude marketplace install the small versioned npm artifact, with its exact bundled MCP
  server, so “Use Tapp to test this app” needs no pasted playbook or separate MCP configuration.
- Add an MCP `test-app` prompt and keep its operation selection, ambiguous-target behavior, visual
  evidence rules, and observe-versus-gate language aligned with the skill.
- Resolve repository-facing MCP paths against the client application workspace rather than Tapp's
  installed package cache; lock the installed-package case with an external-workspace protocol test.
- Report MCP readiness per iOS, Android, and web capability instead of requiring an iOS simulator
  for every platform.
- Add web `--watch` presentation mode: an isolated controlled Chromium window shows the current
  action and pointer without contaminating evidence screenshots.
- Prepare VS Code extension 0.3.0 with the same skill, current observation contract, renamed
  `tapp_explore_ios` tool, current engine pin, zero production dependency advisories, and a public
  VSIX packaging workflow.

## 0.17.0-rc.11

**Multi-target selection and selected-run scope correction.**

- Ask which application target to initialize whenever explicit `init --explore` sees several
  plausible targets, even when `.tapp/` contains a saved default from an earlier run. A later bare
  `tapp explore` still uses that saved default.
- Scope the init summary to the target actually selected. Setup gaps belonging only to other retained
  targets are shown as informational instead of red failures of a successful selected-target run.
- Return the selected target and active/deferred requirement scope through shared CLI and MCP product
  operations so every client presents the same semantics.

## 0.17.0-rc.10

**Honest mixed-repository onboarding and first-run diagnostics.**

- Detect every plausible application target before source-connected exploration instead of silently
  choosing the first target in a repository containing multiple apps.
- Ask a human terminal user to choose from a deterministic numbered list, return structured target
  choices to MCP clients, and stop non-interactive callers safely with exact retry commands.
- Retain every detected target in the application model while recording the user's selection as the
  default for later bare exploration.
- Preserve actionable Xcode compiler errors when build output is long.
- Make `doctor` verify that Chromium is installed, and avoid duplicating contract-validation output
  when a terminal combines stdout and stderr.

## 0.17.0-rc.9

**Clean-install help correction.**

- Keep bare `tapp --help` and `tapp -h` side-effect free, matching the existing guarantee for
  nested command help: they no longer create even an empty `TAPP_HOME`.

## 0.17.0-rc.8

**Adversarial qualification corrections.**

- Preserve and report iOS process termination before recovery can hide an in-run navigation crash.
- Treat destinations containing only system navigation chrome as blank content surfaces.
- Keep iOS persistence findings and completion issue counts consistent.
- Recognize short-lived Android Activity transitions so a working control is not called dead.
- Wait for the first Android frame to composite before retaining screenshot evidence.
- Make nested `tapp ci install --help` side-effect free.
- Remove the last shipped `AUTOTAP_*` runtime fallback.

## 0.17.0-rc.7

**Observe/judge split (ADR-0005) — a breaking rename + gate-contract change.**

- **`qa` → `explore`.** The exploration verb is now `explore` (`qa` stays a hidden alias). The MCP
  tool `tapp_run_qa` is renamed `tapp_explore` (old name retained as a dispatch alias).
- **Exploration is scoreless.** `explore` returns an *observation* (`kind: "tapp-exploration-run"` —
  findings each with an `authority` tag, coverage, `inconclusive`), never a ship verdict, release
  score, or confidence. The retired `ready/caution/blocked` + `SHIP-READY` + 0–100 score are gone.
- **The gate renders the outcome.** The deterministic gate returns `pass | fail | inconclusive` with
  exact exit codes — `pass` 0 · `fail` 1 · usage/infra `error` 2 · `inconclusive` 3 (fails closed;
  precedence `fail > inconclusive > pass`). It applies versioned policy to deterministic finding
  counts + coverage + selected Flows/Scenarios/contracts + (when available) a target-scoped baseline;
  it no longer consumes a score. GitHub Action output renamed `verdict` → `outcome`.
- **Structural evidence authority.** A suite whose only issue is a model assertion (`assert_ai`) is
  `inconclusive` (blocks, fails closed) — never a silent pass, never a fake deterministic fail.
- **Source-preparing bare `explore`.** A bare `explore` in an initialized repo resolves the model's
  default target and prepares it from source before exploring: a web target's recorded owned URL is
  explored directly; a Tapp-managed web target is built/started, waited for, and always stopped; an
  iOS target is built + installed on the simulator; an Android target is built to an APK + installed.
  `--platform`/`--target` narrow the selection. It stays an observation — no verdict, no UI-Map write.
- **`--fail-on blocked` → `--fail-on absolute`.** The gate policy value is renamed (`gate` default,
  `absolute`, `any`).
- **`tapp_flow_generate` is a proposal.** Generated Flows land under `.tapp/proposals/flows/` as
  untrusted drafts; they must be replayed on a real target and explicitly promoted before use.
- **Help is a Core → Primitives → Advanced hierarchy.** `tapp help` leads with `explore`, `contract`,
  `ci` (Core), then `open`/`tree` (Primitives), then repository/lifecycle/compiler verbs (Advanced).
- **Retired pre-rename compatibility (breaking).** The `.autotap`/`.autotap.yml` read path, all
  `AUTOTAP_*` environment variables, and the `runtapp/contracts` + `tapp-mcp/contracts` authoring
  specifiers are removed. The only supported names are `.tapp`/`.tapp.yml`/`TAPP_*`/`@aarwitz/tapp/contracts`.
- **Publication guard.** `tools/sync-public.sh --check` stages the public tree and verifies it
  (client-sensitive strings, relative doc links, npm package contents, clean tarball install)
  without pushing; the same battery runs before every real sync.
- **Safe `--help`.** `--help` on any verb prints the reference and writes nothing — not even
  `TAPP_HOME` (previously `init --help` created artifacts).

## 0.16.5

- **Scoreless exploratory web QA:** web reports concrete coverage, deterministic verdict findings,
  and advisory sampled probes instead of a 0–100 scalar that implied broader measurement than the
  crawl performs. A clean scoped result is `AUTOMATED CHECKS COMPLETE`, never `SHIP-READY`.
- **Stable verdict basis:** budget-capped dead-control probes remain visible but cannot move the web
  verdict; exhaustive checks on each exercised page drive it. CI now runs the same live browser
  fixture twice and requires identical finding identities, evaluation tiers, counts, and verdict.
- **Honest business-claim boundary:** contract guidance documents the supported deterministic
  verifier-endpoint pattern and explicitly states that arbitrary/cross-origin JSON response
  assertions are not yet part of the contract DSL.

## 0.16.4

- **Trust-scoped web verdicts:** a clean web crawl is labeled `AUTOMATED CHECKS PASSED` instead of
  `SHIP-READY`, and reports explicitly disclose that claim accuracy, API privacy/data minimization,
  brand/SEO consistency, and subjective visual credibility were not checked.
- **Deterministic placeholder-link coverage:** visible links with `href="#"` (including primary
  download CTAs) are findings, while links advertising real JavaScript action semantics are
  exempted and shared footer findings deduplicate across routes.
- **Stable dead-control results:** control-local semantic state and actual event wiring replace the
  page-wide mutation counter, so unrelated timers, carousels, and chat widgets cannot randomly hide
  an inert button. Navigation-aborted media requests are no longer reported as broken resources,
  and terse or media-only pages are no longer mislabeled as blank.

## 0.16.3

- **Trustworthy web findings:** error-surface detection now distinguishes standalone failures from
  help copy, broken assets deduplicate across routes, and covered/failed clicks are no longer
  misreported as dead buttons.
- **Settled focused evidence:** web `open` and `tree` wait for loading states and support
  `--tap TEXT` plus `--wait-for TEXT`, allowing package-only agents to dismiss one blocker and
  capture the resulting async screen without MCP.
- **CLI-native follow-up:** package QA reports now point to `tapp report`, `--baseline`, and
  committed Flow replay instead of suggesting MCP-only calls.

## 0.16.2
- **CLI-first diagnostics:** `tapp doctor` now sends a ready user directly to the package-only
  `open` and `qa` workflow instead of presenting MCP setup as the next step.

## 0.16.1
- **Agent-first package onboarding:** the npm README and CLI help now lead with the coding-agent
  `open` → inspect the saved image → `qa` workflow used by Claude Code and Codex CLI. The browser
  Release Studio remains optional rather than defining the package quickstart.
- **Focused web evidence:** `tapp open <url> --platform web` now writes a real browser screenshot
  and semantic control summary; `tapp tree <url> --platform web --json` exposes the same focused
  page structure without starting a QA crawl.
- **Manual agent acceptance:** the release checklist now tests natural-language agent prompts,
  actual screenshot inspection, exact verdict reporting, and healthy/seeded-failure replay.

## 0.16.0
- **Canonical repository namespace:** Tapp now creates and documents `.tapp/`, `.tapp.yml`, and
  `TAPP_*` variables across the CLI, MCP server, desktop app, Action, demos, and hosted runner.
- **Safe migration:** existing `.autotap/`, `.autotap.yml`, `AUTOTAP_*`, and desktop Keychain data
  remain readable as legacy fallbacks; canonical Tapp names always win when both exist.
- **Owned application identifiers:** desktop and corpus identifiers now use the
  `io.github.aarwitz.tapp` namespace instead of an unowned reverse-DNS name.

## 0.15.1
- **Clean public Tapp surface:** current package metadata, CLI help, MCP manifests, shipped docs,
  Action labels, and examples use Tapp without exposing superseded package or internal desktop
  branding.
- **Tapp-first runtime configuration:** `TAPP_*` names drive package and Action behavior. Legacy
  aliases remain read-only compatibility inputs rather than the documented interface.
- **Smaller npm artifact:** only runtime-required scripts ship in the package; desktop development,
  evaluation, mutation, and corpus utilities remain in the private source repository.
- **Compatibility preserved:** existing `.autotap` repositories and legacy release-contract import
  specifiers remain readable. Their eventual migration is separate from this public-surface patch.

## 0.15.0
- **Tapp is Tapp everywhere:** the canonical npm distribution is now `@aarwitz/tapp`, while the
  installed command remains `tapp` and MCP tools remain `tapp_*`. The scope distinguishes the npm
  address without creating a second product name.
- **Non-breaking package transition:** release contracts now author against
  `@aarwitz/tapp/contracts`; existing `runtapp/contracts` and `tapp-mcp/contracts` imports continue
  to compile. The old npm names remain deprecated compatibility paths.
- **Distribution surfaces updated together:** CLI guidance, MCP and Claude manifests, package
  badges, examples, landing page, agent playbook, and VS Code engine pin resolve the scoped package.

## 0.14.0
- **Canonical npm package renamed to `runtapp`:** the product remains Tapp, the installed binary
  remains `tapp`, and MCP tools remain `tapp_*`. Existing `tapp-mcp` commands continue through a
  deprecated compatibility release.
- **Release-contract compatibility:** new contracts import `runtapp/contracts`; existing
  `tapp-mcp/contracts` imports continue to compile.
- **Distribution surfaces updated together:** CLI guidance, MCP/Claude manifests, landing page,
  agent playbook, and VS Code engine pin now resolve `runtapp`.

- **Symbol-precise PR ownership:** GitHub change manifests now retain bounded patch/rename evidence,
  local `--pr-base` derives equivalent zero-context diff evidence without a shell, and reviewed
  Task `coverage.sourceSymbols` narrows affected Tasks when every hunk is attributable. Plans expose
  symbol identities and attribution counts but no source hunks; missing or ambiguous evidence falls
  back to file ownership. The real commerce label-change regression now affects only
  `completeCheckout`, not the unrelated order-history Task.
- **Constrained PR Task maintenance:** a failed diff-selected contract can now produce one
  Task-only selector patch when its failed action, affected Task, baseline UI Map, and
  current UI Map all retain the same non-label control identity. The report pins Task/contract
  digests, exact pointer and before/after values, never auto-applies, and keeps the gate red. Web
  gates compile the patch from a temporary Task registry and replay the unchanged contract against
  the still-running real target; passing proof is marked `validated-awaiting-review` with evidence
  while the source Task and contract remain byte-identical. A real commerce label rename passed this
  disposable replay and after review, while the behavioral missing-order fault remained
  unclassified and produced no selector patch.
- **Grounded durable-order planning:** when reviewed Tasks expose an exact representative checkout
  output and a separate order-history path, controlled lifecycle and observed UI Map states let
  `tapp init` propose a critical persistence contract. Single-actor web contracts now execute
  same-origin reset/cleanup as evidence. CommerceDemo passes 16/16 clean steps; its missing-order
  fault leaves generic QA at 100/100 but fails the unchanged contract and blocks the gate.
- **First-class actor onboarding:** `tapp actor set|list` and MCP `tapp_actor_config` maintain a
  central `.tapp/project.json` of roles, isolated sessions, provisioning, lifecycle, and
  credential environment-variable names. Init blocks missing/conflicting bindings, generated
  contracts reuse them, and CI maps every actor binding to a same-named GitHub Secret without
  persisting values.
- **Grounded multi-user planning:** when a contract-free web repository has two compatible
  isolated actors, deterministic reset lifecycle, an authentication Task, and a content-producing
  Task with an exact captured output, `tapp init` proposes one compositional cross-account
  propagation contract instead of duplicated one-Task tests. Review, compilation, replay,
  promotion, and seeded-fault merge blocking are covered on a real shared-state browser fixture;
  CLI/MCP draft validation can manage the detected web target when no URL is supplied.
- **Baseline-to-CI onboarding:** `tapp baseline create` runs or imports only a successful conclusive
  full gate, writes an atomic platform/target-specific baseline, and rejects cross-target
  comparisons. `tapp ci install` and MCP `tapp_ci_setup` render/write a collision-safe per-target
  GitHub workflow plus `.tapp/ci.json` without commits or remote mutation.
- **Managed browser CI:** the Action/portable gate now share init's deterministic web
  install/build/start/readiness/teardown path when no URL is supplied. Fixed ports declared by
  repository scripts are honored, ephemeral import URLs are not persisted, and tests cover both
  regressions.
- **Target-isolated Action baselines:** automatic cache and durable artifact identities include the
  stable application-model target key, preventing two same-platform apps from sharing history.
- **Turnkey import loop:** `tapp init --explore` and MCP `tapp_init:explore` now build/start or
  connect to a real target, run the ordinary keyless QA engine, merge its evidence-grounded UI Map,
  persist conclusive run provenance, and construct the application model/release plan. Detected web
  package scripts and static sites run on an isolated loopback port and are always torn down.
- **Generated release infrastructure:** approved UI-Map journeys become deduplicated compositional
  Task drafts plus TypeScript contract drafts; `tapp plan validate` replays them without AI and
  records per-platform trust, while `tapp plan promote` explicitly moves only fully validated
  artifacts into canonical reviewed directories and updates map coverage.
- **Safe evolution:** a real re-exploration invalidates prior draft trust without discarding history;
  source-only refresh preserves proof; promoted proposal lineage reconciles to the committed
  contract without duplicates; empty/login-wall maps remain blocking and no lockfile/install command
  is invented.
- **UI Map navigation provenance:** maps now preserve per-platform entry states and transition
  platforms, enabling deterministic path-to-Task generation behind the shared schema.
- **Android end to end:** native ADB/UIAutomator exploration, screenshots, semantic sessions,
  committed Flow replay, foreground/crash checks, evidence reports, and the shared CI gate.
- **Cross-platform Flow runtime:** one repository-native YAML format now replays without AI on
  XCUITest, Android, and Playwright; the CLI adds `tapp flow run|validate`.
- **Corpus proof:** three native Android fixtures (onboarding, login, and checkout) include
  committed Flows and a real-emulator CI sweep.
- **Three-platform GitHub Action:** iOS, Android, and web inputs, platform-isolated automatic
  baselines/evidence, APK builds, and web runtime setup.
- **Productized GitHub gate:** automatic default-branch baselines use a fast Actions cache
  plus a 90-day artifact fallback; committed and explicit baselines remain authoritative.
- **Lower-friction setup:** the gate detects the bundle id from a simulator `.app`, exposes
  the exploration timeout, and documents a complete PR + main-branch workflow.
- **CI trust hardening:** every run gets an isolated capture directory, malformed config and
  missing baseline/Flow inputs fail before simulator work, and missing `ffmpeg` no longer
  discards otherwise-valid evidence.
- **Human evidence:** CI capture bundles now include the existing browsable `report.html`
  alongside the recording, screenshots, Markdown, and machine-readable JSON.
- **Contract tests:** process-level coverage now pins gate exit codes, report artifacts,
  baseline warnings, Flow failures, and cheap preflight validation.

## 0.13.1
- **Release hardening:** production dependencies updated to clear published security
  advisories; the GitHub Action now passes inputs through environment variables rather
  than interpolating them into shell source, and nested Actions are pinned to commit SHAs.
- **Action safety tests:** CI now prevents shell-source input interpolation and moving
  third-party Action tags from returning.
- **VS Code launch pairing:** extension 0.2.5 pins this engine release so the Marketplace
  experience and `npx tapp-mcp` ship against the same tool contract.

## 0.13.0
- **Finding identity**: findings now carry a `target` (control identifier) and dedup/regression
  match on `type|screen|target` — fixing one dead button while breaking another on the same
  screen is now correctly a new regression, not "persisting." Old baselines without targets
  match coarsely, so upgrading never sprays false failures.
- **Remote AI is opt-in**: post-run finding enrichment requires `TAPP_ENABLE_REMOTE_AI=1`
  (or a tapp subscription token). An ambient `ANTHROPIC_API_KEY` no longer silently enables
  remote calls. Privacy claims in README/SECURITY.md rewritten to be precise.
- **Honest labels are run-aware**: `checkedFor` is platform-specific (web runs no longer
  claim iOS keyboard checks), "failed sign-ins" is only claimed when a sign-in surface was
  encountered, and a new `conditionsNotReached` lists what never came up.
- **Web explorer**: sign-in failure is reported whenever the login form survives a submit
  (no longer coupled to unrelated detectors); dead-button detection watches DOM mutations,
  dialogs, network activity, and navigation instead of `innerHTML.length`.
- **CI**: the iOS harness build now gates merges (was informational); unit tests run on a
  Node 18/20/22 matrix; third-party actions pinned to commit SHAs.
- Fixed a path-boundary check that accepted sibling directories sharing a prefix.
- Public sync commits now carry the source commit subject; CHANGELOG.md added.

## 0.12.x
- `0.12.2` — tapp tests itself: unit/protocol/CLI test suite + CI on every push; displays say
  "release score" (heuristic, not calibrated confidence; `releaseScore` added to JSON);
  "adaptive exploration, deterministic judgment" wording; `os: darwin` restriction removed
  (web beta installs anywhere); CONTRIBUTING.md + SECURITY.md.
- `0.12.1` — nameless chat composers (SwiftUI overlay-placeholder pattern), textView support
  everywhere, immediate session acks (no phantom timeouts), 2h session timeout.
- `0.12.0` — interactive mid-run input: exploration pauses at input screens and asks the
  host (desktop app / VS Code extension), with remembered values so known answers never
  pause again.

## 0.11.x
- `0.11.5` — one-call `login` session action (return-key submit, save-password sheet
  auto-declined, on-screen auth errors surfaced); simulator builds signed again
  (`CODE_SIGNING_ALLOWED=NO` had produced apps with no keychain entitlement — Firebase Auth
  failed on real apps).
- `0.11.4` — typing always replaces field contents (agent retries no longer append);
  length-preserving masked dots for secure values.
- `0.11.3` — secure-field targeting (placeholder matching, password semantics), `typedInto`
  feedback, field values in the accessibility tree, harness cache invalidates on package
  updates.
- `0.11.1` — surfaced the exploration recording; per-client screenshot guidance.
- `0.11.0` — target auto-resolution: `tapp qa` with no arguments finds and builds the Xcode
  project (or takes a repo dir / `.app` path / bundle id); `tapp apps` + `tapp build`;
  `tapp_build` MCP tool builds the user's app.

## 0.10.0
- Zero-config CLI verbs (`qa` / `open` / `tree` / `shot`) on the shared engine; engine
  module import-safe; bundle-id pre-flight with actionable errors.

## 0.9.0 and earlier
- `0.9.0` — `tapp ci` fixed from the installed package; guaranteed tab sweep; launch-crash
  detection under crash-loop throttle; mutation-recall benchmark tooling open-sourced.
- `0.8.0` — web (beta) driver: Playwright crawler emitting the same marker protocol.
- `0.7.0` — first public release: MCP server + CLI, generic XCUITest harness, ship/no-ship
  verdict, Flows.

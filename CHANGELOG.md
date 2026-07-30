# Changelog

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

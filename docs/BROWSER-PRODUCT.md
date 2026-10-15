# Browser Studio

Status: current product contract as of 2026-10-15 (ADR-0006, owner decision). Supersedes the
"desktop-parity Command Center" framing of 2026-10-14.

The Studio in `browser/` is the one browser surface. It is a **run viewer**: point Tapp at a
repository target or a website, watch the run live, open its evidence. It never scores or judges
a run — only the deterministic gate decides — and it never re-renders evidence: every run opens
the `report.html` the engine wrote into the capture. The hosted control plane (`saas/`, frozen)
embeds these same assets at build time.

## Start locally

```bash
npx -y @aarwitz/tapp@latest app /path/to/repo   # a repository on this machine
npx -y @aarwitz/tapp@latest app                 # no repository: website audits only
```

Tapp prints an authenticated one-time launch URL and opens it in the default browser (`--no-open`
to copy it by hand, `--port 4317` for a fixed loopback port). A repository is opened from the
machine the Studio runs on; the Studio does not upload or clone source. Everything runs on this
machine with its own toolchain (Xcode for iOS, JDK/SDK + `adb` for Android, Playwright Chromium
for web), which must stay open while a run is in progress.

## What is on the page

| View | What it shows | Operations |
|---|---|---|
| Overview | The detected targets (an explicit choice when there are several), the live device feed, "tapp chat" (the engine's own progress log — nothing is generated after the fact), the current decision from the last gate, the latest evidence | `initialize` (inspect, then build + explore), live session `start / act / save-flow / end`, release check |
| Runs | Every run on this repository and every read-only website audit, newest first; each opens its evidence page. A URL field runs an audit from here. | `gate`, `audit` |

A **website audit** is `explore --read-only`: up to six same-origin pages are rendered and read —
dead controls, broken images/assets/links, failed requests, JS exceptions, mixed content,
horizontal overflow — and nothing is clicked, typed, submitted or hovered, so it is safe on
production or a site you do not own. A website has no source revision, so it has no release
verdict; the audit says what it checked and what it could not (its detectors were qualified on 25
real small-business sites in October 2026; the remaining findings were verified by hand).

## What was removed, and where it lives instead

The Contracts, Coverage and Settings views, the six-step journey stepper, and the folder-upload,
GitHub-clone and remote-runner onboarding were removed on 2026-10-15. Reviewing and promoting
contracts is `tapp plan` / `tapp validate` in the repository; coverage is on every run's
`report.html`; actors and credentials live in `.tapp/project.json`; CI installation is `tapp ci`.
The Studio keeps only what a browser does better than a terminal: watching a real device while a
run happens, driving it by hand, and reading evidence.

## Verified reference journey

`tests/browser-journey.test.js` drives the CommerceDemo fixture end to end in a real browser:
target choice, exploration, a live session that records a Flow, the gate, and the runs list.
`tests/browser-onboarding.test.js` covers the no-repository start and a read-only website audit;
`tests/browser-product.test.js` covers authentication, CSRF, the audit operation and the removed
endpoints answering 404.

## Hosted relationship

`saas/` serves the same `browser/` assets through `/api/studio` with an API base and login URL
injected. It is frozen at its current commit (ADR-0006, owner decision) and will embed the
simplified Studio when it is next deployed. Nothing in the Studio depends on it.

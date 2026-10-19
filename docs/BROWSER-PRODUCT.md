# Browser Studio

Status: current product contract as of 2026-10-19 (ADR-0006, owner decision, amended). Supersedes
the "desktop-parity Command Center" framing of 2026-10-14.

The Studio in `browser/` is the one browser surface. It is a **run viewer**: point Tapp at a
repository target or a website, watch the run live, open its evidence. It never scores or judges
a run — only the deterministic gate decides — and it never re-renders evidence: every run opens
the `report.html` the engine wrote into the capture. The hosted control plane (`saas/`, frozen)
embeds these same assets at build time.

## Start locally

```bash
npx -y @aarwitz/tapp@latest app                 # opens on the prompt
npx -y @aarwitz/tapp@latest app /path/to/repo   # opens straight onto that repository
```

Tapp prints an authenticated one-time launch URL and opens it in the default browser (`--no-open`
to copy it by hand, `--port 4317` for a fixed loopback port). Everything runs on this machine
with its own toolchain (Xcode for iOS, JDK/SDK + `adb` for Android, Playwright Chromium for
web), which must stay open while a run is in progress. Nothing is uploaded anywhere.

## The prompt

With nothing open, the Studio shows one field — **What should tapp test?** — above a short
looping animation of a device being driven (launch, tap, tap, screenshot, ✓). It accepts:

| You type | What happens |
|---|---|
| `https://example.com` (or `example.com`) | A read-only website audit; the stage takes a browser's shape. |
| `~/code/my-app`, `/path/to/repo` | That folder becomes the project: targets are detected, nothing builds until one is chosen. Local Studio only. |
| `owner/repo`, `github.com/owner/repo` | Cloned with `gh` into an isolated workspace under `TAPP_HOME`, then the same. |
| `com.company.app` | Explored on the booted iOS simulator as it is (no build). |
| `/path/to/Demo.app`, `~/Downloads/app.apk` | Installed on the booted simulator / connected device, then explored. |
| a business name | Answered honestly: nothing discovers surfaces from a name yet; paste its URL. |

The server classifies the input again (`classifyPrompt` in `browser/view-model.js` is shared) and
refuses what the mode cannot do: a hosted Studio cannot open a path or a build on your machine.

## What is on the page

| View | What it shows | Operations |
|---|---|---|
| Overview | The **stage**: the device as large as the window allows, in its platform's aspect ratio (phone portrait for iOS and Android, browser landscape for web), showing the live frame or the newest screenshot the run wrote. The **chat** floats over its corner on a translucent ground, collapses to a pill, and narrates the engine's own progress log one emoji-led line at a time (👆 Tapped, ⌨️ Typed, 🔐 Signed in, 📍 Opened, 🧭 Reached, 📸 screenshots inline), then attaches the recording and `report.html` and ends with a pill — `✓ Ready to merge`, `× Do not merge`, `◐ Inconclusive`, or for an exploration its counts — and the headline. Nothing is generated after the fact and nothing is a score. Below the stage: the detected targets (an explicit choice when there are several), the live-session controls, and the current decision from the last gate. | `open`, `initialize` (inspect, then build + explore), `explore-build`, live session `start / act / save-flow / end`, release check |
| Runs | Every run on this repository, every exploration started from the prompt, and every read-only website audit, newest first; each opens its evidence page. A URL field runs an audit from here. | `gate`, `audit` |

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
endpoints answering 404. `tests/browser-chat-narration.test.js` covers prompt classification and
the chat's narration and summary without a browser.

## Hosted relationship

`saas/` serves the same `browser/` assets through `/api/studio` with an API base and login URL
injected. It is frozen at its current commit (ADR-0006, owner decision) and will embed the
simplified Studio when it is next deployed. Nothing in the Studio depends on it.

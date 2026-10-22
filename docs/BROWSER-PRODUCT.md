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

A **website audit** is `explore --read-only`: up to twenty same-origin pages (twelve by default) are rendered and read —
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

## Accounts on a public Studio

A public Studio (`tapp app --public`) has three kinds of person, and the boundary between them is
an allowlist in `browser-product.js` (`anonymousAllows`, `accountAllows`):

| | Visitor | Account | Operator |
|---|---|---|---|
| Who | Anyone who opens the page | Signed in with an email link | The machine's owner (`tapp app` launch URL) |
| May | Audit a public website read-only; see their own audits | Everything a visitor may, plus: explore a website for real (it stops at a sign-in and **asks** in the chat), answer the ask, and see / forget the **test accounts** tapp holds for them | Everything, including repositories, live sessions and the gate |
| Evidence | Captures stamped with their visitor cookie | Captures stamped `acct:<id>` | All captures on the machine |
| Test accounts | None — a visitor is never asked | Encrypted, per account: `TAPP_HOME/accounts/actors/<id>/` | `TAPP_HOME/actors/` |

**Signing in** is `POST /api/auth/link` with an email, then `GET /auth/<token>` from the email.
There is no password. Links work once and expire in 15 minutes; sessions last 90 days; only the
SHA-256 of either token is on disk (`account-store.js`). One address may ask for five links per
ten minutes, and the reply is the same whether or not the address has an account.

**Cloudflare Access instead of mail.** When the host is fronted by Cloudflare, put an Access
application on exactly `app.runtapp.com/auth/cloudflare` (policy: allow everyone; login method:
one-time PIN or Google) and set `TAPP_ACCESS_TEAM_DOMAIN` (`<team>.cloudflareaccess.com`) and
`TAPP_ACCESS_AUD` (the application's audience tag). *Sign in* then goes to Cloudflare, which
proves the address itself and returns with a signed assertion (`Cf-Access-Jwt-Assertion`);
`access-jwt.js` checks the RS256 signature against the team's published keys, the audience, the
issuer and the expiry, and opens the same session the link flow would. tapp sends no email.
`/api/session.signInProvider` tells the Studio which of the two to offer.

**Mail** is sent through Resend when `TAPP_MAIL_RESEND_KEY` and `TAPP_MAIL_FROM` are set
(`mailer.js`). Without them, each message is written as a 0600 `.eml` into `TAPP_MAIL_OUTBOX`
(default `TAPP_HOME/mail-outbox`) — what tests and a local trial use, and what a freshly deployed
host does before a provider is configured. A link is never printed to a log.

**What an account's test accounts look like.** The Runs view lists them by application: the
actor's name, whether a password is held, and whether a signed-in session is held and since when.
Never a value. *Forget* removes one; tapp asks again next time. This is the CI-secrets model —
write-only from the UI, encrypted at rest, decrypted only inside the run that signs in with it.

A local trial of the public mode (`--origin http://127.0.0.1:PORT`) does not pin browser egress
to public addresses, so it can reach a site on the same machine; a real origin always does.

## Journeys: keeping a proven run

A run that got somewhere is offered in the chat as a journey (`journeys.js`). Keeping it writes a
Flow in the runner's vocabulary — `wait_for` each screen, `tap` each control and navigation link,
`login: $TEST_EMAIL / $TEST_PASSWORD` for a sign-in, `assert_screen` on the last screen — to the
place this person owns:

| Who | Where | Replayed by |
|---|---|---|
| Operator with a repository open | `<repo>/.tapp/flows/<slug>.yml` | the Studio, `tapp run`, `tapp ci` |
| Account on a public Studio | `TAPP_HOME/accounts/journeys/<id>/<slug>.yml` | the Studio |
| Operator without a repository | `TAPP_HOME/journeys/<slug>.yml` | the Studio |

The last replay's result sits beside it in `.status/<slug>.json` and shows in the Journeys panel
as *passing · 2h ago*, *failing* or *never run*. A replay resolves `$TEST_EMAIL`/`$TEST_PASSWORD`
from the encrypted actor store for the journey's `actor` (never from the file) and, for a journey
kept from a run that started signed in, opens the browser from that actor's saved session.

Endpoints: `POST /api/captures/:id/keep` (`{ name, actor, replace, preview }` — `preview` names
the journey and lists its screens without keeping it), `GET /api/journeys`,
`DELETE /api/journeys/:slug` (kept journeys only; committed flows are the repository's),
`POST /api/operations/run-flow` (`{ name }`).

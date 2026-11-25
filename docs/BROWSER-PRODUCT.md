# Browser Studio

Status: current product contract as of 2026-11-20 (ADR-0006, owner decision, amended three
times: 2026-10-19; TM-794 on 2026-11-15 bringing Findings and Coverage back; and ADR-0011 on
2026-11-20 making the hosted first page the front door). Supersedes the "desktop-parity Command
Center" framing of 2026-10-14.

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
| a business name | Apple's catalog is searched for the publisher; each match offers **Map** (its website's surfaces — stores, channels, handles — ADR-0013) and **Audit** (the website, read-only). The App Store link opens the listing. |

The server classifies the input again (`classifyPrompt` in `browser/view-model.js` is shared) and
refuses what the mode cannot do: a hosted Studio cannot open a path or a build on your machine.

**On a hosted Studio the page is the front door (ADR-0011).** The box takes a public website. A
self-host card under it names everything else — repositories, iOS and Android builds, macOS apps,
staging and localhost — with the command that opens this same Studio on the person's machine, and
the examples the deployment cannot start are not offered. Typing one anyway still gets the
structured `self-host` answer in the chat (ADR-0010). The platform chips are the same in both
modes; on a laptop most of them say "ready".

## What is on the page

| View | What it shows | Operations |
|---|---|---|
| Overview | The **stage**: the device as large as the window allows, in its platform's aspect ratio (phone portrait for iOS and Android, browser landscape for web), showing the live frame or the newest screenshot the run wrote. The **chat** floats over its corner on a translucent ground, collapses to a pill, and narrates the engine's own progress log one emoji-led line at a time (👆 Tapped, ⌨️ Typed, 🔐 Signed in, 📍 Opened, 🧭 Reached, 📸 screenshots inline), then attaches the recording and `report.html` and ends with a pill — `✓ Ready to merge`, `× Do not merge`, `◐ Inconclusive`, or for an exploration its counts — and the headline. Nothing is generated after the fact and nothing is a score. Below the stage: the detected targets (an explicit choice when there are several), the live-session controls, and the current decision from the last gate. | `open`, `initialize` (inspect, then build + explore), `explore-build`, live session `start / act / save-flow / end`, release check |
| Runs | Every run on this repository, every exploration started from the prompt, and every read-only website audit, newest first; each opens its evidence page. A URL field runs an audit from here. | `gate`, `audit` |
| Findings | What the selected run reported, **grouped by kind** and worst first: one row per kind with the count of places it covers (`Hard to read · 34 · 4 screens`), opening onto every individual place. The engine's identity for a finding is `type|screen|target`, so one site-wide problem arrives as dozens of lines and buries the two worth fixing; grouping is a reading aid in the view and drops nothing — every finding is inside exactly one group. A read-only audit's two kinds stay apart, as the engine draws them: **Broken** (structural defects) and **Worth a look** (not broken; what a person would notice). Never a verdict. | — |
| Coverage | The screens the selected run reached, in columns by distance from the screen it started on, each a card with the still the run wrote and the actions that led on from it (`tap "Pricing" → Pricing`). Built from the `ui-map.json` the engine writes into every capture: `nodes` are screens, `edges` the recorded transitions. Only recorded transitions are drawn — a screen reached with no recorded way in gets its own column and says so, and a run with no transitions at all (a read-only audit clicks nothing) is a plain grid of what it opened, with the reason stated. | — |

A **website audit** is `explore --read-only`: up to twenty same-origin pages (twelve by default) are rendered and read —
dead controls, broken images/assets/links, failed requests, JS exceptions, mixed content,
horizontal overflow — and nothing is clicked, typed, submitted or hovered, so it is safe on
production or a site you do not own. A website has no source revision, so it has no release
verdict; the audit says what it checked and what it could not (its detectors were qualified on 25
real small-business sites in October 2026; the remaining findings were verified by hand).

## What was removed, and where it lives instead

The Contracts and Settings views, the six-step journey stepper, and the folder-upload,
GitHub-clone and remote-runner onboarding were removed on 2026-10-15. Reviewing and promoting
contracts is `tapp plan` / `tapp validate` in the repository; actors and credentials live in
`.tapp/project.json`; CI installation is `tapp ci`. The Studio keeps only what a browser does
better than a terminal: watching a real device while a run happens, driving it by hand, and
reading evidence.

**Findings and Coverage came back on 2026-11-15** (TM-794, owner decision). They were removed in
the same pass on the argument that `report.html` already carried them. It carries the findings —
as the same flat list, which is the problem — and it never carried the map at all: the engine has
written `ui-map.json` into every capture throughout, and nothing drew it. Reading a run is a thing
a browser does better than a terminal, so it belongs to the same rule as the rest of the Studio.
Neither view computes anything: Findings groups what the engine reported, Coverage arranges the
map it wrote. Neither judges — only the gate does.

## Verified reference journey

`tests/browser-journey.test.js` drives the CommerceDemo fixture end to end in a real browser:
target choice, exploration, a live session that records a Flow, the gate, and the runs list.
`tests/browser-onboarding.test.js` covers the no-repository start and a read-only website audit;
`tests/browser-product.test.js` covers authentication, CSRF, the audit operation and the removed
endpoints answering 404. `tests/browser-chat-narration.test.js` covers prompt classification and
the chat's narration and summary without a browser, and
`tests/browser-run-reading.test.js` covers finding groups and the coverage graph the same way —
the browser journey then drives both views against a real run.

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

**The cloud beyond the visitor audit is for an account on a plan or in its free trial (ADR-0011
§3).** A new account starts a 14-day trial (`plan` on the account record; `account-store.js`
`entitlement`); an account from before plans existed gets its trial from the day it is next seen.
Starting a cloud run — `POST /api/operations/explore`, `/api/operations/run-flow`,
`/api/journeys`, `/api/captures/<id>/keep` — answers **402** with the reason once the trial has
lapsed, and the daily checks skip that account's journeys; reading what the account owns stays
open, so it can still see and forget its journeys, test accounts and tokens. The deployment's
owner (`TAPP_ADMIN_EMAILS`) is never gated and marks an account paid or extends its trial from the
Admin view (`POST /api/admin/plan`). There is no payment step yet: "paid" is the owner's word.
Nothing a local Studio does needs an account.

**A brand map (ADR-0013).** `POST /api/operations/brand {url}` — allowed to a visitor like the
audit — reads the website's homepage (pinned to public addresses on a hosted Studio, `publicGet`;
plain on the person's own machine), takes every surface it claims (`rel="me"`, schema.org
`sameAs`, then links; explicit claims first, once each: App Store and Google Play listings,
YouTube, X, TikTok, Instagram, Facebook, Threads, LinkedIn, Google Business), and checks each
the way it allows (`mcp-server/src/surfaces.js`): Apple's public catalog, Google Play's and
YouTube's public pages, whatever a visitor is shown elsewhere; `not-checked` with the reason when
a platform shows the page only to signed-in users (X, without even asking). Four statuses, each
with a sentence: `ok`, `warning`, `not-checked`, `unreachable`. The Overview shows the **Brand**
panel — one row per surface with its status, note and link, *Audit the website read-only* and
*Map again* — and the chat narrates each surface as it is checked; after a URL audit the panel
offers to map the rest of the brand. An owner's map is kept under `TAPP_HOME/brands/`; a
visitor's is not. tapp never signs in to a social account.

Each kind of surface has one small adapter (`SURFACE_CHECKERS` in `surfaces.js`), and what an
adapter can see is set by the platform: YouTube has an official, free, read-only API for public
data, so with `TAPP_YOUTUBE_API_KEY` set (a Google Cloud API key with the YouTube Data API v3
enabled; `/etc/tapp-demo.env` on the hosted Studio) a channel is read through it — title,
subscribers unless hidden, video count, last upload, whether the description links back — and
through the public page otherwise, which YouTube often does not show to a visitor. The key goes
to Google and nowhere else; it is scrubbed from any sentence an error could carry. Meta's API
needs the business's own login and an app review, X's is paid, TikTok's is research-only: those
rows stay "not checked" with the reason until there is an honest way.

**Driven from app.runtapp.com (ADR-0011 §2/§4, join B).** `tapp app --connect` starts the runtime
on this machine and opens the hosted page with `#connect=<loopback origin>&token=<launch secret>`
— a fragment, so the hosted server never sees it. The page keeps the pair in this browser only
(`localStorage`, `tapp.connect`), takes it off the address bar, and from then on every `/api/*`
call goes to that origin with `Authorization: Bearer <secret>`; images and reports carry
`?token=` because an `<img>` cannot send a header. The runtime, started with `connectOrigin`,
answers CORS for exactly that origin (`Access-Control-Allow-Origin`, the preflight with
`Access-Control-Allow-Private-Network: true` for Chrome's local-network check), accepts the
bearer or the query token as the operator, still requires the CSRF token on mutations, and tells
every other origin nothing. The hosted page's CSP allows `http://127.0.0.1:*` and
`http://localhost:*` for `connect-src`, `img-src` and `media-src`; a local Studio's does not.
**Chrome asks once.** Verified on the live site (Chrome 157/158, 2026-11-24): the page's first
call to the machine waits on Chrome's permission prompt — `navigator.permissions.query({ name:
"local-network-access" })` reads `prompt` until the person allows it, `granted` after, per site
— so the page says it is connecting and that the prompt is about their own machine, waits up to
25 s, and otherwise offers the runtime's own address. The runtime answers both
`Access-Control-Allow-Local-Network` (Chrome ≥ 138's name) and `Access-Control-Allow-Private-Network`. The
header shows *Connected · your machine* with Disconnect, which forgets the pair. A runtime that
stops answering is said on the first screen, the pair is dropped, and the page carries on as a
visitor. A browser that refuses loopback from an https page (some do) is sent to the runtime's
own address, the same UI. For a visitor the cloud card says *coming soon* and takes an address
(`POST /api/cloud/interest` → `TAPP_HOME/cloud-interest.jsonl`, an address and a date, nothing
else); an existing account signs in from that card.

**Setting this machine up (ADR-0012's journey).** On a local Studio the first screen carries a
setup card above the prompt — *This machine* — with four steps, from one answer
(`GET /api/setup`): the **runtime** (tapp and Node versions, python3 and PyYAML for Flow replay,
disk); **your agent** (every engine found, how it is signed in, Use to choose which drives the
chat; a *Sign in with ChatGPT* button that runs `codex login --device-auth` and shows the link and
one-time code until Codex reports a plan, `POST/DELETE /api/engines/codex/sign-in`; and a field for
an Anthropic API key as the fallback brain, checked against Anthropic's models endpoint, kept 0600
under `TAPP_HOME/agent/`, shown by its last four characters, handed to Claude Code only when no
plan is signed in, `POST/DELETE /api/engines/api-key`); **what you'll test** (per target, what
`tapp doctor --json` found and the exact fix — "Install Xcode from the App Store and open it
once", "System Settings → Privacy & Security → Accessibility", "Install Android Studio…"); and
**your account** (the link, optional). It collapses to one line once an agent drives and more
than one target is ready, and *Check again* re-reads the machine (doctor's answer is reused for
30 s). The Platforms view says the same thing per platform, and on the right kind of machine
missing one thing it names the thing — a Mac without Xcode is told to install Xcode, not to
find a Mac (`platforms.js`). Claude Code's own sign-in opens a browser from a terminal, so the
card says to run `claude` and sign in, then Check again.

**The chat drives the person's own agent (ADR-0012).** On a local Studio, *Your agent* lists the
coding agents found on this machine — Claude Code, Codex, Gemini CLI — and how each is signed in:
a plan, an API key that bills per use, or not at all, with the fix (`mcp-server/src/engines.js`;
`GET/POST /api/engines`). tapp signs nobody in and holds no token. With Claude Code signed in, the
chat grows an input: a prompt is one `agent` operation on the operator's lane that runs
`claude -p … --output-format stream-json` with tapp's own MCP server attached and the tapp skill
appended, allowed `mcp__tapp,Read,Glob,Grep` and nothing that touches the machine; its events
arrive as chat lines (🤖 its words, 🛠️ the tool it reached for, ⚠️ a tool error, ✅ its answer) and
the thread continues with `--resume`. Stop (`agent-stop`) sends `SIGINT`. Codex and Gemini are
reported but do not drive the chat yet. A hosted Studio answers 401 to all of it.

**A self-hosted Studio can report to an account (ADR-0011 §4).** Results flow up; the browser
never reaches down. Under *Your tapp account* on a local Studio, the owner pastes a token created
on the hosted one (under *Your coding agent*); the local Studio checks it against that Studio,
records whose it is, and keeps it in `TAPP_HOME/studio-link.json` (0600, this user only). From
then on every journey run on this machine — including against staging and localhost — posts its
name, platform, step count, machine name and result to `POST /api/journeys/report`; the journey
itself, credentials and screenshots never leave. The account's Journeys list shows it with "runs
on <machine>", no Run button (the cloud has no flow for it), and Forget; a pass↔fail change between
reports delivers the same alert a cloud check's would; the daily checks never pick it up. A Studio
that cannot be reached is said in the chat and never fails the run. `tapp run` on this machine
reports the same way — so an iOS or Android journey run from a terminal shows on the account too —
using the machine's link, or `TAPP_STUDIO` + `TAPP_TOKEN` when set; `--no-report` keeps one run to
itself.

**Signing in** is `POST /api/auth/link` with an email, then `GET /auth/<token>` from the email.
There is no password. Links work once and expire in 15 minutes; sessions last 90 days; only the
SHA-256 of either token is on disk (`account-store.js`). One address may ask for five links per
ten minutes, and the reply is the same whether or not the address has an account.

**Signing in with Google or GitHub (preferred).** Set a client id and secret and the sign-in card
grows a button; set neither and it does not, so the card never offers a way in that cannot work:

```
TAPP_OAUTH_GOOGLE_CLIENT_ID=…      TAPP_OAUTH_GOOGLE_CLIENT_SECRET=…
TAPP_OAUTH_GITHUB_CLIENT_ID=…      TAPP_OAUTH_GITHUB_CLIENT_SECRET=…
```

Register the redirect URI as `<origin>/auth/<provider>/callback`. The flow is a plain
authorization code exchange (`oauth.js`): `/auth/google` sends the person to the provider with a
one-time `state` kept in an `HttpOnly` cookie scoped to `/auth`, and `/auth/google/callback`
refuses anything whose state does not match the cookie it was started with — so a callback URL
sent to somebody else signs nobody in. The scope is `openid email` (or `user:email`), the address
must be **verified** by the provider, and the access token is used once and never stored: a tapp
account is an email address and nothing else. The page is ours; only the provider's own consent
screen is theirs.

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

## Agent access: the owner's coding agent acting as them

"Make sure this always works" needs an answer that does not require a person to open a page. The
owner creates a **personal access token** in the Studio (Runs → *Your coding agent*): it is shown
once, stored only as a SHA-256, and revoked by name. The agent sends it as `Authorization: Bearer
tapp_…` and is that account — same journeys, same test accounts, same evidence, same lane. It is
deliberately *less* than the person: an agent cannot issue or revoke tokens, so a leaked token
cannot mint its own successor, and this machine's repositories and release gate stay the
operator's whoever is asking. CSRF does not apply to a bearer token (a browser never sends one
ambiently) and is therefore not required on these requests.

From the terminal or an MCP client:

```bash
export TAPP_STUDIO=https://app.runtapp.com
export TAPP_TOKEN=tapp_…

tapp report --journeys          # every journey and its last check; exit 1 if any is FAILING
tapp run "coach books a session"  # replay one there; exit 0 passed, 1 failed, 2 usage/unreachable
```

`tapp report --journeys` without `$TAPP_STUDIO` lists what is here instead: a repository's
committed Flows (subfolders and all) or this machine's kept journeys. The MCP tools are the same
two abilities on the existing tools — `tapp_report { journeys: true }` and
`tapp_run { journey }` — never new tools (ADR-0007). Both are implemented by
`mcp-server/src/studio-client.js`.

## Alerts

A kept journey that goes red is only news if someone hears about it. `alerts.js` posts to a
webhook the owner pastes in (`POST /api/alerts`, `GET` returns a summary, `POST /api/alerts/test`
sends one on demand) — Slack and Discord both accept the body, which carries `text` and `content`
plus the journey, state and step counts.

Rules that keep it worth reading:

- **Only on a change.** `alertForChange` compares the previous result with the new one; a journey
  that has been failing for a week does not produce a message every day, and a first run produces
  none at all because nothing has changed yet.
- **Proved before promised.** Saving a webhook posts a message to it; if that fails the webhook is
  not saved and the error says why.
- **Write-only.** The stored URL never leaves the store: the summary gives the host and the last
  delivery. Anyone holding the URL can post into that channel.
- **Public https only.** The post comes from the server, so a webhook on localhost or a private
  range is refused, the same rule the egress proxy enforces for exploration.

## Restricted runners: an approved browser (TM-1023)

Where the sandbox stops tapp starting Chromium itself (macOS: `bootstrap_check_in …
MachPortRendezvousServer: Permission denied (1100)`, SIGTRAP), use a browser started outside the
restriction:

- `TAPP_BROWSER_ENDPOINT=http://127.0.0.1:<port>` — tapp attaches to a Chromium already running with
  `--remote-debugging-port=<port>`. Loopback only; refused under `TAPP_ENFORCE_PUBLIC_EGRESS=1`,
  because tapp cannot enforce its proxy on a browser it did not start.
- `TAPP_BROWSER_EXECUTABLE=/path/to/chrome` — tapp starts that approved binary instead of its own.

Both apply to `tapp run`, `tapp look`, explore and audits.

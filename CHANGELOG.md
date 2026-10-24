# Changelog

## 0.31.0

**The owner's page now answers "what has been happening?"** — "3 visitors" with no detail was not
an answer, and the counters behind it lived in memory and started again at zero on every deploy.

- Activity is now written to `TAPP_HOME/usage.jsonl` as well as stdout, so it **survives a
  restart**. Same discipline as before: no IP address, no full URL, no credential, and only the
  first eight characters of a visitor's cookie — enough to tell two people apart in a day, not
  enough to be a durable handle. The file keeps its tail rather than growing without limit.
- **Who has been here**: every signed-in account and every anonymous visitor, with first and last
  seen, what they did, and which hosts they pointed tapp at.
- **What happened today / this week**: sign-ins, audits, explorations, journeys kept, journey
  runs, new visitors.
- **Every run still on disk**, newest first, with its kind, target, time and owner — this
  predates the log and outlives it.
- **Recent activity** in plain words: "went inside a site · example.com", "daily check —
  FAILED", "refused: rate-limit".

## 0.30.1

- Fixed: the Admin view could not be opened. `activateView` only accepts views declared in the
  product contract and silently falls back to Overview, and Admin had not been declared — so the
  nav item and `/admin` both landed on Overview. The contract now carries it, with the invariant
  that the view reports counts and never decrypts a credential to show it.

## 0.30.0

**An owner's view of your own deployment**, at `/admin` (and `admin.runtapp.com`, which now
redirects there). It is an ordinary signed-in account whose address is listed in
`TAPP_ADMIN_EMAILS` — no second site, no second login, no password anywhere.

- How tapp is being used: accounts, journeys, how many are failing, visitors, audits, runs kept,
  the release, how often kept journeys are re-checked, and how many requests were refused.
- Who has an account: when they joined and were last seen, how many journeys they keep and how
  many are failing, and **counts** of their test accounts and agent tokens.
- Never a credential. Test accounts are encrypted and are not decrypted to be looked at; the
  overview carries numbers, not contents, and a test asserts no token or password can appear.
- To anyone who is not an owner the page is not a door they are refused at — it is not there
  (404), and to a signed-out visitor it is a sign-in prompt.

## 0.29.2

- Where a sign-in provider is configured, Cloudflare Access is no longer offered as a second way
  in. Two doors into the same account only invite "which one did I use?". The route stays alive
  as a way back in if a provider ever breaks, it is simply not advertised.

## 0.29.1

- runtapp.com now has a **privacy policy** and **terms of service** (`/privacy.html`, `/terms.html`),
  linked from the footer and the sitemap. They describe what the hosted Studio actually does: the
  email address is the account, test accounts are encrypted and used only to sign in to the site
  you named, evidence is the product, nothing is sold, and every piece can be deleted by you.
  Google requires both before an OAuth app can be published to anyone.

## 0.29.0

**Sign in on our own page: "Continue with Google".** Cloudflare Access was a stopgap to avoid
needing a mail provider, and it put a third-party page in the middle of signing up for a product.
It is now the fallback, not the front door.

- `/auth/google` and `/auth/github`: a plain authorization-code exchange (`oauth.js`) that asks
  for one thing, a **verified** email address — scope `openid email` / `user:email`, nothing else.
  The access token is used once and never stored, because a tapp account is an address and
  nothing more.
- A one-time `state` travels in an `HttpOnly` cookie scoped to `/auth`; a callback whose state
  does not match the browser that started it signs nobody in, so a callback URL sent to someone
  else is inert.
- The sign-in card shows a button per provider that is actually configured, with "Email me a
  link" underneath — it can never offer a way in that this deployment cannot complete.
- Configure with `TAPP_OAUTH_{GOOGLE,GITHUB}_CLIENT_{ID,SECRET}`; register the redirect URI as
  `<origin>/auth/<provider>/callback`.

## 0.28.1

The read-only pass never presses anything — that is its promise — but it was leaving people to
work out for themselves why a pop-up was still on screen and why nothing had been clicked.

- A pop-up covering the page is now **reported** by the read-only audit: what it says, and the
  way out it offers, without pressing it. "Not checked" names what it covered, on how many pages.
- The run detail says plainly that this pass only looks, and what to do instead: signed out,
  sign in and tapp goes inside; signed in, put the URL in the prompt.
- `detectBlockingOverlay` is split from `dismissBlockingOverlay`, so finding an overlay and
  pressing its way out are separate acts.

## 0.28.0

**Pop-ups: tapp now gets past the shapes real sites use.** Measured against the six common ones,
the old rule — written for a big centred modal — got past *one*. It missed a native `<dialog>`
(which is `position: absolute` by default), a small bottom sheet, a short cookie bar, a corner
toast, and any way out phrased as a sentence ("Not now, thanks"). An overlay is now recognised by
what it *is* — a dialog by role, or anything on its own layer above the page — and the way out is
pressed **inside** that overlay, so the same words elsewhere on the page cannot be hit by mistake.
All six shapes now pass, pinned by `tests/web-overlay.test.js`.

- It still never presses a way out that grants something: "Allow Device Location", "Accept all",
  "Subscribe", "Turn on" are refused, and if a pop-up offers nothing else, tapp presses nothing
  rather than agreeing on your behalf.
- It prefers the way out that grants the least: *Reject all* over *Manage preferences*; *Not now*
  over *Allow*.
- A pop-up standing in front of the page is now **reported** as something worth a look — it is
  the first thing your visitor meets too — and narrated as *Got past "Share your location?" with
  "Not now"* instead of a bare label.
- A sticky header is not a pop-up and is left alone.

## 0.27.1

- The run report now says the polish pass ran, and says plainly what it still does not judge:
  whether the words are right — spelling, tone and claims are read by a person, not by tapp.

## 0.27.0

**Not just what is broken — what a person would notice and not like.** A site can be free of
defects and still be unpleasant, and until now tapp answered that with "0 issues". Every run now
also makes a deterministic *observation* pass (`page-observations.js`, no model, no key):

- text too faint to read (contrast, with the ratio) or too small;
- controls too small to tap **and the page measured again at phone width**, where that question
  has an honest answer — a 20px nav link is a nav link on a desktop and a problem on a phone;
- pages that scroll sideways on a phone; text cut off by its own box with nothing to show it;
- copy nobody finished — lorem ipsum, TODO, "coming soon", a stray `undefined`;
- fields with no label, controls with no name, links that say only "click here";
- images with no alt text, pages with no headline, tab titles that say "Document";
- pages that take more than four seconds to load.

Observations are **counted and listed apart from issues** and carry `category: "polish"`, so
"3 issues" never quietly means "3 issues and 14 opinions". The Studio shows them under
**Worth a look**, and the audit summary carries `observations` / `observationCount`. Both the
read-only audit and exploration run the pass (exploration once per route, and never resizes the
window mid-run).

On a real customer's marketing site this turned "12 pages, 0 issues" into 52 things worth
looking at — including unfinished "COMING SOON" copy, a 3.5:1 contrast on the main call to
action, and a page that scrolls sideways on a phone.

## 0.26.0

- **Put a journey you already have on your Studio.** `tapp run path/to/flow.yml --studio https://…`
  adds that Flow to your account as a journey and replays it there; a bare name still replays one
  already there. A repository's committed journey becomes a journey the hosted Studio owns and
  **checks daily**, which is how a real app gets a live status page without anyone opening one.
  The file is kept verbatim — its comments and `vars:` defaults are part of the journey.
- The Studio refuses, at import and with the reason, what it could never replay: a non-web
  journey, one with no `url:`, one whose steps are outside the Flow vocabulary, or one pointing at
  localhost or a private address (it only opens public addresses — run tapp where that app is).
- New: `POST /api/journeys`; `pushStudioJourney` in the Studio client.

## 0.25.1

- **`tapp run FLOW --var NAME=VALUE`** (repeatable): run the same journey against another
  environment, coach or tenant without editing it. Values merge over the Flow's own `vars:` and
  substitute into every step target — the substitution already existed, but nothing could set a
  variable from outside a scenario. Found while replaying a real customer's committed journeys
  against their sandbox: they pinned a production coach's name, so none of the coach journeys
  could run anywhere else.

## 0.25.0

**Your coding agent can act as you.** ADR-0009 slice 4 — the last of the five pieces.

- **Personal access tokens.** Runs → *Your coding agent* → a token, shown once, stored only as a
  hash, revoked by name. The agent sends it as a bearer token and is that account: same journeys,
  same test accounts, same evidence. It is deliberately less than the person — an agent cannot
  issue or revoke tokens, so a leaked one cannot mint its successor — and this machine's
  repositories and release gate are never its own.
- **Two new abilities on existing commands** (never a new verb or tool, ADR-0007):
  `tapp report --journeys` lists every journey and how its last check went and **exits 1 if any
  is failing**, so it works as a health check in CI; `tapp run <journey> --studio https://…`
  replays one there and exits on the verdict. On MCP: `tapp_report { journeys: true }` and
  `tapp_run { journey }`. Configure with `$TAPP_STUDIO` + `$TAPP_TOKEN`.
  Without a Studio, `--journeys` lists what is here: the repository's committed Flows (subfolders
  and all — it used to show only the top level) or this machine's kept journeys.
- **A way back to what you own.** An account with journeys landed on the empty prompt screen with
  no route to them; the prompt now offers "You have N journeys — see how they are doing", and
  `/#runs` opens them directly.
- This is tapp's answer to notification: it sends no email, but the thing already watching your
  project can ask.

## 0.24.2

- **Fixed: a journey that signs in was being replayed from the saved session.** A journey kept
  from a run that met the sign-in form starts with "wait for the sign-in screen" and types the
  credentials. Handing it the actor's saved session dropped the browser *inside* the application,
  where that first step could never match — the replay failed at step 1 of 13 and the journey
  showed as *failing*. The two ways in are now exclusive (`journeySignInPlan`): a journey with a
  `login` step always starts signed out; one without it resumes the session, and says so plainly
  if the session is gone instead of timing out step by step. Found by filming the product.
- **runtapp.com shows the Studio doing the real thing.** The proof film is now an unedited
  40-second recording of the hosted Studio: pointed at an app with a sign-in, it stops and asks,
  goes inside with the test account, offers to keep the path as a journey, and replays it —
  13 of 13 steps, passing. The old desktop-app demo footage is retired.

## 0.24.1

- **Kept journeys are checked every day.** On a public Studio, every account's kept web journeys
  are replayed on a schedule (`TAPP_JOURNEY_CHECK_HOURS`, default 24), each in its owner's lane so
  a check never queues ahead of the owner's own run, and the Journeys panel shows the result —
  that is the product's answer to "make sure this always works". A restart does not re-run
  everything: a journey is due only when its last result is older than the interval.
- **runtapp.com leads with what tapp does behind a sign-in.** A new section shows the real
  Studio: it asks at the login, goes inside and offers to keep the path, and lists every journey
  with how its last check went. The pilot intake is gone.
- A visitor's read-only audit now says what the next step is: sign in and tapp goes inside.
- `replayJourney` is shared by the Run button and the daily check; `dueJourneys` is tested.

## 0.24.0

Slice 3 of ADR-0009: **a proven run becomes a journey you own.**

- **Keep this as a journey?** When an exploration gets somewhere, the chat says where it went —
  *Dashboard → Orders → Settings (11 steps)* — and offers to keep it. One click writes a Flow in
  the deterministic runner's own vocabulary; it replays exactly that path and fails when the path
  stops working. A run that only looked around is not offered.
- **Where a journey lives is where you are:** the open repository's `.tapp/flows/` (committed,
  guarded by `tapp ci`), your account's own store on app.runtapp.com, or this machine's store.
- **Credentials never enter a journey.** A sign-in is `login: $TEST_EMAIL / $TEST_PASSWORD`,
  resolved at replay from the encrypted actor store; a journey kept from a run that began inside
  replays from the same saved session.
- **Journeys with status.** The Journeys panel lists every journey — a repository's committed
  flows grouped by folder, and kept ones — with *passing · 2h ago*, *failing* or *never run*, a
  Run button, and Forget for kept ones. Accounts on the public Studio have it too.
- New: `mcp-server/src/journeys.js`; `POST /api/captures/:id/keep` (with `preview`),
  `GET /api/journeys`, `DELETE /api/journeys/:slug`; `run-flow` replays kept journeys and records
  their status; `runWebFlow({ storageStatePath })`; the explorer marks a run that started signed in.

## 0.23.1

- **Sign in through Cloudflare Access, so tapp never sends email.** With an Access application
  on `/auth/cloudflare` and `TAPP_ACCESS_TEAM_DOMAIN` + `TAPP_ACCESS_AUD` set, *Sign in* goes to
  Cloudflare (one-time PIN or Google), and the signed assertion it returns opens the tapp
  session — signature, audience, issuer and expiry all checked against the team's published keys
  (`access-jwt.js`, no dependencies). The email link remains the provider-free path; the Studio
  offers whichever is configured (`signInProvider`).

## 0.23.0

Slice 2 of ADR-0009: **accounts on the public Studio**, so that getting inside an application —
asking at its sign-in, remembering the answer — works from app.runtapp.com and not only on your
own machine.

- **Sign in with an email link.** No password, nothing to create. `Sign in` on the prompt
  screen asks for an address and mails a link that works once; after that a session cookie.
  Only the hash of a link or session token is ever on disk. One address may ask for five links
  per ten minutes, and the reply never reveals whether an address has an account.
- **A signed-in account explores for real.** A URL in the prompt goes inside; when the run meets
  a sign-in it stops and asks in the chat, exactly as a local Studio does. A visitor is still
  never asked and still gets the read-only audit.
- **Test accounts, per account, encrypted.** What you tell tapp is kept under your account alone
  (`TAPP_HOME/accounts/actors/<id>/`), listed in Runs as a name plus *password set* / *signed-in
  session* — never a value — with *Forget*. Evidence and jobs are stamped with the account, so
  one account cannot see another's.
- **Mail.** Resend via `TAPP_MAIL_RESEND_KEY` + `TAPP_MAIL_FROM`; without them, a private 0600
  outbox under `TAPP_HOME/mail-outbox` (or `TAPP_MAIL_OUTBOX`). A link is never written to a log.
- The ask card keeps what you have typed while the run polls (it was being rebuilt under your
  fingers); a refused start no longer leaves "Exploring" over an empty stage; a local trial of
  `--public` on a loopback origin can reach services on the same machine.
- New: `mcp-server/src/account-store.js`, `mcp-server/src/mailer.js`; `accountAllows` in
  `browser-product.js`; `runQaWeb({ actorRoot })`.

## 0.22.0

The unit of value is a proven journey, not a crawl — and to prove a journey tapp has to get
inside the application. Until now it could not: every real app lives behind a sign-in, and the
web engine could accept credentials but never ask for them. (ADR-0009.)

- **tapp asks at a sign-in, and remembers.** When exploration meets a login it has no
  credentials for, it stops and asks — in the Studio's chat, or on the terminal with
  `tapp explore <url> --interactive`. The protocol is the one the iOS harness and the desktop app
  already speak (`OCQA_AWAIT_INPUT`), so a run pauses the same way everywhere. After a sign-in
  works the browser session is kept, encrypted, so the next run starts inside the application
  and a login that needs a code or an email link only ever has to be done by a person once.
- **An encrypted actor store.** `TAPP_HOME/actors/<host>/<actor>` holds what a person typed and
  the signed-in session: AES-256-GCM, a 0600 key generated once, the host and actor bound into
  the cipher so a record cannot be mistaken for another app's. Nothing in it reaches evidence,
  markers, logs, or tool output; a secure field never carries a default over stdout. Each of
  those is a test. `--actor NAME` starts a run from that identity's saved session;
  `--remember` keeps what was typed.
- **Journeys are shown.** The Studio lists every committed journey under `.tapp/flows/`,
  recursively and grouped by folder, with real step counts and one-click replay — the engine
  had listed them all along and the Studio never rendered them. A repository with a hundred of
  them now reads as a map of what the app has proven. Web journeys replay in the Studio with a
  recording; an iOS or Android journey is answered with the command to run it where the
  simulator is.
- **A URL from the Studio prompt goes inside on your own machine.** On a self-hosted Studio it
  is a real exploration that can stop and ask. On the public Studio it stays read-only: a hosted
  page asking a stranger for their login to another site is phishing-shaped, so a visitor is
  told to go inside from their own machine, with the command.

## 0.21.2

- **Usage logging counts people, not scanners.** A public host is probed constantly: in one
  afternoon the Studio recorded 404 "new visitors", 383 of which were bots looking for `.env`
  files — a reading that answers "is anyone using this?" with noise. Automated secret probes are
  still refused and still counted, but they no longer mint a visitor, no longer appear line by
  line, and are summarised instead. The distinct-visitor count is also bounded, since a counter
  fed by every scanner on the internet grows without end.

## 0.21.1

- **A run finishes the work it was asked to do.** Exploring a real site ended on its time budget
  at 24 of 40 actions; the same run now completes all 40 in less than half the time — 17.2
  seconds per action down to 4.7, and 14 screens up to 26. Nothing was made to skip work: three
  controls had been consuming 340 of 414 seconds between them.

  Every Playwright locator call inherits the page's 15-second default, and reading one control's
  label makes five of them. On an element that never settles that is seventy-five seconds to
  learn a button's name. Reading a label is metadata, not navigation: it is bounded to a second
  now, and an unreadable label is reported as empty rather than waited for.

- **Clearing an obstruction is bounded, and gives up per page.** Recovering from an overlay could
  reload the page with the default 30-second navigation timeout, once per blocked control. An
  overlay that survives a dismissal and a reload will survive the next control too, so the page
  stops paying for it.

- **A hosted audit reads twelve pages, not six.** Six was a quiet default with nothing in the UI
  to change it, so every site came back looking like a six-page site — including ones with a
  dozen sections, a login and a booking flow.

## 0.21.0

- **An overlay is got past, by its own way out.** Cookie banners and intake modals sit in front of
  a large share of real sites, and a crawler that cannot dismiss one never sees the application
  behind it. On a real site a location-intake modal made every control on the home page
  unreachable: the run reported seventeen controls it "could not click", reached ten screens, and
  the coach search, sign-in and booking flows were never discovered — the site looked, from
  outside, like a six-page brochure. The same run now reaches eighteen screens with one low
  finding.
- **Nothing is consented to on your behalf.** Probing clicks every button it can reach, which on
  a real page means pressing "Allow Device Location", "Accept all cookies" or "Subscribe" —
  granting a permission, accepting tracking, or signing someone up. Those are skipped now, the
  way logout and delete already were. When an overlay must be dismissed, a decline is preferred
  to an accept, and if the only way out would grant something there is no way out: it is reported
  rather than pressed.
- The dead-control probe refreshes its baseline whenever it has to clear an obstruction first,
  since clearing one is itself a change and the control would otherwise look alive.

## 0.20.2

- **A replay is filmed at the size it runs at.** Without an explicit size Playwright fits a
  recording into 800px, so `tapp run --viewport 1440x900` produced a small, soft video whatever
  the run was rendered at. Exploration already passed its viewport through; replay now does too.
- **The device panel stops telling you to start a run that is already running.** While the
  browser is launching there is nothing to show yet, but "Run a release check or open a live
  session" during your own run reads as though nothing happened. It now says what is true.

## 0.20.1

- **The stage shows what a person would be looking at.** A website audit put its full-page
  evidence screenshot on the live stage, and a full page of a long marketing site is a tall
  sliver once fitted to a device frame — so a run that was working looked like nothing much. The
  audit now writes a viewport-shaped frame alongside the evidence, the stage uses that, and a
  finished run keeps the frame it ended on instead of swapping to the full-page shot.
- **`look` can read a replayed Flow.** A capture was only recognised if it had markers, which a
  Flow replay does not write — so `tapp look <capture>` refused to open the very recordings the
  feature exists to read. A directory with a recording is now a capture.

## 0.20.0

Four reasons an exploration came back having barely looked, found by pointing tapp at a fixture
built to be deep and asking why the run was short.

- **A control behind a modal is probed.** The dead-control pass clicked each button in turn, so
  once one of them opened a modal, drawer or cookie banner, every later control was clicked into
  the overlay, failed silently, and was skipped — a page with a modal reported no dead controls
  however many it had, and said nothing about having skipped them. The probe now clears the
  obstruction and retries, judging the retry against the page as it is then, and reports a
  control it still cannot reach instead of leaving a hole in the coverage. Real applications are
  mostly pages like this.
- **In-page state is a state.** A screen was identified by its heading, else its title, else its
  URL, so a modal, a drawer, a tab or a wizard step — none of which change the heading — was "the
  same screen". The frontier gained nothing, exploration drained early, coverage undercounted,
  and the recording showed one near-identical frame for a whole run. Identity now also carries a
  signature of what is on screen, stable under reordering and reflow, capped per route so a
  carousel cannot mint states forever.
- **The budget you ask for is spent.** The dead-control probe examined the first four buttons on
  a page regardless of `--actions`, so a sixty-action budget still barely looked at a page with
  fifteen controls. Depth now scales with the budget, between four and twelve.
- **A third party blocking robots is not a broken link.** npm, and anything behind a bot defence,
  answers 401/403/429 to an automated browser. That was reported as a broken link — on tapp's own
  landing page among others. It is now a low-severity "could not be verified" that says what was
  actually observed.

`WebDemo/checkout.html` is a deliberately deep page — drawer, modal, three-step wizard, two dead
controls — so a demo has somewhere to go and these behaviours have something to prove against.

## 0.19.3

- **An outbound link is checked as written.** Tapp fetched `origin + pathname` and threw the
  query away, so `/items?itemName=lidi-solutions.tapp` (200) was checked as `/items` (404) and
  reported as a broken link — on tapp's own landing page, among others. For marketplace, store
  and search links the query *is* the resource. Only the fragment is dropped now.
- Fixed on runtapp.com in the same pass: an uncaught `commandSlot is not defined` on every page
  load, which had left the copy button dead. Tapp found it by exploring the site.

## 0.19.2

- **A public Studio records that it was used.** It served strangers while logging only its own
  startup, so there was no way to tell whether anyone had found it. Usage lines now go to stdout,
  which journald already keeps (`journalctl -u tapp-demo | grep tapp-usage`): a visitor arriving,
  an audit starting and finishing with the host and duration, refusals and why, a target the
  cloud cannot run, and an hourly rollup so the answer survives log rotation. Off unless the
  Studio is public — a local Studio logging its owner's own use is noise.
- Deliberately not collected: no IP address, no full URL, and only the first eight characters of
  the visitor id. Engine errors quote the URL they failed on, so logged messages have their query
  strings redacted — the first version of this put a token from a test link straight into the log
  it promised not to hold, and a test now asserts it cannot.

## 0.19.1

- **Two people can use a public Studio at once.** Work was serialized globally, so one visitor's
  audit answered every other visitor with 409 — which reads as broken rather than busy. Runs are
  now serialized per lane: the operator's lane stays strictly one at a time because it owns the
  simulator, the repository and the live session, while an anonymous audit owns nothing but its
  own browser and capture and gets a lane of its own. Three concurrent visitor runs, and beyond
  that the answer is 503 ("busy") rather than a 409 that falsely blames your own run.
- **The heading stops reverting.** "Website audit" was overwritten back to "tapp" the moment a
  run finished, because the session poll re-rendered over it. A heading set by whatever is
  happening now survives until something else takes over.
- **No empty decision panel on a website audit.** "What the last run proved" reports a release
  decision, which a read-only audit never produces, so it could only ever read "No run yet".
- **Recordings are playable where they land.** The H.264 sibling is written when the recording is
  finalised, not only when `look` is asked for frames, so `exploration.mp4` sits beside
  `exploration.webm` in every capture. QuickTime and Preview cannot open VP9.

## 0.19.0

- **`app.runtapp.com` is a public Studio.** `tapp app --public --origin https://host --port N`
  serves the Studio to anyone, with no account, and narrows what a signed-out visitor can reach
  to one thing: a read-only audit of a public website, plus the evidence from their own audits.
  Repositories, live sessions and the release gate stay behind an authenticated local session.
  The browser is routed through the public-egress proxy, which pins every connection — redirects
  and subresources included — and refuses loopback, private, link-local and metadata addresses;
  `TAPP_ENFORCE_PUBLIC_EGRESS` fails a run rather than reaching a private network. Anonymous
  captures are stamped with their visitor before the run writes anything, so evidence is never
  readable by anyone else. Ten audits per visitor per hour. Decided in ADR-0008; the demo
  sign-in and the private-pilot adapter behind it are retired.
- **A target the cloud cannot run is answered, not refused.** A folder, a repository, a bundle
  id, an `.app` or an `.apk` now returns the command that runs it on your own machine instead of
  a bare 401 that surfaced as a toast and cleared itself. The hosted Studio also stops
  advertising what it does not have — no target picker, no runner, no release gate, no decision
  card — and an audit shows the page being audited on the stage as it goes, rather than "No live
  feed yet" for the whole run.
- **`look` reads a finished run.** `tapp look <capture>` returns the screens a run observed with
  the moment each was reached; `--at N|"screen"` pulls that screen's frame out of the recording;
  `--frames` writes contact sheets (many frames per image) so a recording can be scanned cheaply
  instead of one frame at a time; `--json` returns the index. `tapp_look` gains the same through
  `capture`, `at` and `frames`, so MCP stays at thirteen tools. No new verb: a frame is a screen,
  and `report [capture]` already took a capture (ADR-0007, amended).
- **The index is written, not derived.** `OCQA_STATE` and `OCQA_ISSUE` now carry the timestamp
  `OCQA_ACTION` already had, and a `RECORDING` marker anchors the video to the same clock, so a
  screen's frame is a seek rather than a scan and "where was this finding observed" is a lookup.
- **Recordings are openable.** A replayed web Flow records video when asked
  (`TAPP_FLOW_RECORD_VIDEO=1`), which previously produced a file named by an internal id that
  nothing ever renamed, and every recording is written as H.264 mp4 beside the VP9 webm, because
  QuickTime and Preview cannot open VP8/VP9.

## 0.18.4

- **iOS on the stage, verified by hand.** A build or bundle id pasted into the prompt now shows the
  booted simulator's screen live while the exploration runs (the job frame falls back to a
  simulator screenshot the way a live session does), the stage takes the phone's shape even when a
  web repository is open, the run's last screenshot stays on the stage afterwards, and the frame is
  sized by the stage's height rather than by the screenshot's pixels. The drawn notch is gone; the
  simulator's own island is in the frame. Chat icons for probing, swiping, going back and switching
  tabs; the start line names the `.app`/`.apk` by file name.

## 0.18.3

- **The Studio opens on a prompt.** With nothing open, `tapp app` shows one field — *What should
  tapp test?* — above a short animation of a device being driven. It takes a website URL, a
  GitHub `owner/repo` (cloned with `gh` into an isolated workspace on this machine), a folder on
  this machine, a bundle id on the booted simulator, a simulator `.app`, or an `.apk`; a business
  name is answered honestly (nothing discovers surfaces from a name yet). New Studio operations
  `open` and `explore-build`; `GET /api/captures/:id/files` lists a capture's screenshots,
  recording and report; prompt-started explorations are listed under Runs beside audits.
- **The Overview is the device.** The stage gives the simulator, emulator or browser every pixel
  the window allows, in the platform's own aspect ratio, and shows the newest frame the run wrote.
  The chat floats over its corner on a translucent ground, collapses to a pill, and narrates the
  engine's own progress log with emoji-led lines, inline screenshot thumbnails, attachment chips
  for the recording and `report.html`, and a closing pill (`✓ Ready to merge`, `× Do not merge`,
  `◐ Inconclusive`, or an exploration's counts) with the headline. Nothing is generated after the
  fact and nothing is a score.
- `tapp init`-style explorations (`runInitExploration`) now return the exploration `headline`,
  `screensExplored`, `actionsPerformed` and `findingCounts` beside the findings.

## 0.18.2

- **The Studio is a run viewer.** After the browser surfaces audit (ADR-0006, owner decision of
  2026-10-15) `tapp app` keeps what a browser does better than a terminal — watching a real device
  while a run happens, driving it by hand and recording a Flow, reading every run's evidence — and
  drops the second Command Center: the Contracts, Coverage and Settings views, the journey stepper,
  and the folder-upload / GitHub-clone / remote-runner onboarding are gone (`tapp plan`,
  `tapp validate`, `tapp ci` and `.tapp/project.json` are where that work lives). A repository
  is opened with `tapp app /path/to/repo`; with no repository the Studio still audits websites.
- **Website audits from the Studio.** A URL field runs the read-only audit (`explore --read-only`,
  up to six pages, nothing clicked) and lists it with the release runs; each opens the report page
  the engine wrote. New `audit` operation and `GET /api/audits` on the local server.
- The browser client went from 834 to 522 lines, the stylesheet from 39 to 28 KB (every rule the
  removed views used is gone); the server lost the upload, GitHub, planning, promotion, baseline and CI
  endpoints. The hosted control plane (`saas/`) is frozen and unchanged.
- `website/` (the earlier demo runner) and `cloud/` (the runner prototype) were removed.

## 0.18.1

- **A finished iOS exploration no longer hangs on the simulator recorder.** `simctl io recordVideo`
  sometimes ignores SIGINT on hosted runners; the capture script waited on it without bound and
  the engine waited on the script, so a one-action exploration whose harness had long finished sat
  until the caller's budget expired. The recorder is now stopped on a deadline (INT, then TERM,
  then KILL — a truncated recording is reported, not a hung run), and the engine gives the script
  a bounded grace period after its own deadline.
- **Node 20 is the minimum.** Node 18 reached end of life in April 2025 and Playwright 1.64
  requires Node 20; `engines.node` is `>=20`, `tapp doctor` says so, and hosted CI tests on
  Node 20 and 22. Playwright moves from 1.61.1 to 1.64.0.
- **`--device` chooses the iOS simulator** (public issue #31). With several simulators booted,
  every iOS path — `explore`, `look`, `run FILE`, `tapp_explore`, `tapp_look`, `tapp_session` —
  drove whichever one `simctl` listed first; `--device` was honoured for web only. A production
  build got exercised instead of the sandbox one, and after that simulator was shut down the next
  run silently drove a simulator another agent session was using. Now `device` (CLI and MCP) is
  a simulator name or UDID for iOS, `TAPP_UDID` is the environment default, the harness scripts
  address that UDID instead of the `booted` alias, and with more than one simulator booted and
  none chosen the run refuses with the list (`simulator-selection-required`), the same way an
  ambiguous repository target does. A chosen simulator that is shut down is booted for a long
  run and reported for a short one — never swapped for another.

## 0.18.0

- **The Studio looks like the Command Center.** `tapp app` (and the hosted Studio built from the
  same `browser/` assets) now uses the desktop palette and layout: wordmark and project menu,
  Overview / Runs / Findings / Coverage / Contracts / Settings with a findings badge, a project
  block with target, runner and app id, and a "Release Command Center" heading with the current
  phase and a progress chip while an operation runs.
- **A device feed and "tapp chat" on Overview.** The feed shows a live session frame or, during
  exploration, the newest screenshot the explorer wrote (`GET /api/jobs/<id>/frame`); the chat is
  the engine's own progress log rendered as a transcript. Web exploration now narrates each action
  and each new screen (`Opened /cart`, `Reached Cart`, `Tapped "Place order"`) through
  `onProgress`; the iOS tail forwards `OCQA_ACTION` lines the same way, synthesizing a narrative
  when the harness wrote none. Progress entries carry `current/total` from the action budget.
- Onboarding frames the three entry layers: repository cards are labelled as such, and a website
  card links to `/connect` in the hosted Studio or points at `tapp explore --read-only` locally. Website projects
  are labelled "no source, no release verdict" in the sidebar and settings. The mode pill reads
  "Self-host · this machine" or "Cloud · outbound runner".
- Fixed a stray click handler at the end of `browser/app.js` that ran at module load.
- **One command surface (ADR-0007).** The CLI goes from 33 verbs to twelve — `explore`, `look`,
  `run`, `validate`, `init`, `plan`, `ci`, `app`, `report`, `doctor`, `mcp`, `feedback` — and
  the local MCP server from 31 tools to 13 with the same names (`tapp_explore`, `tapp_look`,
  `tapp_run`, `tapp_validate`, `tapp_init`, `tapp_plan`, `tapp_map`, `tapp_ci`, `tapp_report`,
  `tapp_session`, `tapp_build`, `tapp_doctor`, `tapp_feedback`). `audit` is `explore --read-only`,
  `focus` is `explore --goal`, `open`/`tree`/`shot` are `look`, the four `flow|task|contract|scenario`
  families are `run FILE` and `validate FILE`, `pr`/`map`/`workflows`/`actor` live under `plan`,
  `baseline` under `ci`, `install` under `doctor --install`. The VS Code extension exposes five
  tools (`tapp_open_app`, `tapp_look`, `tapp_act`, `tapp_explore`, `tapp_build`) and the hosted
  control plane adopts the shared names where it overlaps. Every old verb and tool name still works
  for one minor version and prints its new form. Nothing in the engine changed.

## 0.17.27

- **`tapp audit` stops calling wired controls dead.** A precision pass on 25 real small-business
  sites (140 pages, read-only, mobile profile) found that nearly half of all findings were
  `href="#"` links that had a click handler — menus, sliders, lightboxes — and that one
  WordPress site's 104 "dead buttons" were Elementor accordion headers wired through jQuery's
  delegation registry, where the selector lives in `jQuery._data`, not in handler source. Now a
  placeholder or in-page link gets the same wiring test a button does before it is reported, and
  the wiring test reads jQuery's registry for direct and delegated click handlers.
- A link is only called broken after a `GET` confirms it: some servers answer 404 or 5xx to
  `HEAD` for pages that load.
- Icon-only controls are named by their image alt, `title`, `aria-labelledby` or inner SVG label;
  a control with no name at all is reported as "unlabelled <a>", never by an evidence selector.
- The site audit result carries `issues`: one entry per distinct defect across the site with the
  pages it appears on, so a footer link answering 404 on six pages is one thing to fix.
- **The wiring check says when it cannot see, instead of accusing.** Three site-builder patterns
  make "no handler found" meaningless: scripts delayed until the first interaction (Perfmatters,
  WP Rocket, Flying Scripts — detected by their script types, or by a jQuery tag with no jQuery),
  pages that load scripts but attached no click handler at all by audit time (lazy hydration), and
  a site-wide handler on `<body>`/`document` the audit cannot read with three or more controls
  under it (Squarespace); Wix is treated as lazily hydrated outright. On such pages the
  dead-control and placeholder-link checks are skipped and the report's "not checked" list says
  why (`wiringUnverifiable` per page, `pagesWithUnverifiableWiring` per site). Native
  `<summary>`/`<select>`/`<label>` controls, shadow-root hosts and third-party widget mounts
  (accessibility overlays, chat bubbles) count as wired.
- A failed image that is a 1×1 or beacon-style request is not a broken picture; a link fetch that
  drops the connection is retried once before it is reported, and then only as low.
- Measured on the 25-site pass: 369 findings → 64, every remaining finding sampled verified by
  hand (see `docs/AUDIT-PRECISION-2026-10-12.md`).

## 0.17.26

- **An iOS crash is attributed before it is reported** (public issue #30). The harness reports
  `crash` when the app under test stops running; it cannot say why, and xcodebuild prints the full
  system crash trace for any simulator process that dies. A SpringBoard death — which takes every
  foreground app with it — therefore read as a critical app crash. After every iOS run whose
  markers contain a crash, Tapp now cross-checks the real crash reports in
  `~/Library/Logs/DiagnosticReports` with the rules the desktop app has used since a field
  false-CRITICAL incident (bundle id in header, body or bundleInfo; procPath inside this simulator's app
  container; the XCUITest runner never counts; EXC_GUARD is not a crash) and writes
  `crash-attribution.json` into the capture. A confirmed app crash stays critical and carries its
  `.ips` path and exception type. A simulator system process crash becomes
  `simulator_system_crash` and a runner death `test_runner_crash`: medium, advisory, reported
  but never counted toward the gate. With no report in the run window the observation stands,
  marked unverified. Captures without the file are unchanged.

## 0.17.25

- **Every capture knows which project made it** (public issue #29). A Copilot session working in
  one repository had cited an older capture from another repository as evidence, because
  `~/.tapp/captures/` is shared by every project on the machine and nothing said whose a capture
  was. Explore, audit, flow and scenario captures now write `provenance.json` (kind, platform,
  target, project directory/name/git remote, tool version, time); every result that hands back a
  capture path hands back that record; `tapp_list_captures` lists this project's captures only
  (other projects' and pre-provenance captures are counted, not shown, unless `allProjects` is
  true) and labels each with its provenance; `tapp report latest` means this project's latest and
  says so when it has to fall back. The skill and AGENTS.md carry the rule: the capture a command
  returns is the evidence; never present another project's capture as this one's or borrow it as
  a fixture.
- **The hosted iOS gate no longer fails on exploration-order variance.** The reachability-loss
  regression (a baseline screen never reached) now requires a real collapse — fewer than 60 % of
  the baseline's screens reached at a comparable budget — instead of firing because one of seven
  screens was skipped at 16 actions. The stranded-explorer case it was built for (two of seven
  reached) still fails the gate. The iOS e2e harness budget per command is 10 minutes, because
  the first explore on a hosted macOS runner builds the harness.

## 0.17.24

- **Tool descriptions say what they are NOT for.** `tapp_ui_tree`, `tapp_session_start` and
  `tapp_audit` name the neighbouring tool an agent reaches for by mistake (launch → `tapp_open_app`,
  bugs → `tapp_explore`, third-party sites → `tapp_audit`, behaviour on an owned app → explore or a
  session), the way `tapp_open_app` and `tapp_flow_run` already did.
- **An inconclusive exploration leads with the step that unblocks it**: credentials or an actor for a
  sign-in wall, a larger time budget when the budget ran out, `tapp_open_app` with launch args when
  the app may not have launched — instead of the generic baseline/session suggestions.
- README tells developers that a live site, production, or a site they do not own goes through the
  read-only `audit`, not exploration.

## VS Code 0.3.10

- **`tapp_audit_web`**: Copilot can audit a live web page or site read-only — dead controls, broken
  images, 404 assets and links, failed requests, JS errors, mixed content, overflow — with `pages` to
  crawl same-origin and `device` for the mobile rendering. Nothing is clicked, so it is the tool for
  production or a site the user does not own. Bundles the skill with the audit routing below.

## 0.17.23

- **Agents are told when to audit and when to explore.** The MCP server now sends connect-time
  `instructions` (smallest-operation routing, audit-vs-explore, observation-not-verdict, honesty
  rules); `tapp_explore`'s description points third-party and production URLs at `tapp_audit`; the
  Agent Skill's trigger description, decision table and command reference, and AGENTS.md's tool
  table and honesty rules carry the same rule. A clean audit is never to be reported as "the site
  works".
- Web exploration now records video, matching iOS's existing `exploration.webm`/`.mov` capture
  convention — Playwright records natively (no ffmpeg transcode needed) and the file lands as
  `exploration.webm` in the run's capture directory, so the existing capture summary and hosted
  replay endpoint pick it up with no further changes. Outbound link checks run in their own
  unrecorded browser context so third-party navigations don't pollute the video.

## 0.17.22

- **`tapp audit` is now a complete read-only site check, built for sites you do not own.** It still
  never clicks, types, submits, or hovers. On top of the structurally dead controls it already found
  it now reports images that failed to load, same-origin assets answering 404, 5xx and failed
  requests and uncaught JS exceptions during load, same-origin links answering 404/410/5xx
  (HEAD, then GET when HEAD is refused; the first 30 per page), mixed content, a page wider than
  its viewport, and a missing viewport meta tag. `--pages N` crawls same-origin links breadth-first
  with robots.txt honoured and a pause between pages; several URLs or `--urls FILE` audit a batch;
  `--json FILE` writes the result to a file. The browser identifies itself as
  `tapp-audit/<version> (+https://runtapp.com)` on top of its normal user agent.
- **An audit writes a capture.** `~/.tapp/captures/web-audit-<timestamp>/` holds a full-page
  screenshot per page in the explore layout (`state_N_<page>.png`), an element-scoped evidence
  shot for every finding that names an element, `ocqa-markers.txt`, `report.json`, `audit.json`
  and `report.html` — so `tapp report`, the Studio and any tool that already reads an explore
  capture reads an audit unchanged. The report states the audit's own scope: its "checked for"
  list never borrows the exploration run's clicks, and the exploration coverage floor does not
  mark an audit inconclusive.
- **`tapp_audit` MCP tool** exposes the same audit to agents, with the same read-only guarantee.
- Exit codes are unchanged: 0 nothing broken, 1 defects found, 2 usage or infrastructure.

## 0.17.21

- **Replacing a prefilled field works on a simulator without a hardware keyboard.** Clearing the
  old value used forward delete, which only exists on a hardware keyboard; the simulator's is
  disconnected by default, so XCUITest inserted that key's raw value as literal text and left the
  field holding unrenderable glyphs. A `login` or `type` step onto a field that already had
  content failed with "Field contents could not be cleared". Clearing now uses backspace alone and
  re-anchors the caret past the end of the visible text, so a value scrolled out of view is still
  reached.
- **No platform is labelled "beta" anywhere any more.** The label was dropped from the README and
  the site on 2026-09-14 but survived in the CLI's macOS-required error, the `tapp_explore` tool
  description and its argument help, the error naming the three target kinds, and the report's
  "not checked" list. Every real requirement ("requires Playwright installed") and real limit
  ("only the first few visible buttons per page are probed") is unchanged.
- **The browser workspace shares one design system** with the hosted Studio, so the two surfaces
  no longer drift apart visually.
- **Maintainers:** `tools/bump-version.sh` bumps the five files that must agree on the version and
  verifies them; the public sync refuses a stale, dirty or diverged mirror checkout and retries a
  commit that was made but never pushed; and `release-public.yml` runs the whole release from one
  button, so no one needs an npm token or push rights on the mirror.

## 0.17.20

- **Login screens without a navigation bar work in sessions and Flows** (#28). Reading an
  absent navigation bar previously raised an XCTest failure before the first action. The
  navigation-history helper now checks existence, and ended sessions surface the XCTest cause.
- **Credential replacement selects and clears the full field**, verifies it is empty, and
  checks that the email retains the requested value. A cursor in the middle of a prefilled
  address no longer leaves a suffix behind. Failed replacement stops sign-in before submission.
- **VS Code login prioritizes configured actors over saved credentials.** An explicit `actor`
  resolves environment bindings inside the engine; otherwise a sole configured actor is used
  or the user selects among several. Explicit credentials win. Partial explicit credentials
  never get replaced by saved values, and a SecretStorage read failure does not submit the form.
- **Concurrent extension tools share one engine connection and execute in order.** Login waits
  for an in-progress open, and a closed engine connection reports that the session was lost.
- **All iOS runners and `doctor` use the same validated harness descriptor.** The cache tracks
  source/project contents, simulator identity, and the selected Xcode/SDK. Stale SDK descriptors
  cannot win an arbitrary directory scan; SDK and simulator OS versions need not match.
- **Pre-step Flow failures retain the authored step count and underlying XCTest error**, using
  `xctest-summary.json` from the result bundle when available and specific log errors as fallback.

## 0.17.19

- **iOS `tree` preserves the installed app and its data** (#25). Inspection resolves the
  repository's recorded iOS bundle id or the sole installed app; ambiguous targets produce an
  explicit choice. It never builds, installs, or uninstalls the app. Use `tapp build` explicitly
  when a replacement is intended.
- **iOS Flow evidence includes the final frame** (#26). Both passing and failing replays write
  `flow-final.png`, and failed steps retain `flow-failure-N.png`. Final capture runs during
  XCTest teardown so an aborted step can still leave evidence. Write failures are reported,
  with the XCTest attachment retained as a fallback.
- **Asynchronous content and selection changes count as a response** (#27). Exploration
  already compared text and values; it now observes unchanged controls for up to eight seconds
  and includes selection/enabled state. A missing tree, ongoing loading, or insufficient run
  budget cannot establish a dead control. Immediate changes return without the extra wait.
- **Exploration no longer taps the center of the app before recording its launch screen.**
  That startup tap could activate a working control, then make the explorer's recorded tap look
  unresponsive. Startup now dismisses only an observed system-alert control.
- **iOS Flow replay forwards `--launch-arg` and `--launch-env`** to the app, matching exploration.
- **Large simulator and installed-app inventories remain readable.** Machine-readable command
  output is preserved through JSON/plist parsing; the diagnostic text limit previously cut
  large hosted-runner inventories into invalid JSON and blocked CLI inspection/exploration.
- Simulator regressions cover installed binary/data preservation, immediate and delayed date
  content, selection-only changes, a genuinely dead button, and passing/failing Flow PNGs.

## 0.17.18

**`back` never performs an action that isn't a back.** Found by a negative test against a real
simulator, in code 0.17.17 had just shipped.

- **It no longer taps an arbitrary toolbar button.** With no Back control, `back` fell through
  to `navigationBars.buttons.firstMatch` — on a screen whose first toolbar item was **Share**,
  it opened the share sheet, saw the screen change, and reported a successful pop. On a real app
  that first button could be Delete or Sign out. Only a genuine back affordance (`Back`,
  `Back to …`, `BackButton`) is accepted now.
- **It no longer swipes blindly.** The edge-swipe fallback was not a back either: on a screen
  whose content scrolls sideways the drag landed in the content and navigated *forward*
  (`Dashboard` → `What's New`), reported again as a pop. With no back control, `back` now
  returns `no_effect` and says why — a caller who wants the gesture can ask for `swipe`.
- **Recognising the back button does not depend on one fragile signal.** A leading
  navigation-bar control counts as back when it is named after a screen the run has been on,
  named after the current screen (a detail view that inherits its parent's title), or an
  unlabelled chevron — and never when it is a named app action (share, delete, add, edit,
  save …). Relying only on a navigation-title history worked on one iOS version and failed on
  another, which is precisely the kind of single-signal check this release is about.
- **It still recognises the standard iOS back button.** iOS labels a pushed screen's back
  control with the PARENT screen's title ("Todo List"), not "Back", so matching on the label
  alone rejected real back buttons and failed a committed release contract. A leading
  navigation-bar button named after a screen the run has actually been on is a back control; a
  leading button named anything else is an app action.
- **A pop is judged by the screen's controls changing.** Every cheaper signal is wrong for a
  concrete reason: a tree hash moves on its own when content loads late; a detail view that
  inherits its parent's title reads identically on both sides of a pop; and re-reading the
  tapped element does not work at all, because `XCUIElement` is a lazy query — `exists` after
  the tap re-resolves "the navigation bar's first button" against the NEW screen and finds
  whatever leads it there, so a successful pop looked like the control was still present. A pop
  replaces the screen's controls, and two or more changing is the evidence (one is content
  churn).
- `back` inside a **Flow** goes through the same verified path, so a Flow step that did not
  navigate fails instead of silently passing and running the rest of the Flow against the wrong
  screen. Failures carry the visible-labels hint.

## 0.17.17

**The iOS session stops claiming outcomes it never verified** (field issues #4 #6 #8 #10).

- **`back` proves it navigated**: it compares the screen before and after and returns
  `no_effect` when nothing moved, instead of reporting `ok` four times while the pushed screen
  stayed on top (after which every tap failed `not_hittable`). It also prefers an explicitly
  labelled, hittable `Back` control, so a `NavigationStack` presented inside a sheet no longer
  resolves the wrong navigation bar. (#10)
- **`tap` by id no longer reports `ok` when nothing happened**: if the target is still on screen
  and the tree is unchanged, the tap did not reach the control the caller meant. iOS renders
  "Save Password?" and similar sheets in SpringBoard, not in the app, so the tap is retried
  there before the step is reported as `no_effect` with guidance. (#6)
- **The share sheet is a system surface, not an app defect**: `UIActivityContentView`, the
  extensions it hosts, and other remote-view hosts render *inside* the app process, so the
  0.17.8 left-app detector (which watches the frontmost process) could not see them — and their
  unreadable trees were scored as the app's only "high" finding. They are now catalogued as a
  handoff observation and backed out of, never scored. The DemoApp corpus gained a real
  `UIActivityViewController` so this stays regression-tested. (#4)
- **A system surface that will not dismiss ends the run honestly**: `back` is a no-op on a
  presented sheet and a mid-screen swipe scrolls its content, so the escape now tries the real
  affordances in order (Close/Cancel in the app and in SpringBoard, a drag from the sheet's top
  edge, the dimmed backdrop, then a relaunch) and checks after each whether the surface is
  actually gone. Three failed escapes stop the run with `system-surface-unrecoverable` rather
  than silently spending the action budget. Verified on a simulator: the share sheet is caught
  at step 1, escaped, and the run goes on to explore 13 states across 6 screens with no
  blank/limited findings against Apple's UI.
- **iOS flow failures attach a failure screenshot**: `flow-failure-N.png` lands in the evidence
  directory like web and Android, instead of only inside the `.xcresult`. (#8)

## 0.17.14

- **`tapp audit <url>` — a read-only structural audit.** Flows hold known-good behaviour fixed;
  they cannot find a control that was *never* alive, because nobody writes a test for a button
  they believe does nothing. `audit` renders the page and reads the tree — it never clicks — so
  unlike `explore` it can be pointed at production, which is where dead controls actually live.
  It reports in-page links whose fragment target is absent from the DOM, `aria-controls` naming
  no element, placeholder links, and buttons with no handler, form, or link behind them.
  Exit 0 clean · 1 dead controls found · 2 usage. `--json` for agents. (#24)

- **Flow targets resolve inside same-origin iframes**: a modal rendered into an embedded
  same-origin frame was visibly on screen but invisible to a top-document-only search, so
  `wait_for` timed out on text the failure screenshot plainly showed. `tap`/`wait_for`/
  `assert_*` now search the top document first, then each same-origin frame; cross-origin
  third-party frames stay out of scope. The visible-labels hint reads frame text too. (#14)
- **A Flow that fails reports its cause, not a box border**: Playwright wraps guidance
  (“run `npx playwright install`”) in box-drawing art, and a scoreboard that kept one line of
  the error kept `╚════╝`. The cause now comes first and carries the actionable command, and a
  web Flow that dies before step 1 writes a structured report with a `harness` failure step
  instead of only stderr text. (#23)
- **`tapp flow run`/`validate` take several Flows or a glob**: `tapp flow run .tapp/flows/*.yml`
  replays them in sequence and prints one line per Flow with the failure cause, exiting 1 if any
  failed — the loop everyone was writing by hand. A quoted pattern is expanded too. (#9)
- **A verbose session `tree` is actually verbose**: the documented `verbose: true` was read as
  `full`, so it silently did nothing, and the control list capped at 8 entries regardless —
  hiding the fifth tab's label behind a coordinate tap. Both spellings now work and a verbose
  readout lists every control. (#9)
- **A loop the explorer itself drove is not an app finding**: "Navigation loop (period 2)" was
  filed for `Screen ↔ back` cycles the explorer created with its own back navigation. A loop is
  only reported when the explorer did not navigate backwards into it. (#9)

## 0.17.13

**A widget that loads late is not a dead link, and a finding that names a control shows it.**

- **`anchor_missing` re-checks before it accuses**: a third-party widget that injects its target
  element after the page's visible signature has gone quiet was reported as a confirmed dead
  anchor on a working page. Nothing in that wait shows a spinner, so one DOM snapshot cannot
  tell "genuinely dead" from "hasn't finished mounting". A candidate target is now polled for up
  to 4s before the finding is earned — free when the target is truly absent, and spent only on
  pages that have a candidate. A permanently missing target is still reported.
- **Findings that name a control carry that control as evidence**: `anchor_missing` and
  `placeholder_link` now attach an element-scoped screenshot, scrolled into view, of the control
  named in the finding — a generic top-of-page capture proves nothing about a link 1200px down
  the page. The HTML report renders it under the finding. An unlabeled placeholder link has no
  locatable target, so it carries no evidence rather than the wrong one.
- **Maintainers:** Releases now use GitHub Actions trusted publishing from the public mirror without an npm token. For the next release, bump the version in `package.json`, `package-lock.json`, `server.json`, `.claude-plugin/plugin.json` (both the `version` and the pinned `mcpServers` arg) and `vscode-extension/bridge.js` (`ENGINE_SPEC`) — `tests/agent-surface.test.js` enforces that they all match — and update `CHANGELOG.md`, commit on private `main`, then run `tools/sync-public.sh` to guard and push the allowlisted public snapshot. In the public checkout, run `git tag vX.Y.Z && git push origin vX.Y.Z`; that tag starts `publish-npm.yml`, which verifies the version, runs the unit tests, and publishes to npm with OIDC and provenance. After npm publication succeeds, create the GitHub Release for the tag; `publish-mcp.yml` then verifies the npm version and registers the MCP server.

## 0.17.12

**The flows-first gate exists** (field issues #11–#22 batch). ⚠️ Gate policy v5.

- **`--actions 0` is a flows-only gate**: reviewed Flows/Scenarios/Contracts replay with NO
  exploration — nothing autonomous touches the target (it may be production). All suites green
  → PASS; a deterministic suite failure → FAIL; an empty selection → INCONCLUSIVE. The report
  states plainly that exploration was not requested. (#11)
- **An explicitly small exploration budget scales the coverage floor to the request**: a
  `--actions 1` run that performed its one action is conclusive; five green Flows no longer
  read INCONCLUSIVE over a floor the budget could never meet. Undershooting even a tiny
  request (crash at launch) stays inconclusive. (#18)
- **A web Flow replays at its own `url:`** — the gate `--url` is a fallback, not an override —
  in a fresh browser context per Flow, and the report names the URL each Flow actually opened.
  (#13, #15)
- **Tap failures keep Playwright's diagnosable cause**: "click intercepted by
  `<div id="location-intake-modal">`" instead of a bare timeout. (#17)
- **`wait_for` budgets are configurable**: per-step `timeoutMs`/`timeout` (both platforms) and
  a flow-level default; wait/assert failures list the top visible labels so the report shows
  what WAS on screen. (#20)
- **`open --wait-for` timeouts still capture evidence**: the screenshot path and visible text
  are printed exactly when they matter most. (#22)
- **`tree`/`open` control labels read like a screen reader**: nested and shadow-DOM text,
  space-separated — `assert_exists: "$2,000"` can match a custom card button. (#19)
- **`doctor` checks PyYAML** (hosted macOS runners ship python3 without it) and a YAML Flow
  run without it exits with the one-line fix instead of a raw ModuleNotFoundError. (#16)
- Firebase's simulator "error accessing the keychain" login failure names the
  `simctl erase` fix. (#21)

## 0.17.11

**Typing into SwiftUI fields no longer races the keyboard** (field report from a coaching app's
pricing screen, 2026-09-19).

- **`type` waits for keyboard focus before it types**: the harness tapped a field and called
  `typeText` in the same breath. SwiftUI `TextField`s inside a `ScrollView` take focus a few hundred
  milliseconds after the tap, so the run died on XCTest's *Failed to synthesize event: Neither
  element nor any descendant has keyboard focus* — sometimes (the login screen never showed it; a
  pricing screen showed it 4 runs out of 5). `focusForTyping` now taps, polls `hasKeyboardFocus`
  for up to 1.2 s, and retries twice with coordinate taps before giving up. The session, Flow and
  login paths all go through it.
- **A field that never takes focus is a step failure, not a run abort**: `type` now reports
  `‘Session rate’ was found (frame …) but never took keyboard focus after 3 taps — no keyboard
  appeared` as the step detail (session protocol: `status: "focus_failed"` + `detail`) and the
  flow continues to its scoreboard instead of tearing the test down.
- **A run the harness abandons mid-way is FAILED, not "PASSED 16/16"**: when XCTest aborts after
  some steps (an assertion, the test time budget, a crash) there is no final result marker, and
  `flow run` used to shrink `total` to the steps that happened to run and print a green pass.
  The report now keeps the declared step count, appends a `harness` failure step carrying the
  XCTest reason, and exits 1 — the same treatment 0.17.10 gave runs that died before step 1.

## 0.17.10

**First field-report batch through the feedback channel** (public issues aarwitz/tapp#1–#9, filed
by an agent on a real iOS app the same afternoon the channel shipped).

- **iOS runs told the truth about credentials again (#3)**: the harness printed the
  `credentials_supplied` marker only when a flag the run config never carried was set, so every iOS
  explore reported `credentialsProvided: false` even after signing in. The marker is now decided by
  what actually reached the run, and the flag is forwarded too.
- **Native stops are honest (#5)**: an XCUITest run that ended on `limited_surface` reported
  `stopReason: "completed"`; it is now `limited-surface` (timeouts → `time-budget-exhausted`, crashes
  → `app-crashed`). iOS runs now emit `OCQA_CONTEXT` (device, window size, scale) so `captureContext`
  is populated on iOS as the 0.17.8 notes promised for web.
- **A Flow that validates can replay (#2)**: `tapp flow steps` prints the single step vocabulary
  (target semantics + pass condition; `assert_screen` is the screen *title*, `assert_exists` is
  "text is present"). `flow validate` and `flow run` now reject unknown actions (`click:` → use
  `tap:`), coordinate taps, and malformed `type`/`assert_text` steps with exit 2 before any target is
  launched.
- **A flow that dies before step 1 says why (#1)**: the scoreboard used to read
  `0 passed · 0 failed · 0/0 executed`; the XCTest reason (e.g. *Failed to synthesize event: Neither
  element nor any descendant has keyboard focus*) is now the first step's failure and `abortReason`
  in `flow-report.json`.
- **Malformed session acts are answered, not executed (#7)**: `tapp_session_act` validates the
  argument shape per action and returns `status: "usage"` with the accepted arguments (e.g.
  `{action:"wait", seconds:3}` → "wait takes {text|id, timeoutMs?}") without touching the driver or
  the session.
- **Feedback submission works for non-collaborators**: `gh issue create --label` is refused for
  accounts without triage rights; `--submit` now retries without labels and reports `labelsApplied`.
- Still open from the batch: share-sheet extensions scored as app defects (#4), session tap-by-id on
  system alerts reporting ok (#6), iOS flow failure screenshots (#8), flow glob mode / full tree /
  keep-app (#9). `tapp doctor` does not yet check the simulator's hardware-keyboard setting (#1).

## 0.17.9

- **Feedback channel for people and agents**: `tapp feedback "title" [--body …] [--type bug|idea|question]`
  and the `tapp_feedback` MCP tool draft a GitHub issue on `aarwitz/tapp` with the version, platform
  availability (from `doctor --json`), and latest capture id filled in, home paths and tokens redacted.
  Drafts by default; `--submit` / `submit: true` files it through the authenticated `gh` CLI. Exit
  codes 0 drafted-or-filed · 1 submission failed · 2 usage. The Agent Skill now tells agents to report
  tapp friction this way (with user consent, since issues are public).

**The credential lock actually engages.** Field report № 8 found 0.17.8's catalogue-and-stop
inert in practice: the iOS run config baked in default credentials, so the harness never saw
an empty credential set.

- `quick-capture.sh` no longer invents `qa@example.com` / `Tapp123!`: the harness receives
  the caller's credentials or an empty value. Signed-out runs now genuinely catalogue login
  surfaces without typing, submitting, or opening recovery/third-party-auth flows. A
  regression guard pins that the config writers carry no invented account.
- `explore --baseline` prints the capture-mismatch warning and stamps
  `regression.captureMismatch`, matching the CI gate — this is the command the report JSON
  hint tells people to use.

## 0.17.8

**Native exploration honesty: catalogue-only credential surfaces, truthful stops, left-app
observations.** ⚠️ Behavior change for iOS exploration.

- **Credential surfaces are catalogue-only without credentials (parity with web)**: with no
  `testEmail`/`testPassword`, iOS exploration records a login/signup form's fields but no
  longer types sample values, taps Sign In, or opens password-reset / third-party-auth flows —
  a bare-app run may be pointed at production. Supplying credentials remains the explicit
  opt-in that enables the sign-in attempt.
- **Leaving the app is an observation, not a defect**: a tap that hands off to a system
  surface or another app records a `left_app` trace entry and returns to the app under test,
  instead of misreporting `app_hang` + `blank_screen` on an "Unknown" screen.
- **The native explorer reports why it stopped**: `COMPLETE` now carries
  `stop: action-budget | time-budget | frontier-drained | navigation-trap | app-crashed |
  auth-cycle-complete | stuck-no-progress | left-app-unrecovered`, and the report passes
  non-budget causes through verbatim — a 15/20 run no longer reads as "completed".
- **`init --dry-run --refresh` previews the merged plan**: reviewed decisions from the
  existing plan are merged into the preview (pure, no writes), so a dry run no longer claims
  approvals would revert to pending.
- **The capture stamp survives in explore JSON as `captureContext`**: exploration output
  already used `capture` for the evidence-folder record, which clobbered the 0.17.7
  device/viewport stamp in exactly the file passed as `--baseline`. The stamp now lives at
  `captureContext` everywhere (gate JSON, explore JSON, mismatch warning); gates still read a
  0.17.7 baseline's old key when it is a real stamp.
- **`tapp ci --device`/`--viewport` mean the same as `explore` on web gates**: a web gate
  renders at the requested Playwright profile or WxH viewport instead of silently ignoring the
  flag (on iOS `--device` still selects the simulator; android refuses both).

## 0.17.7

**Comparable evidence — gate policy v4.** ⚠️ Behavior change for web gates.

- **`outbound_unavailable` now gates**: promoted to medium severity and the deterministic tier.
  Since 0.17.6 the outbound audit renders each link in the live browser, so a 200-but-
  "content isn't available" shell (dead Facebook/Instagram links) is a stable observation —
  under the web `--fail-on medium` default it now fails the gate like any other broken link.
- **Capture conditions are on record**: web runs stamp `capture` (device, viewport, scale
  factor) on the report root, the HTML evidence page, and the gate summary line. A
  `--baseline` diff across different captures prints a capture-mismatch warning — a phone run
  "resolving" desktop nav findings is a layout difference, not a fix — and stamps
  `regression.captureMismatch` in the JSON.
- The gate banner prints the target URL/bundle instead of the application-model hash (the
  stable id remains on `targetKey` for baseline identity).
- Screen readouts count `Link` controls as links: "14 links · 6 buttons", not "20 buttons".
- **Agent-scriptable CLI surface**: `tapp doctor --json` emits a structured environment
  report (per-platform availability, booted simulator, harness cache; exit 0 healthy /
  1 blocked), and `flow run` / `contract run` / `scenario run` help now documents the
  outcome contract (0 passed · 1 failed · 2 infrastructure/usage error).

## 0.17.6

**The gate tells the truth — policy v3.** ⚠️ Behavior change for web gates.

- **Web targets now default to `--fail-on medium`**: any deterministic finding at medium
  severity or above (broken links, missing anchors, unresolvable outbound hosts, undeliverable
  mailto domains, missing assets) fails the gate. On a website, a 404 in the nav IS the release
  blocker. Restore the previous baseline-diff behavior with `--fail-on gate`. New severity
  policies `--fail-on high|medium` are available on every platform.
- **A green PASS states what it ignored**: "PASS — N deterministic finding(s) below the fail
  threshold (…)" instead of silence over known findings.
- `tapp ci` run inside an initialized repository now connects to it: `.tapp/application-model.json`
  supplies the platform (when unambiguous) and target identity without `--project-dir`.
  A web gate with no target exits 2 with guidance instead of an uncaught stack trace, and
  `ci --help` speaks in `tapp ci` terms.
- The outbound link audit runs inside the live browser: client-rendered "content isn't
  available" shells are now visible, navigation honors the egress proxy, and findings are
  attributed to the page that carried the link. A truncating per-page probe cap reports
  `probe-cap-reached` instead of claiming no controls remain.
- `tree`/`open` list `<details>/<summary>` toggles, type links faithfully as `Link`, carry
  bounding rects, and mark truncated control lists; the per-action trace renders in
  `report.html`.

## 0.17.5

**Web field-report fixes: mobile rendering, honest stop reasons, and a complete link audit.**

- Render web commands (`open`, `tree`, `explore`, `flow run`, MCP sessions) at any Playwright
  device profile with `--device "iPhone 13"` or an explicit `--viewport 390x844`; `open` gains
  `--full-page` screenshots. One shared context seam replaces five hardcoded desktop viewports.
- Report why exploration stopped: `completed` is reserved for an exhausted action budget, a
  drained frontier reports `no-unexplored-in-scope-controls`, and wall-clock exhaustion on web is
  `time-budget-exhausted` instead of silently reading as complete. The JSON report carries a
  timestamped per-action `trace` (type, target, screen, offset).
- Audit the deterministic link cases a static site actually breaks on: anchors to missing ids,
  outbound hosts that do not resolve, `mailto:` domains with no MX or address record, and
  outbound pages returning 200 with unmistakable "content isn't available" copy (advisory, never
  a gate failure). Outbound checks are capped, stated honestly, and disabled under the
  public-egress policy.
- Exercise `<details>/<summary>` disclosure controls, state the same-origin crawl boundary in the
  scope block, and report catalogued-but-unsubmitted forms as not checked.
- The field report's own eight-case fixture page ships as an end-to-end regression test (8/8).

## 0.17.4

**Field-report fixes: every filed finding from the first real adoption sessions is closed.**

- Keep the release plan honest across refreshes: a decided proposal whose generated id drifted, or
  whose scope is no longer derived at all, regrounds onto the surviving same-name item (recorded
  via `regroundedFromScope`) or drops as a duplicate instead of lingering as a stale copy beside a
  re-added pending twin. Committed and promoted items always carry.
- Apply a successful build's scheme confirmation to a single-iOS-target repository even when the
  build resolved a different Xcode container than the model, so `init --refresh` stops re-blocking
  on an already-confirmed scheme.
- Resolve Flow replay credentials from a configured actor's environment-variable bindings
  (`tapp flow run FILE --actor NAME`, MCP `actor`); explicit values still win, and a bound but
  unset variable refuses the run instead of replaying with placeholders.
- Let coordinate taps fall back to a labelled control that reports itself non-hittable at its own
  center (custom tab bars), routing into the harness's retrying element tap instead of a dead raw
  coordinate tap — containers are never hijacked.
- Add a full raw session tree (`tree` with `full: true`), exclude date ranges such as week headers
  from auto-recorded wait targets, and pin the managed web port with `web.port` in
  `.tapp/project.json` for CORS-exact origins (busy or contradicted pins fail loudly; the host
  stays 127.0.0.1).
- Document the cold-launch session contract (fresh sessions show an app's login wall; CLI
  inspection warm-resumes), stderr consumption for raw stdio MCP clients, first-session harness
  build time, and `actor set --replace` on the agent-facing surfaces.

## VS Code 0.3.8

- Bundle the field-fix Agent Skill and pin the extension engine to Tapp 0.17.4, bringing the
  closed field-report findings (session cold-launch guidance, full raw session trees, coordinate
  tap fallback, actor-resolved Flow credentials) to Copilot users.

## 0.17.3

**Public proof and a safer first contact.**

- Replace abstract product claims with inspectable evidence from real Tapp runs: a source-aware
  focused iOS route, an autonomous simulator recording, and a sanitized full web report.
- Fix the website's permission-sensitive copy control and placeholder home link, add accessible
  focus states and demand-loaded media, and publish a professional product mark and social card.
- Add privacy-conscious structured intake for reproducible bugs and a small paid founding pilot.
  The pilot covers hands-on onboarding, important-journey setup, and CI integration while the
  open-source engine continues to run in infrastructure the customer controls.

## VS Code 0.3.7

- Add a professional Marketplace icon and real cross-surface proof to the listing.
- Bundle the current Agent Skill and pin the extension engine to Tapp 0.17.3.

## 0.17.2

**One source-connected focused command across web, iOS, and Android.**

- Let bare `tapp focus` reuse the target reviewed during `init`, build or start it from source, and
  stop with exact `--target` choices instead of guessing when a repository remains ambiguous.
- Keep owned web focus sessions alive for the complete CLI/MCP interaction and reliably stop the
  managed server when the session ends or startup fails.
- Build, install, and focus modeled Android modules without requiring callers to supply an APK,
  application id, platform flag, `JAVA_HOME`, or SDK-root variables when standard installations are
  discoverable. `tapp doctor` reports source-build readiness separately from prebuilt-APK testing.
- Preserve the source-plus-observed-map authority boundary: source locates the requested surface,
  while only previously observed route edges authorize fast navigation.

## VS Code 0.3.6

- Bundle the source-preparing cross-platform Agent Skill and pin the extension engine to Tapp
  0.17.2. The extension's native preview/tools remain iOS-specific; Android and web use the same
  bundled Skill through the CLI or MCP.

## 0.17.1

**Faster source-connected agent navigation and cleaner evidence.**

- Add `tapp focus` / `tapp_focus`: source locates the requested screen or control, the previously
  observed UI Map authorizes the shortest route, and the real target supplies the final evidence.
- Let web, iOS, and Android MCP sessions accept a focused goal during startup, reducing known-screen
  navigation to one tool call before the requested final interaction.
- Start iOS recordings and VS Code preview frames only after the rebuilt app is foregrounded and
  settled, excluding installation and SpringBoard setup from application evidence.
- Share the proven native sign-in field finder with deterministic Flow replay and retain real
  failure evidence instead of printing paths that were never written.
- Make invalid CLI verbs fail as usage errors, clarify Skill/CLI versus MCP capabilities, and align
  the package, Agent Skill, Action examples, website, and internal product map on one contract.

## VS Code 0.3.5

- Add the source-connected `tapp_ios_focus` tool and let app startup accept a focused goal, so
  Copilot can reach an observed screen or control without wandering through the app.
- Wait for the rebuilt app to be foregrounded and visually settled before the simulator preview
  begins refreshing, keeping installation and SpringBoard setup out of the evidence surface.
- Bundle the updated canonical Tapp Agent Skill and pin the extension engine to Tapp 0.17.1.

## VS Code 0.3.4

- Bundle the stable Tapp Agent Skill and pin the extension engine to Tapp 0.17.0.

## 0.17.0

**A repository-connected agent testing product for iOS, Android, and web.**

- Let coding agents install one concise Tapp skill, discover repository targets, operate real app
  surfaces, save visual evidence, and turn reviewed behavior into replayable Flows and contracts.
- Keep autonomous exploration observational and scoreless; reserve `pass | fail | inconclusive`
  for the deterministic, repository-connected gate with explicit checked/not-checked scope.
- Support source-preparing web, iOS simulator, and Android emulator/device targets, including
  multi-target selection, managed web runtimes, stable target-scoped baselines, and CI installation.
- Harden fresh-machine, package, report-provenance, login, runtime-lifecycle, and agent-surface
  behavior through the rc.1–rc.16 qualification campaign and three-platform hosted matrix.

## 0.17.0-rc.16

- Preserve the selected repository target identity when the plain `tapp ci` command derives one
  conclusive platform target from `.tapp/application-model.json`, so its first successful report
  can be saved directly as a target-scoped baseline.
- Refuse to guess when a repository contains multiple matching targets; callers must select a
  stable target explicitly. The GitHub Action's explicit target identity remains authoritative.

## VS Code 0.3.3

- Describe the simulator panel accurately as an auto-refreshing screenshot preview, not a live
  embedded Simulator or video stream.
- Keep the bundled Agent Skill and npm engine aligned with Tapp 0.17.0-rc.15.

## 0.17.0-rc.15

**One product story across every public surface, plus the field-test fixes held after rc.14.**

- Present Tapp consistently as agent-driven app testing for iOS simulators, Android
  emulators/devices, and browser apps: real screens, replayable Flows, and deterministic CI gates.
  Lead with the open Agent Skill, keep the direct npm journey to one line, and state the unsupported
  Windows desktop boundary explicitly.
- Keep exploration honest: it reports findings, coverage, evidence, and limits; only the
  repository-connected gate returns `pass`, `fail`, or `inconclusive`.
- Add portable presentation-contract tests covering the README, website, package, CLI help, Claude
  plugin, MCP Registry, GitHub Action, and VS Code metadata. The staged-public guard verifies the
  same identity from a clean tarball install.
- Add atomic, secret-templated login recording/replay across iOS, Android, and web; a complete
  `tapp flow example`; disk-space preflight; non-TTY-safe progress; accurate auth-coverage metadata;
  and automatic Application Model refresh after successful builds or actor updates.
- Improve report provenance and checked/not-checked recovery, managed-web lifecycle diagnostics,
  and first-user failure guidance without requiring a global executable.

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

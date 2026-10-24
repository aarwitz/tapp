import { customerProductContract } from "./product-contract.js";
import { classifyPrompt, narrate, narrateFinding, operationIsPending, summarize } from "./view-model.js";

const API_BASE = String(document.querySelector('meta[name="tapp-api-base"]')?.content || "").replace(/\/$/, "");
const LOGIN_URL = String(document.querySelector('meta[name="tapp-login-url"]')?.content || "");
function apiRoute(route) {
  if (!API_BASE) return route;
  if (route === "/api" || route.startsWith("/api/")) return `${API_BASE}${route.slice(4)}`;
  if (route === "/evidence" || route.startsWith("/evidence/")) return `${API_BASE}${route}`;
  return route;
}

const state = {
  csrf: "", session: null, project: null, audits: [], explores: [], activeJob: null, activeView: "overview",
  selectedTargetId: "", selectedRunId: "", live: { active:false }, transcript: [], transcriptSource: "", frameTimer: null, pendingInput: null,
  chatCollapsed: false, shotScreens: new Set(), lastShotAt: 0,
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[character]));
const pretty = (value) => String(value || "").replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const compactDate = (value) => value ? new Intl.DateTimeFormat(undefined, { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" }).format(new Date(value)) : "—";
const chatTime = (value) => new Intl.DateTimeFormat(undefined, { hour:"numeric", minute:"2-digit" }).format(new Date(value));

function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast${error ? " error" : ""}`;
  clearTimeout(node._timer);
  node._timer = setTimeout(() => node.classList.add("hidden"), 6000);
}

async function api(route, options = {}) {
  const mutation = options.method && options.method !== "GET";
  const headers = { ...(options.body !== undefined ? { "content-type":"application/json" } : {}), ...(mutation ? { "x-tapp-csrf":state.csrf } : {}), ...(options.headers || {}) };
  const response = await fetch(apiRoute(route), { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && LOGIN_URL) {
    location.replace(LOGIN_URL);
    throw Object.assign(new Error("Sign in to continue"), { status:401, code:"authentication-required" });
  }
  if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { status: response.status, code: data.code });
  return data;
}

function captureId(report) {
  const values = [report?.relativeMarkersFilePath, report?.uiMap?.path, report?.reportHtml, report?.recording, report?.capture?.path].filter(Boolean);
  for (const value of values) {
    const match = String(value).replaceAll("\\", "/").match(/\/captures\/([^/]+)/);
    if (match) return match[1];
  }
  return report?.capture?.id || "";
}
const captureUrl = (id, file = "report.html") => apiRoute(`/evidence/captures/${encodeURIComponent(id)}/${file}`);
function evidenceLink(id, label = "Open visual evidence") {
  return id ? `<a class="button-link" href="${esc(captureUrl(id))}" target="_blank" rel="noreferrer">${esc(label)}</a>` : "";
}
function reportLink(report, label) { return evidenceLink(captureId(report), label); }

function currentTarget() { return (state.project?.targets || []).find((target) => target.id === state.selectedTargetId) || null; }
function targetStorageKey() { return `tapp:selected-target:${state.project?.repository?.id || "none"}`; }
// A run started from the prompt is on its own platform, whatever repository happens to be open.
function currentPlatform() { return state.live?.active ? state.live.platform : (state.promptRun && state.promptPlatform) || currentTarget()?.platform || state.promptPlatform || ""; }

function chooseDefaultTarget() {
  const targets = state.project?.targets || [];
  if (targets.some((target) => target.id === state.selectedTargetId)) return;
  const remembered = localStorage.getItem(targetStorageKey());
  if (remembered && targets.some((target) => target.id === remembered)) state.selectedTargetId = remembered;
  else state.selectedTargetId = targets.length === 1 ? targets[0].id : "";
}

function operationPayload(extra = {}) {
  const target = currentTarget();
  return {
    ...(target ? { target:target.id, platform:target.platform } : {}),
    ...(target?.platform === "android" && $("#android-serial")?.value.trim() ? { serial:$("#android-serial").value.trim() } : {}),
    ...extra,
  };
}

function activateView(view) {
  if (!customerProductContract.views.some((item) => item.id === view)) view = "overview";
  state.activeView = view;
  $$('[data-view-panel]').forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === view));
  $$('.primary-nav [data-view]').forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  history.replaceState(null, "", `#${view}`);
  window.scrollTo({ top:0, behavior:"instant" });
}

// A hosted Studio has no Mac, no simulator and no access to the visitor's disk, so folders,
// bundle ids and builds cannot work there however the prompt is worded. Offer only what this
// deployment can actually do, and say where the rest runs, rather than failing after the ask.
// On a public Studio a person is a visitor until they sign in, and an account after. Both slots
// (prompt screen and sidebar) show the same thing. A local Studio has neither: the one person at
// the keyboard is the operator.
function renderAccount() {
  const session = state.session || {};
  const isPublic = session.access === "anonymous" || session.access === "account";
  for (const slot of document.querySelectorAll("#account-slot, #account-slot-side")) {
    slot.classList.toggle("hidden", !isPublic);
    if (!isPublic) continue;
    slot.innerHTML = session.access === "account"
      ? `<span class="account-email" title="${esc(session.email || "")}">${esc(session.email || "")}</span><button type="button" data-signout>Sign out</button>`
      : `<button type="button" class="primary" data-signin>Sign in</button>`;
  }
  $("#signin-card")?.classList.toggle("hidden", session.access !== "anonymous" || !state.signInOpen);
  renderSignInOptions();
}

// The ways in this deployment actually offers. A button with nothing configured behind it is
// never shown, so the card can never promise a sign-in that cannot happen.
function renderSignInOptions() {
  const slot = $("#signin-providers");
  if (!slot) return;
  const providers = (state.session?.signInOptions || []).filter((option) => option.kind !== "email");
  slot.innerHTML = providers.map((option) => `<a class="signin-provider ${esc(option.kind)}" href="/auth/${esc(option.kind)}">${providerMark(option.kind)}<span>${esc(option.label)}</span></a>`).join("")
    + (providers.length ? '<div class="signin-or"><span>or</span></div>' : "");
}

function providerMark(kind) {
  if (kind === "google") return '<svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true"><path fill="#4285F4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.4h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5z"/><path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2a5.4 5.4 0 0 1-8.1-2.8H1v2.3A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.9 10.7a5.4 5.4 0 0 1 0-3.4V5H1a9 9 0 0 0 0 8l2.9-2.3z"/><path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3L15 2.3A9 9 0 0 0 1 5l2.9 2.3A5.4 5.4 0 0 1 9 3.6z"/></svg>';
  if (kind === "github") return '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0a8 8 0 0 0-2.5 15.6c.4.1.5-.2.5-.4v-1.4C3.8 14.2 3.3 13 3.3 13c-.4-1-.9-1.2-.9-1.2-.8-.5 0-.5 0-.5.8.1 1.3.9 1.3.9.7 1.2 1.9.9 2.4.7 0-.6.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-3.9 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.6 7.6 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.5 1.1.2 1.9.1 2.1.5.5.8 1.2.8 2.1 0 3-1.8 3.7-3.6 3.9.3.3.5.8.5 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 8 0z"/></svg>';
  return "";
}

async function requestSignInLink(email) {
  const button = $("#signin-send");
  if (button) button.disabled = true;
  try {
    await api("/api/auth/link", { method:"POST", body:JSON.stringify({ email }) });
    $("#signin-form")?.classList.add("hidden");
    const sent = $("#signin-sent");
    if (sent) { sent.textContent = `Check your email — a sign-in link is on its way to ${email}. It works once, for 15 minutes.`; sent.classList.remove("hidden"); }
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function signOut() {
  try { await api("/api/auth/signout", { method:"POST", body:"{}" }); } catch { /* the cookie is gone either way */ }
  location.replace("/");
}

function applyAccessMode() {
  const session = state.session || {};
  renderAccount();
  if (session.access !== "anonymous" && session.access !== "account") return;
  const signedIn = session.access === "account";
  const accepts = new Set(session.accepts || ["url"]);
  for (const button of document.querySelectorAll("[data-kind]")) {
    const kind = button.dataset.kind;
    const usable = kind === "url" ? accepts.has("url") : accepts.has(kind);
    button.closest("li")?.classList.toggle("hidden", !usable);
  }
  const input = $("#prompt-input");
  if (input) input.placeholder = "A website URL…";
  // Everything that only means something against a source repository: a target to build, a
  // runner, a release gate, a decision. A hosted visitor auditing a URL has none of them, and
  // showing the empty frames makes a working run look like a broken one.
  for (const node of document.querySelectorAll("[data-repo-only]")) node.classList.add("hidden");
  // "What the last run proved" reports a release decision. A read-only website audit never
  // produces one, so the panel can only ever say "No run yet" here.
  document.querySelector(".summary-panel")?.classList.add("hidden");
  // refreshSession() runs on every poll, so this must not overwrite a heading the current run
  // already set — that is what made "Website audit" revert to "tapp" when a run finished.
  if (!state.headingOwnedByRun) setHeading("tapp", signedIn ? "Give it a website. If there is a sign-in, I will ask you for a test account and remember it." : "Give it a public website and it will audit the pages read-only.");
  const note = $("#privacy-note-detail");
  if (note) note.textContent = signedIn
    ? "Websites are explored in the cloud. Test accounts you give tapp are kept encrypted, used only to sign in, and never shown again. iOS, Android and folders on your own machine need tapp there: npx -y @aarwitz/tapp@latest app"
    : "Websites are audited read-only in the cloud; nothing is clicked. Sign in to go inside a site. iOS, Android and folders on your own machine need tapp there: npx -y @aarwitz/tapp@latest app";
  $("#actors-panel")?.classList.toggle("hidden", !signedIn);
  $("#journeys-panel")?.classList.toggle("hidden", !signedIn);
  $("#agent-panel")?.classList.toggle("hidden", !signedIn);
}

// The test accounts tapp holds, by application — names and what is held, never a value.
function renderActors() {
  const node = $("#actors-list");
  if (!node) return;
  const apps = state.actors || [];
  const total = apps.reduce((sum, app) => sum + app.actors.length, 0);
  setCount("#actor-count", total);
  if (!total) { node.innerHTML = '<div class="empty">None yet. Explore a site with a sign-in and tapp will ask.</div>'; return; }
  node.innerHTML = apps.map((app) => `<div class="actor-app">${esc(app.host)}</div>${app.actors.map((actor) => {
    const held = [actor.hasCredentials ? "password set" : "", actor.hasSession ? `signed-in session · ${compactDate(actor.sessionSavedAt)}` : ""].filter(Boolean).join(" · ") || "nothing held";
    return `<div class="actor-row"><span><strong>${esc(actor.actor)}</strong><br><small>${esc(held)}</small></span><span></span><button class="quiet" type="button" data-forget-host="${esc(app.host)}" data-forget-actor="${esc(actor.actor)}">Forget</button></div>`;
  }).join("")}`).join("");
}

// Tokens are labels and dates here; the value exists once, in the card below, and never again.
function renderTokens() {
  const node = $("#token-list");
  if (!node) return;
  const tokens = state.tokens || [];
  setCount("#token-count", tokens.length);
  const reveal = state.newToken ? `<div class="token-reveal">
      <p><b>Copy this now — it is not shown again.</b> Give your coding agent these two values:</p>
      <code id="token-value">export TAPP_STUDIO=${esc(location.origin)}
export TAPP_TOKEN=${esc(state.newToken.token)}</code>
      <p>Then it can ask <code style="display:inline;padding:2px 5px">tapp report --journeys</code> and replay one with <code style="display:inline;padding:2px 5px">tapp run &lt;journey&gt;</code>.</p>
      <div class="ask-actions"><button type="button" class="primary" data-copy-token>Copy</button><button type="button" class="quiet" data-dismiss-token>Done</button></div>
    </div>` : "";
  const rows = tokens.length
    ? tokens.map((token) => `<div class="token-row"><span><strong>${esc(token.label)}</strong><br><small>created ${esc(compactDate(token.createdAt))}${token.lastUsedAt ? ` · last used ${esc(compactDate(token.lastUsedAt))}` : " · never used"}</small></span><button class="quiet" type="button" data-revoke-token="${esc(token.id)}">Revoke</button></div>`).join("")
    : '<div class="empty">No tokens yet.</div>';
  node.innerHTML = reveal + rows;
}

async function loadTokens() {
  if (state.session?.access !== "account") { state.tokens = []; return; }
  state.tokens = (await api("/api/tokens").catch(() => ({ tokens: [] }))).tokens || [];
}

async function createToken() {
  const label = (prompt("What is this token for?", "coding agent") || "").trim();
  if (label === "") return;
  try {
    state.newToken = await api("/api/tokens", { method: "POST", body: JSON.stringify({ label }) });
    await loadTokens();
    renderTokens();
  } catch (error) { toast(error.message, true); }
}

async function revokeToken(id) {
  await api(`/api/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
  state.newToken = null;
  await loadTokens();
  renderTokens();
  toast("Revoked. That agent can no longer act as you.");
}

async function forgetActor(host, actor) {
  await api(`/api/actors/${encodeURIComponent(host)}/${encodeURIComponent(actor)}`, { method:"DELETE" });
  state.actors = (state.actors || []).map((app) => app.host === host ? { ...app, actors: app.actors.filter((a) => a.actor !== actor) } : app).filter((app) => app.actors.length);
  renderActors();
  toast(`Forgot ${actor} on ${host}. tapp will ask again next time.`);
}

// Someone who already owns journeys comes back to check on them, not to start something new —
// and the prompt screen is the whole page until a run happens. Give them the way in.
function renderOwnedLink() {
  const slot = $("#owned-link");
  if (!slot) return;
  const journeys = state.journeys?.length || 0;
  const show = state.session?.access === "account" && journeys > 0;
  slot.classList.toggle("hidden", !show);
  if (show) slot.innerHTML = `<button type="button" class="quiet" data-open-owned>You have ${journeys} journey${journeys === 1 ? "" : "s"} — see how they are doing →</button>`;
}

function showPrompt() {
  $("#source-onboarding").classList.remove("hidden");
  $("#product-shell").classList.add("hidden");
  setTimeout(() => $("#prompt-input")?.focus(), 50);
}

function showProduct() {
  $("#source-onboarding").classList.add("hidden");
  $("#product-shell").classList.remove("hidden");
}

function renderRepositoryChrome() {
  const repositories = state.session?.repositories || [];
  const current = state.project?.repository || state.session?.repository;
  const switcher = $("#repository-switcher");
  switcher.classList.toggle("hidden", repositories.length < 2);
  switcher.innerHTML = repositories.map((repository) => `<option value="${esc(repository.id)}" ${repository.id === current?.id ? "selected" : ""}>${esc(repository.name)}</option>`).join("");
  $("#refresh-project").classList.toggle("hidden", !current);
  if (!current) return;
  $("#sidebar-project-name").textContent = state.project?.application?.name || current.name;
  $("#sidebar-project-source").textContent = current.source?.label || current.root || "Repository";
  $("#project-avatar").textContent = (state.project?.application?.name || current.name || "T").slice(0, 1).toUpperCase();
}

function setCount(id, value) {
  const node = $(id);
  node.textContent = value;
  node.classList.toggle("zero", !value);
}

function renderTargets() {
  const targets = state.project?.targets || [];
  chooseDefaultTarget();
  const requiresChoice = targets.length > 1 && !currentTarget();
  $("#target-stage").classList.toggle("requires-choice", requiresChoice);
  $("#target-choice-callout").classList.toggle("hidden", !requiresChoice);
  $("#targets").innerHTML = targets.length ? targets.map((target) => {
    const selected = target.id === state.selectedTargetId;
    const detail = target.platform === "ios" ? `${target.build?.proposedScheme || "scheme unresolved"} · ${target.runtime?.surface || "iOS Simulator"}`
      : target.platform === "android" ? `${target.runtime?.applicationId || "application id unresolved"} · ${target.build?.task || "assembleDebug"}`
      : `${target.runtime?.management || "runtime unresolved"} · ${target.build?.start || target.build?.tool || "web"}`;
    return `<button type="button" class="target-card ${selected ? "selected" : ""}" data-target-id="${esc(target.id)}" aria-pressed="${selected ? "true" : "false"}"><span class="platform-icon ${esc(target.platform)}">${esc(target.platform === "ios" ? "" : target.platform === "android" ? "▲" : "⌁")}</span><span><strong>${esc(target.name)}</strong><small>${esc(pretty(target.platform))} · ${esc(detail)}</small></span><em class="target-state ${esc(target.status || "")}">${esc(pretty(target.status || "detected"))}</em></button>`;
  }).join("") : (state.project?.state?.inspected ? '<div class="empty">No iOS, Android or web target was detected in this repository.</div>' : '<div class="empty">Inspecting the repository for iOS, Android and web targets…</div>');
  const target = currentTarget();
  $("#target-status").textContent = target ? `${pretty(target.platform)} · ${target.name}` : targets.length > 1 ? "Selection required" : "No target selected";
  $("#sidebar-target").textContent = target ? `${pretty(target.platform)} · ${target.name}` : "Select a target";
  $("#sidebar-runner").textContent = target ? (state.session?.runners?.find((runner) => runner.platform === target.platform)?.label || "Runner resolves at execution") : "Runner not selected";
  const appId = target?.runtime?.bundleId || target?.runtime?.applicationId || target?.build?.bundleId || "";
  $("#sidebar-app-row").classList.toggle("hidden", !appId);
  $("#sidebar-app-id").textContent = appId;
  renderDeviceChrome();
  $("#runtime-row").classList.toggle("hidden", !targets.length);
  $("#serial-field").classList.toggle("hidden", target?.platform !== "android");
  $("#explore").disabled = !target;
  $("#command-run").disabled = !target || !!state.activeJob;
  $("#run-gate").disabled = !target || !!state.activeJob;
  $("#explore").textContent = target && targets.length > 1 ? `Build & explore ${target.name}` : "Build, launch & explore";
  $("#start-session").disabled = !target || state.live?.active === true;
  $("#explore-help").textContent = !target ? (targets.length > 1 ? `Choose one of the ${targets.length} detected targets. Tapp will not select one for you.` : "A runnable target is needed first.")
    : target.platform === "ios" ? "Builds the selected scheme for an iOS simulator, installs it, then explores."
    : target.platform === "android" ? "Builds the selected Gradle application, installs its APK, then explores."
    : "Builds and starts the selected repository web application, then explores it in Chromium.";
}

// The device frame takes the platform's real shape: a phone is tall, a browser is wide. The stage
// gives it every pixel it can, so the frame class drives the aspect ratio and the stage the size.
function renderDeviceChrome() {
  const platform = currentPlatform();
  const target = currentTarget();
  $("#device-frame").className = `device-frame ${platform || "ios"}`;
  $("#stage").className = `stage ${platform || "ios"}`;
  $("#device-feed-label").textContent = platform === "android" ? "Android" : platform === "web" ? "Chromium" : "iPhone";
  $("#device-meta-device").textContent = platform === "ios" ? ((!state.promptRun && target?.runtime?.surface) || "iOS Simulator")
    : platform === "android" ? (target?.runtime?.serial || "Android emulator / device")
    : platform === "web" ? "Local Chromium" : "—";
}

// The device panel shows whichever real surface exists right now: an interactive session's frame,
// else the newest screenshot the running operation wrote. Nothing is synthesized.
function frameSource() {
  if (state.live?.active) return "/api/live-session/frame";
  if (state.activeJob && state.jobHasFrame) return `/api/jobs/${state.activeJob}/frame`;
  return "";
}

function refreshLiveFrame() {
  clearTimeout(state.frameTimer);
  const source = frameSource();
  if (!source) { stopLiveFrames(); return; }
  const image = $("#live-frame-image");
  const loading = $("#live-frame-loading");
  $("#device-placeholder").classList.add("hidden");
  if (!image.naturalWidth) loading.classList.remove("hidden");
  image.onload = () => { loading.classList.add("hidden"); scheduleLiveFrame(); };
  image.onerror = () => { loading.textContent = "Live frame could not be captured. The semantic controls remain available."; scheduleLiveFrame(); };
  image.src = apiRoute(`${source}?at=${Date.now()}`);
}
function scheduleLiveFrame() { clearTimeout(state.frameTimer); if (frameSource()) state.frameTimer = setTimeout(refreshLiveFrame, 1500); }
function stopLiveFrames() { clearTimeout(state.frameTimer); state.frameTimer = null; }

function renderLiveSession() {
  const live = state.live || { active:false };
  $("#live-session-panel").classList.toggle("hidden", !live.active);
  if (!live.active) {
    if (!frameSource()) stopLiveFrames();
    const hasFrame = !!$("#live-frame-image").getAttribute("src");
    $("#live-frame-loading").classList.toggle("hidden", hasFrame || !frameSource());
    $("#device-placeholder").classList.toggle("hidden", hasFrame);
    // While a run is starting there is genuinely nothing to show yet — a browser is launching —
    // but telling someone to "run a release check" while their run is already going reads as
    // though nothing happened. Say what is actually true.
    const waiting = !!state.activeJob && !hasFrame;
    const title = $("#device-placeholder-title");
    const detail = $("#device-placeholder-detail");
    if (title) title.textContent = waiting ? "Opening the browser…" : "No live feed yet";
    if (detail) detail.textContent = waiting
      ? "The first screen appears here as soon as the page is rendered."
      : "Run a release check or open a live session to see the real application here.";
    if (!state.activeJob) $("#live-screen-title").textContent = hasFrame ? $("#live-screen-title").textContent : "—";
    renderDeviceChrome();
    return;
  }
  renderDeviceChrome();
  $("#live-screen-title").textContent = live.screenTitle || live.targetName || "Running target";
  $("#live-platform").textContent = `${pretty(live.platform)} · ${live.targetName || "live target"}`;
  $("#live-recorded-steps").textContent = `${live.recordedSteps || 0} recorded step${live.recordedSteps === 1 ? "" : "s"}`;
  $("#save-live-flow").disabled = !live.recordedSteps;
  const controls = (live.elements || []).filter((element) => element.label || element.id);
  $("#live-control-count").textContent = `${controls.length} available`;
  $("#live-control-list").innerHTML = controls.length ? controls.map((element, index) => {
    const target = element.id || element.label;
    const input = element.role === "input" || element.secure || /input|textfield|edittext|textarea|secure/i.test(element.type);
    return `<button class="live-control" data-live-control="${index}" data-live-target="${esc(target)}" data-live-input="${input ? "true" : "false"}" ${element.enabled === false || (!element.hittable && !input) ? "disabled" : ""}><span><strong>${esc(element.label || element.id)}</strong><small>${esc(element.id || "No stable identifier")} · ${esc(element.type || element.role || "control")}</small></span><em>${input ? "fill" : element.clickable ? "tap" : "inspect"}</em></button>`;
  }).join("") : '<div class="empty">The current screen exposed no semantic controls. Add accessibility identifiers to the app to drive it here.</div>';
  refreshLiveFrame();
}

function renderRequirements() {
  const requirements = state.project?.requirements || [];
  $("#requirements").innerHTML = requirements.length ? `<ul class="requirements">${requirements.map((item) => `<li class="${item.severity === "blocking" ? "blocking" : ""}"><span>${item.severity === "blocking" ? "!" : "i"}</span><div><b>${esc(item.message)}</b><small>${esc(item.remediation || "")}</small></div></li>`).join("")}</ul>` : "";
}

function latestRun() { return (state.project?.evidence || []).find((run) => run.report) || null; }

function renderDecision(run) {
  const latest = run || latestRun();
  const card = $("#decision-card");
  if (!latest) {
    card.className = "decision-card neutral";
    $("#decision-title").textContent = "Not evaluated";
    $("#decision-detail").textContent = "Run a conclusive release gate to establish evidence.";
    $("#overview-evidence").innerHTML = '<div class="empty">No run yet.</div>';
    return;
  }
  const report = latest.report;
  const outcome = report.gate?.outcome || (report.gate?.failed === true ? "fail" : report.inconclusive ? "inconclusive" : report.gate ? "pass" : null);
  const cssClass = { pass: "ready", fail: "blocked", inconclusive: "caution" }[outcome] || "caution";
  card.className = `decision-card ${cssClass}`;
  $("#decision-title").textContent = outcome === "fail" ? "Do not merge" : outcome === "inconclusive" ? "Inconclusive" : outcome === "pass" ? "Ready to merge" : "Observed — not a release decision";
  $("#decision-detail").textContent = report.gate?.reasons?.join(" · ") || report.headline || "Review the evidence below.";
  $("#overview-evidence").innerHTML = `<div class="latest-run-line"><span class="verdict-dot ${esc(cssClass)}"></span><div><strong>${esc(report.headline || pretty(cssClass))}</strong><small>${esc(pretty(report.platform || "unknown"))} · ${compactDate(latest.createdAt)} · ${(report.contracts || []).filter((item) => item.passed).length}/${(report.contracts || []).length} contracts passed</small></div></div><p>${esc((report.gate?.reasons || ["No blocking release-gate reason reported."])[0])}</p>${reportLink(report)}`;
}

// Runs are three kinds in one list: gate runs on the repository, explorations started from the
// prompt, and read-only website audits. Each opens the report page the engine wrote.
function allRuns() {
  const gates = (state.project?.evidence || []).map((run) => ({ ...run, kind:"gate" }));
  const explores = (state.explores || []).map((run) => ({ id:run.id, createdAt:run.createdAt, kind:"explore", explore:run }));
  const audits = (state.audits || []).map((audit) => ({ id:audit.id, createdAt:audit.createdAt, kind:"audit", audit }));
  return [...gates, ...explores, ...audits].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

// The journeys the open repository has committed under .tapp/flows/. This is the thing a
// person owns; the engine has listed them all along and the Studio never showed them.
// The journeys this person owns, with how the last replay went. A repository's committed flows
// come grouped by folder; kept journeys (from a run that got somewhere) are flat. Both replay
// the same way and both show the same status pill.
function journeyStatus(status) {
  if (!status) return '<span class="journey-status never">never run</span>';
  return `<span class="journey-status ${status.passed ? "passing" : "failing"}">${status.passed ? "passing" : "failing"} · ${esc(compactDate(status.at))}</span>`;
}

function renderJourneys() {
  const node = $("#journeys-list");
  if (!node) return;
  const journeys = state.journeys || [];
  setCount("#journey-count", journeys.length);
  const note = $("#journeys-note");
  if (note) note.textContent = journeys.some((j) => j.source === "repo")
    ? "Committed under .tapp/flows/. Each replays exactly as written — no model, no key — and is what the release gate guards."
    : state.session?.access === "account"
      ? "Each replays exactly as written — no model, no key. Keep one from any run that got somewhere. tapp re-runs every kept journey daily and shows the result here."
      : "Each replays exactly as written — no model, no key. Keep one from any run that got somewhere; run it any time to prove it still works.";
  if (!journeys.length) { node.innerHTML = '<div class="empty">No journeys yet. Explore a site — when a run gets somewhere, tapp offers to keep it.</div>'; return; }
  const groups = new Map();
  for (const journey of journeys) { const key = journey.group || ""; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(journey); }
  const row = (j) => `<div class="journey-row"><span class="journey-platform ${esc(j.platform || "web")}">${esc(j.platform || "web")}</span><span class="journey-name">${esc(j.name)}<br><small>${j.steps || 0} steps · ${journeyStatus(j.status)}</small></span><span></span><span class="journey-actions"><button class="quiet" data-run-journey="${esc(j.slug)}" title="Replay this journey">▶ Run</button>${j.source === "kept" ? `<button class="quiet" data-forget-journey="${esc(j.slug)}" title="Forget this journey">Forget</button>` : ""}</span></div>`;
  node.innerHTML = [...groups.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b))).map(([group, items]) =>
    group === ""
      ? items.map(row).join("")
      : `<details class="journey-group"${items.length <= 8 ? " open" : ""}><summary><span class="journey-group-name">${esc(group)}/</span><span class="journey-steps">${items.length}</span></summary>${items.map(row).join("")}</details>`
  ).join("");
}

async function loadJourneys() {
  if (!state.session || state.session.access === "anonymous") { state.journeys = []; return; }
  state.journeys = (await api("/api/journeys").catch(() => ({ journeys: [] }))).journeys || [];
}

async function runJourney(slug) {
  const name = String(slug).replace(/^\.tapp\/flows\//, "").replace(/\.ya?ml$/i, "");
  const known = (state.journeys || []).find((j) => j.slug === name);
  state.promptRun = true; state.promptPlatform = "web";
  showProduct(); activateView("overview"); renderDeviceChrome(); renderChat();
  document.querySelector(".device-stage")?.classList.remove("hidden");
  setHeading(known?.name || name, "Replaying the journey exactly as kept.", { owned: true });
  const result = await runOperation("run-flow", { name }, { input: name });
  if (result?.kind === "self-host") { answerSelfHost(result); return; }
  if (result?.kind === "journey") {
    pushLine({ kind: "summary", tone: result.passed ? "ready" : "blocked", pill: result.passed ? "Passed" : "Failed", text: `${result.name}: ${result.executed}/${result.total} steps${result.failed ? `, ${result.failed} failed` : ""}.` });
    renderChat();
    await loadJourneys(); renderJourneys();
  }
}

async function forgetJourney(slug) {
  await api(`/api/journeys/${encodeURIComponent(slug)}`, { method:"DELETE" });
  await loadJourneys(); renderJourneys();
  toast("Forgot that journey.");
}

// A run that got somewhere is worth keeping: offer it in the chat, with a name to edit.
async function offerJourney(result) {
  const captureId = result?.capture?.id;
  if (!captureId || !(result?.actionsPerformed > 0)) return;
  // Ask the server what the journey would be — its name comes from where the run went.
  let preview = null;
  try { preview = await api(`/api/captures/${encodeURIComponent(captureId)}/keep`, { method:"POST", body:JSON.stringify({ preview: true }) }); }
  catch { return; /* a run that only looked around is not offered */ }
  state.pendingKeep = { captureId, suggested: preview.name, steps: preview.steps, screens: preview.screens || [], signedIn: preview.signedIn };
  renderChat();
}

function renderKeepCard() {
  const keep = state.pendingKeep;
  if (!keep || state.activeJob) return "";
  return `<form class="chat-ask chat-keep" id="chat-keep" data-capture="${esc(keep.captureId)}">
    <div class="chat-ask-head"><span class="chat-icon">🧭</span><span>This run got somewhere${keep.signedIn ? ", signed in" : ""}: <b>${esc((keep.screens || []).join(" → "))}</b> (${keep.steps} steps). Keep it as a journey? It will replay exactly this path and tell you when it stops working.</span></div>
    <label class="ask-field"><span>Name</span><input name="name" type="text" value="${esc(keep.suggested)}" maxlength="120"></label>
    <div class="ask-actions"><button type="submit" class="primary">Keep</button><button type="button" class="quiet" data-keep="dismiss">Not now</button></div>
  </form>`;
}

async function keepJourney(form) {
  const captureId = form.dataset.capture;
  const name = form.elements.name.value.trim();
  try {
    const kept = await api(`/api/captures/${encodeURIComponent(captureId)}/keep`, { method:"POST", body:JSON.stringify({ name }) });
    state.pendingKeep = null;
    pushLine({ kind: "step", icon: "🧭", text: `Kept as “${kept.name}” — ${kept.steps} steps${kept.signedIn ? ", signs in as your test account" : ""}. Run it any time from Journeys.` });
    renderChat();
    await loadJourneys(); renderJourneys();
    toast(`Kept “${kept.name}”.`);
  } catch (error) { toast(error.message, true); }
}

// Not defects — what a person would notice and not like. Shown apart from issues, and labelled
// so nobody reads "nothing is broken" and "this is fine" as the same sentence.
function renderObservations(audit) {
  const observations = audit.observations || [];
  if (!observations.length) return "";
  return `<h3>Worth a look <i class="zero">${observations.length}</i></h3>
    <p class="muted">Not broken — things a person would notice and may not like.</p>
    <ul class="detail-list">${observations.slice(0, 40).map((o) => `<li><b>${esc(o.severity)}</b> · ${esc(o.title)}${o.pages?.length > 1 ? ` <small>(${o.pages.length} pages)</small>` : ""}</li>`).join("")}</ul>`;
}

function renderRuns() {
  renderJourneys();
  renderActors();
  renderTokens();
  const runs = allRuns();
  setCount("#run-count", runs.length);
  $("#runs-list").innerHTML = runs.length ? runs.map((run) => {
    const selected = run.id === state.selectedRunId ? "selected" : "";
    if (run.kind === "audit") {
      const audit = run.audit;
      const issues = audit.issueCount || 0;
      const host = (() => { try { return new URL(audit.url).host; } catch { return audit.url; } })();
      return `<button class="run-row ${selected}" data-run-id="${esc(run.id)}"><span class="run-status ${issues ? "inconclusive" : "ready"}">${issues ? "!" : "✓"}</span><span><strong>Audit · ${esc(host)}</strong><small>${compactDate(run.createdAt)} · ${audit.pagesAudited || 0} page${audit.pagesAudited === 1 ? "" : "s"} · read-only</small></span><em>${issues ? `${issues} issue${issues === 1 ? "" : "s"}` : "Nothing broken"}</em></button>`;
    }
    if (run.kind === "explore") {
      const e = run.explore;
      const findings = e.report?.findingCounts?.total ?? (e.report?.findings || []).length;
      return `<button class="run-row ${selected}" data-run-id="${esc(run.id)}"><span class="run-status ${e.report?.inconclusive ? "inconclusive" : "completed"}">${e.report?.inconclusive ? "◐" : "✓"}</span><span><strong>Explore · ${esc(e.target || e.platform)}</strong><small>${compactDate(run.createdAt)} · ${esc(pretty(e.platform))}</small></span><em>${findings} finding${findings === 1 ? "" : "s"}</em></button>`;
    }
    const report = run.report;
    const failed = report?.gate?.failed === true;
    const status = !report ? run.status
      : report.gate?.outcome === "fail" || failed ? "blocked"
      : report.gate?.outcome === "inconclusive" || report.inconclusive ? "inconclusive"
      : report.gate?.outcome === "pass" ? "ready" : "completed";
    return `<button class="run-row ${selected}" data-run-id="${esc(run.id)}"><span class="run-status ${esc(status)}">${failed ? "×" : report ? "✓" : "…"}</span><span><strong>${esc(report?.headline || `Release run ${run.id.slice(-8)}`)}</strong><small>${compactDate(run.createdAt)} · ${esc(pretty(report?.platform || "unknown"))}</small></span><em>${esc(pretty(status))}</em></button>`;
  }).join("") : '<div class="empty">No runs yet. Run a release check, or audit a website above.</div>';
  const chosen = runs.find((run) => run.id === state.selectedRunId) || runs[0];
  if (chosen) state.selectedRunId = chosen.id;
  renderRunDetail(chosen);
}

function detailLists(report) {
  return `<h3>What Tapp checked</h3><ul class="detail-list">${(report.checkedFor || []).slice(0, 8).map((item) => `<li>${esc(item)}</li>`).join("")}</ul><h3>Not checked</h3><ul class="detail-list boundary">${(report.notChecked || []).slice(0, 8).map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
}

function renderRunDetail(run) {
  if (!run) { $("#run-detail").innerHTML = '<div class="empty">Select a run to inspect its evidence.</div>'; return; }
  if (run.kind === "audit") {
    const audit = run.audit;
    const counts = audit.findingCounts || {};
    const issues = audit.issues || [];
    $("#run-detail").innerHTML = `<div class="run-detail-head"><div><p class="eyebrow">READ-ONLY AUDIT</p><h2>${esc(audit.url)}</h2><small><code>${esc(audit.id)}</code> · ${compactDate(audit.createdAt)} · nothing was clicked</small></div>${evidenceLink(audit.id, "Visual report")}</div>
      <p class="muted read-only-note">This pass only <b>looks</b>: it never presses, types or submits, so a pop-up stays where it is and anything behind a click was not seen.${state.session?.access === "anonymous" ? " Sign in and tapp goes inside instead — it gets past pop-ups, clicks the controls, and asks you for a test account when it meets a sign-in." : " Put a URL in the prompt and tapp goes inside instead."}</p><div class="run-stats"><div><strong>${audit.pagesAudited || 0}</strong><small>pages</small></div><div><strong>${issues.length}</strong><small>distinct issues</small></div><div><strong>${counts.high || 0}</strong><small>high</small></div><div><strong>${counts.medium || 0}</strong><small>medium</small></div></div><h3>Issues</h3>${issues.length ? `<ul class="detail-list">${issues.slice(0, 40).map((issue) => `<li><b>${esc(issue.severity)}</b> · ${esc(issue.title)}${issue.pages?.length > 1 ? ` <small>(${issue.pages.length} pages)</small>` : ""}</li>`).join("")}</ul>` : '<p class="muted">Nothing broken was observed. This says the pages are served without structural defects, not that the site works.</p>'}${renderObservations(audit)}${detailLists(audit)}`;
    return;
  }
  if (run.kind === "explore") {
    const e = run.explore;
    const report = e.report || {};
    $("#run-detail").innerHTML = `<div class="run-detail-head"><div><p class="eyebrow">${esc(report.inconclusive ? "INCONCLUSIVE" : "EXPLORATION")}</p><h2>${esc(report.headline || `Explored ${e.target || e.platform}`)}</h2><small><code>${esc(e.id)}</code> · ${compactDate(e.createdAt)} · an observation, not a release decision</small></div>${evidenceLink(e.id, "Visual report")}</div><div class="run-stats"><div><strong>${report.screensExplored || 0}</strong><small>screens</small></div><div><strong>${report.actionsPerformed || 0}</strong><small>actions</small></div><div><strong>${report.findingCounts?.total ?? (report.findings || []).length}</strong><small>findings</small></div></div><h3>Findings</h3>${(report.findings || []).length ? `<ul class="detail-list">${report.findings.slice(0, 40).map((f) => `<li><b>${esc(f.severity)}</b> · ${esc(f.title)}${f.screen ? ` <small>on ${esc(f.screen)}</small>` : ""}</li>`).join("")}</ul>` : '<p class="muted">No findings surfaced in the exercised surfaces.</p>'}${detailLists(report)}`;
    return;
  }
  if (!run.report) { $("#run-detail").innerHTML = '<div class="empty">Select a completed run to inspect its evidence.</div>'; return; }
  const report = run.report;
  const contracts = report.contracts || [];
  $("#run-detail").innerHTML = `<div class="run-detail-head"><div><p class="eyebrow">${esc(report.gate?.failed ? "BLOCKED" : report.inconclusive ? "INCONCLUSIVE" : "RELEASE RUN")}</p><h2>${esc(report.headline || "Release gate completed")}</h2><small><code>${esc(run.id)}</code> · ${compactDate(run.createdAt)}</small></div>${reportLink(report, "Visual report")}</div><div class="run-stats"><div><strong>${report.screensExplored || 0}</strong><small>states</small></div><div><strong>${report.actionsPerformed || 0}</strong><small>actions</small></div><div><strong>${contracts.filter((item) => item.passed).length}/${contracts.length}</strong><small>contracts</small></div><div><strong>${report.findingCounts?.total ?? (report.findings || []).length}</strong><small>findings</small></div></div><h3>Decision rationale</h3><ul class="detail-list">${(report.gate?.reasons || ["No blocking gate reason reported."]).map((item) => `<li>${esc(item)}</li>`).join("")}</ul><h3>Deterministic contracts</h3>${contracts.length ? contracts.map((contract) => `<div class="contract-result"><span class="${contract.passed ? "pass" : "fail"}">${contract.passed ? "✓" : "×"}</span><div><strong>${esc(contract.title || contract.name || contract.path)}</strong><small>${esc(contract.detail || contract.path || "Deterministic replay")}</small></div></div>`).join("") : '<p class="muted">No committed release contracts applied to this target.</p>'}${detailLists(report)}`;
}

// ---- tapp chat: the engine's progress log, rendered as a transcript -------------------------
function renderChat() {
  const node = $("#chat-transcript");
  // While an ask is on screen the transcript is rebuilt on every poll, and rebuilding it throws
  // away whatever the person has typed into the ask so far. Nothing else changes while the
  // engine waits, so leave the DOM alone until the ask is answered or withdrawn.
  const openAsk = node.querySelector("#chat-ask");
  if (openAsk && state.pendingInput && openAsk.dataset.request === String(state.pendingInput.requestId)) return;
  const openKeep = node.querySelector("#chat-keep");
  if (openKeep && state.pendingKeep && openKeep.dataset.capture === state.pendingKeep.captureId && !state.activeJob) return;
  const stickToBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 24;
  const lines = state.transcript.map((entry) => {
    if (entry.kind === "shots") return `<div class="chat-shots">${entry.shots.map((shot) => `<a href="${esc(shot.href)}" target="_blank" rel="noreferrer" title="${esc(shot.caption)}"><img src="${esc(shot.src)}" alt="${esc(shot.caption)}"></a>`).join("")}</div>`;
    if (entry.kind === "attachments") return `<div class="chat-attachments">${entry.items.map((item) => `<a href="${esc(item.href)}" target="_blank" rel="noreferrer"><span>${item.icon}</span>${esc(item.label)}</a>`).join("")}</div>`;
    if (entry.kind === "summary") return `<div class="chat-summary ${esc(entry.tone)}"><span class="chat-pill">${esc(entry.pill)}</span><p>${esc(entry.text)}</p></div>`;
    if (entry.kind === "finding") return `<div class="chat-line finding ${esc(entry.severity)}"><span class="chat-icon">${entry.icon}</span><span>${esc(entry.text)}</span></div>`;
    if (entry.kind === "progress") return "";
    return `<div class="chat-line ${esc(entry.kind || "")}"><span class="chat-icon">${entry.icon || "•"}</span><span>${esc(entry.text)}${entry.detail ? ` <em>— ${esc(entry.detail)}</em>` : ""}</span></div>`;
  }).join("") + renderAskCard() + renderKeepCard() + (state.activeJob && !state.pendingInput ? '<div class="chat-line typing"><span class="chat-icon">✨</span><span>tapp is working<i>…</i></span></div>' : "");
  node.innerHTML = lines;
  if (stickToBottom) node.scrollTop = node.scrollHeight;
  const progress = [...state.transcript].reverse().find((entry) => entry.kind === "progress");
  $("#chat-status").textContent = state.activeJob ? (progress ? `${progress.current}/${progress.total} actions${progress.states != null ? ` · ${progress.states} screens` : ""}` : "working…") : state.transcript.length > 1 ? "done" : "ready";
}

// The desktop app's prompt, in the chat: Submit, Use defaults, Skip, Don't ask again. Secure
// fields are password inputs; nothing typed here is echoed into the transcript, and "remember"
// keeps it in the encrypted actor store so the next run starts signed in.
function renderAskCard() {
  const ask = state.pendingInput;
  if (!ask) return "";
  const fields = (ask.fields || []).map((f) => `<label class="ask-field"><span>${esc(f.label || f.key)}</span><input name="${esc(f.key)}" type="${f.secure ? "password" : "text"}" placeholder="${esc(f.placeholder || "")}" value="${esc(f.default || "")}" autocomplete="${f.secure ? "current-password" : "username"}"></label>`).join("");
  return `<form class="chat-ask" id="chat-ask" data-request="${esc(ask.requestId)}" data-job="${esc(ask.jobId)}">
    <div class="chat-ask-head"><span class="chat-icon">🔐</span><span>tapp found a sign-in on <b>${esc(ask.screen || "this screen")}</b>. Go in?</span></div>
    ${fields}
    <label class="ask-remember"><input type="checkbox" name="remember" checked> Remember for this site, so next time starts signed in</label>
    <div class="ask-actions">
      <button type="submit" class="primary" data-ask="submit">Submit</button>
      <button type="button" class="quiet" data-ask="skip">Skip</button>
      <button type="button" class="quiet" data-ask="dont_ask">Don't ask again</button>
    </div>
  </form>`;
}

async function answerAsk(form, action) {
  const jobId = form.dataset.job;
  const values = {};
  if (action === "submit") for (const input of form.querySelectorAll("input[name]:not([type=checkbox])")) values[input.name] = input.value;
  const remember = !!form.querySelector("input[name=remember]")?.checked;
  try {
    await api(`/api/jobs/${encodeURIComponent(jobId)}/input`, { method: "POST", body: JSON.stringify({ action, values, remember: action === "submit" && remember }) });
    state.pendingInput = null;
    pushLine({ kind: "step", icon: action === "submit" ? "🔐" : "⏭️", text: action === "submit" ? "Signing in with what you gave me" : action === "dont_ask" ? "Won't ask again this run" : "Skipped the sign-in" });
    renderChat();
  } catch (error) { toast(error.message, true); }
}

function setChatCollapsed(collapsed) {
  state.chatCollapsed = collapsed;
  $("#chat-float").classList.toggle("collapsed", collapsed);
  $("#chat-toggle").setAttribute("aria-expanded", String(!collapsed));
  try { localStorage.setItem("tapp:chat-collapsed", collapsed ? "1" : "0"); } catch { /* storage may be unavailable */ }
}

function pushLine(entry) { state.transcript.push({ at: new Date().toISOString(), ...entry }); }

// A screenshot the engine wrote during the run, kept as a thumbnail in the transcript. Captured
// once per screen name the engine reports, and never more often than every few seconds.
async function keepShot(screen) {
  const key = screen || `t${Math.floor(Date.now() / 4000)}`;
  if (state.shotScreens.has(key) || Date.now() - state.lastShotAt < 2500 || !state.activeJob) return;
  state.shotScreens.add(key);
  state.lastShotAt = Date.now();
  try {
    const response = await fetch(apiRoute(`/api/jobs/${state.activeJob}/frame?at=${Date.now()}`));
    if (!response.ok) return;
    const blob = await response.blob();
    const src = URL.createObjectURL(blob);
    const last = state.transcript.at(-1);
    if (last?.kind === "shots" && last.shots.length < 3) last.shots.push({ src, href: src, caption: screen || "screen" });
    else pushLine({ kind: "shots", shots: [{ src, href: src, caption: screen || "screen" }] });
    renderChat();
  } catch { /* a missed thumbnail is not an error */ }
}

function syncTranscriptFromJob(name, job) {
  if (state.transcriptSource !== job.id) {
    state.transcript = [{ at: job.createdAt, kind: "phase", icon: "🚀", text: startLine(name, job) }];
    state.transcriptSource = job.id;
    state.shotScreens = new Set();
    state.lastShotAt = 0;
  }
  const seen = state.transcript.filter((entry) => entry.source === "job").length;
  for (const entry of job.progress.slice(seen)) {
    const line = narrate(entry, { platform: currentPlatform() });
    state.transcript.push({ ...(line || { kind: "step", icon: "•", text: "" }), at: entry.at, source: "job" });
    if (line && line.kind !== "progress") {
      const last = state.transcript.at(-2);
      if (last && last.text === line.text && last.kind !== "shots") state.transcript.splice(-1, 1);
    }
    if (entry.screen) keepShot(entry.screen);
  }
}

function startLine(name, job) {
  const raw = job.input || "";
  const input = /\.(app|apk)$/i.test(raw) ? raw.split("/").filter(Boolean).at(-1) : raw;
  return { initialize: "Starting a release check — build, launch and explore the real app", gate: "Running the release gate", audit: `Opening ${input} read-only — nothing will be clicked`, "explore-build": `Exploring ${input} on the booted device`, open: `Opening ${input}`, "session-start": "Opening a live session", "session-act": "Acting in the live session", "session-save-flow": "Saving the journey as a Flow", "session-end": "Ending the live session" }[name] || `${pretty(name)} started`;
}

async function finishTranscript(name, job) {
  state.transcript = state.transcript.filter((entry) => entry.kind !== "progress" || true);
  if (job.status === "failed") { pushLine({ kind: "warning", icon: "⚠️", text: job.error?.message || `${pretty(name)} failed` }); return; }
  const result = job.result || {};
  // initialize carries its exploration beside the project; the gate carries a report.
  const report = result.exploration || result.report || result;
  for (const finding of (report.findings || result.issues || []).slice(0, 12)) pushLine(narrateFinding(finding));
  const id = result.capture?.id || captureId(report);
  if (id) {
    try {
      const files = await api(`/api/captures/${encodeURIComponent(id)}/files`);
      if (files.shots?.length) {
        pushLine({ kind: "shots", shots: files.shots.slice(0, 3).map((shot) => ({ src: captureUrl(id, shot.src), href: captureUrl(id, shot.src), caption: shot.caption })) });
        // The stage keeps the run's final screen until something newer replaces it — but only
        // when the run never put a live frame there. Evidence screenshots are full-page, so a
        // long marketing page becomes a tall sliver once it is fitted to the stage; the viewport
        // frame the run was already showing is the better picture of where it ended.
        const image = $("#live-frame-image");
        if (!state.live?.active && !image.getAttribute("src")) {
          const last = files.shots.at(-1);
          image.onload = () => { $("#live-frame-loading").classList.add("hidden"); $("#device-placeholder").classList.add("hidden"); };
          image.src = captureUrl(id, last.src);
          $("#live-screen-title").textContent = last.caption || "";
        }
      }
      const items = [];
      if (files.recording) items.push({ icon: "🎬", label: files.recording, href: captureUrl(id, files.recording) });
      if (files.report) items.push({ icon: "📄", label: "report.html", href: captureUrl(id, files.report) });
      if (items.length) pushLine({ kind: "attachments", items });
    } catch { /* the summary still renders */ }
  }
  pushLine({ kind: "summary", ...summarize(name, result.exploration ? { ...result, report } : result, { access: state.session?.access || "" }) });
}

function seedIdleTranscript() {
  if (state.transcriptSource) return;
  const latest = latestRun();
  const report = latest?.report;
  state.transcript = report
    ? [{ at: latest.createdAt, kind: "summary", ...summarize("gate", report) }]
    : [{ at: new Date().toISOString(), kind: "phase", icon: "👋", text: state.project?.state?.inspected ? "Ready. Run a release check and I'll narrate what the app does while you watch it." : "Inspecting the project…" }];
}

function renderCommandState(job = null, name = "") {
  const running = !!state.activeJob;
  const pill = $("#phase-pill");
  pill.classList.toggle("hidden", !running);
  pill.classList.toggle("running", running);
  $("#command-run").disabled = running || !currentTarget();
  $("#run-gate").disabled = running || !currentTarget();
  $("#run-progress").classList.toggle("hidden", !running);
  $("#idle-badges").classList.toggle("hidden", running);
  if (running) {
    const progress = job?.progress?.at(-1);
    const text = progress?.text || `${pretty(name)}…`;
    $("#phase-pill-text").textContent = text;
    $("#run-progress-text").textContent = text;
    const ratio = progress?.current && progress?.total ? Math.min(92, Math.round(progress.current / progress.total * 100)) : Math.min(88, 8 + (job?.progress?.length || 0) * 4);
    $("#run-progress-bar").style.width = `${ratio}%`;
    return;
  }
  const target = currentTarget();
  const runner = target ? state.session?.runners?.find((item) => item.platform === target.platform) : null;
  $("#idle-badges").innerHTML = [
    target ? `<span><b>${esc(pretty(target.platform))}</b> · ${esc(target.name)}</span>` : "",
    runner ? `<span>${esc(runner.label)}</span>` : "",
  ].filter(Boolean).join("");
}

function renderProject() {
  const project = state.project;
  renderRepositoryChrome();
  if (!project?.connected) {
    renderOwnedLink();
    if ((state.journeys?.length || state.audits.length || state.explores.length) && state.activeView === "runs") { showProduct(); renderRuns(); return; }
    if (state.promptRun) { showProduct(); renderRuns(); renderDeviceChrome(); renderChat(); return; }
    showPrompt();
    renderRuns();
    return;
  }
  showProduct();
  if (!state.headingOwnedByRun) $("#app-name").textContent = project.application?.name || "Unnamed product";
  const platforms = project.application?.platforms?.map(pretty).join(" · ") || "Targets not inspected";
  if (!state.headingOwnedByRun) $("#app-summary").textContent = `${platforms} · ${project.capabilities?.length || 0} known capabilities`;
  renderTargets();
  renderRequirements();
  renderDecision();
  renderRuns();
  renderLiveSession();
  seedIdleTranscript();
  renderChat();
  renderCommandState();
}

async function refreshSession() {
  state.session = await api("/api/session");
  state.csrf = state.session.csrfToken;
  const local = state.session.mode === "local";
  $("#mode-pill").textContent = local ? "Self-host · this machine" : "Cloud · outbound runner";
  $("#onboarding-mode-pill").textContent = local ? "Self-host · this machine" : "Cloud";
  $("#privacy-note-detail").textContent = local ? "Everything runs on this machine. Exploration, replay and merge decisions are deterministic and need no API key." : "Your repository stays in your private Tapp workspace.";
  applyAccessMode();
}

async function refresh() {
  // A public visitor has no project and no live session, and asking for them would only earn a
  // 401 on every poll.
  if (state.session?.access === "anonymous" || state.session?.access === "account") {
    const [runs, actors] = await Promise.all([
      api("/api/audits").catch(() => ({ audits: [], explores: [] })),
      state.session.access === "account" ? api("/api/actors").catch(() => ({ apps: [] })) : Promise.resolve({ apps: [] }),
    ]);
    state.project = { connected:false };
    state.live = { active:false };
    state.audits = runs.audits || [];
    state.explores = runs.explores || [];
    state.actors = actors.apps || [];
    await Promise.all([loadJourneys(), loadTokens()]);
    renderProject();
    return;
  }
  const [project, live, runs] = await Promise.all([api("/api/project"), api("/api/live-session"), api("/api/audits").catch(() => ({ audits: [], explores: [] }))]);
  state.project = project;
  state.live = live;
  state.audits = runs.audits || [];
  state.explores = runs.explores || [];
  await loadJourneys();
  renderProject();
}

async function runOperation(name, body = {}, { input = "" } = {}) {
  if (state.activeJob) throw new Error("Another operation is still running");
  const started = await api(`/api/operations/${name}`, { method:"POST", body:JSON.stringify(body) });
  if (!started.job) return started; // synchronous answers (open a path, a business name)
  state.activeJob = started.job.id;
  const drawer = $("#operation-drawer");
  drawer.classList.remove("hidden");
  $("#operation-title").textContent = name === "audit" ? "Read-only audit" : pretty(name);
  $("#operation-progress").textContent = "Starting";
  $("#operation-progress-bar").style.width = "6%";
  syncTranscriptFromJob(name, { ...started.job, input });
  if (!$("#product-shell").classList.contains("hidden")) { renderCommandState(started.job, name); renderChat(); }
  try {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 650));
      const job = await api(`/api/jobs/${state.activeJob}`);
      const progress = job.progress.at(-1);
      $("#operation-progress").textContent = progress?.text || "Working…";
      const ratio = progress?.current && progress?.total ? Math.min(92, Math.round(progress.current / progress.total * 100)) : Math.min(88, 8 + job.progress.length * 4);
      $("#operation-progress-bar").style.width = `${ratio}%`;
      syncTranscriptFromJob(name, { ...job, input });
      // The engine has stopped at a sign-in and is waiting on a person. Show the ask in the chat
      // until it is answered or the engine moves on.
      if (job.input && state.pendingInput?.requestId !== job.input.requestId) { state.pendingInput = { ...job.input, jobId: job.id }; }
      if (!job.input && state.pendingInput) state.pendingInput = null;
      if (!$("#product-shell").classList.contains("hidden")) { renderCommandState(job, name); renderChat(); }
      const screen = [...job.progress].reverse().find((entry) => entry.screen)?.screen;
      if (screen && !state.live?.active) $("#live-screen-title").textContent = screen;
      if (job.frame && !state.jobHasFrame) { state.jobHasFrame = true; refreshLiveFrame(); }
      if (operationIsPending(job.status)) continue;
      await finishTranscript(name, job);
      if (job.status === "failed") throw new Error(job.error?.message || "Operation failed");
      if (job.status !== "completed") throw new Error(`Operation ended in an unknown '${job.status}' state`);
      $("#operation-progress-bar").style.width = "100%";
      if (name === "session-act" && job.result.status !== "ok") toast(job.result.detail || `The action ended with ${job.result.status}`, true);
      else if (name === "session-save-flow") toast(`Saved ${job.result.path} as a reviewable deterministic Flow`);
      else if (name === "gate" && job.result.passed === false) toast("The release gate blocked this revision. Tapp did not soften the result.", true);
      else if (name === "audit") toast(`Audited ${job.result.pagesAudited} page(s) — ${job.result.issueCount} distinct issue(s)`);
      return job.result;
    }
  } finally {
    if (state.jobHasFrame) { state.jobHasFrame = false; await new Promise((resolve) => setTimeout(resolve, 200)); stopLiveFrames(); }
    state.activeJob = null;
    try {
      await refreshSession();
      await refresh();
    } finally {
      renderChat();
      drawer.classList.add("hidden");
    }
  }
}

// "What should tapp test?" — route by what was typed. The server classifies again and refuses
// what the mode cannot do (a hosted Studio cannot open a path on your machine).
// `owned` marks a heading as belonging to whatever is happening now, so periodic re-renders
// leave it alone until something else takes over.
function setHeading(title, summary, { owned = false } = {}) {
  state.headingOwnedByRun = owned;
  const heading = $("#app-name");
  if (heading) heading.textContent = title;
  const note = $("#app-summary");
  if (note) note.textContent = summary;
}

// Some targets simply cannot run where this Studio is running — a folder on someone's disk, a
// simulator build, a repository that needs a toolchain. The engine answers with where they do
// run; show that answer where it stays put, not in a toast that disappears in six seconds.
function answerSelfHost(answer) {
  setHeading("Run this on your machine", "The cloud Studio audits websites; this target needs your toolchain.", { owned: true });
  document.querySelector(".summary-panel")?.classList.add("hidden");
  document.querySelector(".device-stage")?.classList.add("hidden");
  state.transcript = [];
  pushLine({ kind: "step", icon: "🖥️", text: answer.message });
  if (answer.command) pushLine({ kind: "step", icon: "⌨️", text: answer.command });
  renderChat();
  setChatCollapsed(false);
  toast(answer.message, true);
}

async function startFromPrompt(raw) {
  const prompt = classifyPrompt(raw);
  if (prompt.kind === "empty") return;
  if (prompt.kind === "url") {
    // On your own machine, or signed in to a public Studio, a website is explored for real — it
    // can stop at a sign-in and ask you. A visitor only ever reads.
    if (state.session?.mode === "local" || state.session?.access === "account") {
      state.promptRun = true; state.promptPlatform = "web";
      showProduct(); activateView("overview"); renderDeviceChrome(); renderChat();
      document.querySelector(".device-stage")?.classList.remove("hidden");
      setHeading("Exploring", "Going inside. If there is a sign-in, I will ask.", { owned: true });
      let result;
      try { result = await runOperation("explore", { url: prompt.value }, { input: prompt.value }); }
      catch (error) {
        // A refused start (your previous run is still finishing, or this Studio is busy) must not
        // leave "Exploring" over an empty stage.
        setHeading("Not started", error.message, { owned: true });
        throw error;
      }
      if (result?.kind === "self-host") { answerSelfHost(result); return; }
      state.selectedRunId = result?.capture?.id || state.selectedRunId;
      state.pendingKeep = null;
      await offerJourney(result);
      return;
    }
    state.promptRun = true; state.promptPlatform = "web";
    showProduct(); activateView("overview"); renderDeviceChrome(); renderChat();
    document.querySelector(".device-stage")?.classList.remove("hidden");
    if (state.session?.access !== "anonymous") document.querySelector(".summary-panel")?.classList.remove("hidden");
    if (state.session?.access === "anonymous") setHeading("Website audit", "Read-only. Nothing on the page is clicked.", { owned: true });
    const result = await runOperation("audit", { url: prompt.value }, { input: prompt.value });
    state.selectedRunId = result?.capture?.id || state.selectedRunId;
    return;
  }
  if (["bundle", "app", "apk"].includes(prompt.kind)) {
    state.promptRun = true; state.promptPlatform = prompt.kind === "apk" ? "android" : "ios";
    showProduct(); activateView("overview"); renderDeviceChrome(); renderChat();
    const result = await runOperation("explore-build", { input: prompt.value }, { input: prompt.value });
    if (result?.kind === "self-host") { answerSelfHost(result); return; }
    state.selectedRunId = result?.capture?.id || state.selectedRunId;
    return;
  }
  showProduct(); activateView("overview"); renderChat();
  const answer = await runOperation("open", { input: prompt.value }, { input: prompt.value });
  if (answer?.kind === "self-host") { answerSelfHost(answer); return; }
  if (answer?.kind === "business") { answerSelfHost({ message: answer.message }); return; }
  await refreshSession();
  await refresh();
  state.selectedTargetId = "";
  if (state.project?.connected && !state.project?.state?.inspected) await runOperation("initialize", { write:true });
}

async function auditWebsite(url) {
  const trimmed = String(url || "").trim();
  if (!/^https?:\/\//i.test(trimmed)) { toast("Enter an http(s) URL to audit", true); return; }
  const result = await runOperation("audit", { url: trimmed }, { input: trimmed });
  state.selectedRunId = result?.capture?.id || state.selectedRunId;
  activateView("runs");
  renderRuns();
}

document.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton && $("#product-shell").contains(viewButton)) activateView(viewButton.dataset.view);
  const targetButton = event.target.closest("[data-target-id]");
  if (targetButton) {
    state.selectedTargetId = targetButton.dataset.targetId;
    localStorage.setItem(targetStorageKey(), state.selectedTargetId);
    renderTargets();
    renderCommandState();
  }
  const runButton = event.target.closest("[data-run-id]");
  if (runButton) { state.selectedRunId = runButton.dataset.runId; renderRuns(); }
  const suggestion = event.target.closest("[data-prompt]");
  if (suggestion) { const input = $("#prompt-input"); input.value = suggestion.dataset.prompt; input.focus(); input.select(); }
  const liveControl = event.target.closest("[data-live-control]");
  if (liveControl) {
    const target = liveControl.dataset.liveTarget;
    $("#live-action-target").value = target;
    if (liveControl.dataset.liveInput === "true") $("#live-action-text").focus();
    else runOperation("session-act", { action:"tap", id:target }).catch((error) => toast(error.message, true));
  }
});

document.addEventListener("submit", (event) => {
  const audit = event.target.closest("form.audit-form");
  if (audit) { event.preventDefault(); auditWebsite(audit.elements.url.value).catch((error) => toast(error.message, true)); return; }
  const prompt = event.target.closest("#prompt-form");
  if (prompt) { event.preventDefault(); startFromPrompt(prompt.elements.input.value).catch((error) => toast(error.message, true)); }
  const ask = event.target.closest("#chat-ask");
  if (ask) { event.preventDefault(); answerAsk(ask, "submit"); }
  const signin = event.target.closest("#signin-form");
  if (signin) { event.preventDefault(); requestSignInLink(signin.elements.email.value.trim()); }
  const keep = event.target.closest("#chat-keep");
  if (keep) { event.preventDefault(); keepJourney(keep); }
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("#chat-ask [data-ask]");
  if (button && button.type === "button") { event.preventDefault(); answerAsk(button.closest("#chat-ask"), button.dataset.ask); }
  const play = event.target.closest("[data-run-journey]");
  if (play) { event.preventDefault(); runJourney(play.dataset.runJourney).catch((error) => toast(error.message, true)); }
  if (event.target.closest("[data-signin]")) {
    event.preventDefault();
    // With Cloudflare Access in front, the sign-in page is Cloudflare's; otherwise ask for an
    // address here and mail a link.
    if (state.session?.signInProvider === "cloudflare") { location.href = "/auth/cloudflare"; return; }
    state.signInOpen = true; renderAccount(); showPrompt(); setTimeout(() => $("#signin-email")?.focus(), 50);
  }
  if (event.target.closest("[data-signout]")) { event.preventDefault(); signOut(); }
  if (event.target.closest("[data-keep=dismiss]")) { event.preventDefault(); state.pendingKeep = null; renderChat(); }
  const forgetJ = event.target.closest("[data-forget-journey]");
  if (forgetJ) { event.preventDefault(); forgetJourney(forgetJ.dataset.forgetJourney).catch((error) => toast(error.message, true)); }
  if (event.target.closest("[data-open-owned]")) { event.preventDefault(); showProduct(); activateView("runs"); renderRuns(); }
  if (event.target.closest("#create-token")) { event.preventDefault(); createToken(); }
  const revoke = event.target.closest("[data-revoke-token]");
  if (revoke) { event.preventDefault(); revokeToken(revoke.dataset.revokeToken).catch((error) => toast(error.message, true)); }
  if (event.target.closest("[data-dismiss-token]")) { event.preventDefault(); state.newToken = null; renderTokens(); }
  if (event.target.closest("[data-copy-token]")) {
    event.preventDefault();
    const text = $("#token-value")?.textContent || "";
    navigator.clipboard?.writeText(text).then(() => toast("Copied. Paste it where your agent runs."), () => toast("Select the text and copy it.", true));
  }
  const forget = event.target.closest("[data-forget-actor]");
  if (forget) { event.preventDefault(); forgetActor(forget.dataset.forgetHost, forget.dataset.forgetActor).catch((error) => toast(error.message, true)); }
});

$$("[data-brand-home]").forEach((button) => button.addEventListener("click", () => state.project?.connected ? (showProduct(), activateView("overview")) : showPrompt()));
$("#command-run").addEventListener("click", () => { state.promptRun = false; runOperation("initialize", operationPayload({ explore:true })).catch((error) => toast(error.message, true)); });
$("#refresh-project").addEventListener("click", () => refresh().catch((error) => toast(error.message, true)));
$("#change-source").addEventListener("click", showPrompt);
$("#chat-toggle").addEventListener("click", () => setChatCollapsed(!state.chatCollapsed));
$("#repository-switcher").addEventListener("change", async (event) => {
  try { await api("/api/repositories/select", { method:"POST", body:JSON.stringify({ id:event.target.value }) }); state.selectedTargetId = ""; await refreshSession(); await refresh(); } catch (error) { toast(error.message, true); }
});
$("#explore").addEventListener("click", () => { state.promptRun = false; runOperation("initialize", operationPayload({ explore:true })).catch((error) => toast(error.message, true)); });
$("#start-session").addEventListener("click", () => runOperation("session-start", operationPayload()).catch((error) => toast(error.message, true)));
$("#refresh-live-session").addEventListener("click", () => runOperation("session-act", { action:"tree" }).catch((error) => toast(error.message, true)));
$("#end-session").addEventListener("click", () => runOperation("session-end").catch((error) => toast(error.message, true)));
$("#save-live-flow").addEventListener("click", () => { const name=$("#live-flow-name").value.trim(); if (!name) { toast("Name the Flow before saving it", true); return; } runOperation("session-save-flow", { name }).catch((error) => toast(error.message, true)); });
$("#live-tap").addEventListener("click", () => { const id=$("#live-action-target").value.trim(); if (!id) { toast("Choose or enter a semantic target", true); return; } runOperation("session-act", { action:"tap", id }).catch((error) => toast(error.message, true)); });
$("#live-type").addEventListener("click", () => { const id=$("#live-action-target").value.trim(), text=$("#live-action-text").value; if (!id) { toast("Choose or enter a field", true); return; } runOperation("session-act", { action:"type", id, text }).catch((error) => toast(error.message, true)); });
$("#live-back").addEventListener("click", () => runOperation("session-act", { action:"back" }).catch((error) => toast(error.message, true)));
$("#live-swipe").addEventListener("click", () => runOperation("session-act", { action:"swipe", direction:"up" }).catch((error) => toast(error.message, true)));
$("#run-gate").addEventListener("click", () => runOperation("gate", operationPayload()).catch((error) => toast(error.message, true)));

// runtapp.com's hero is the same prompt as this screen, so it hands the target over as
// ?target=... Prefill it and start the run, so arriving here does not mean retyping what was
// already typed on the landing page. The URL is cleaned up either way so a refresh does not
// silently re-run it.
// Coming back from a sign-in link: say what happened, then clean the URL.
function signInOutcome() {
  let outcome = "";
  try { outcome = new URLSearchParams(window.location.search).get("signin") || ""; } catch { return; }
  if (!outcome) return;
  try { window.history.replaceState({}, "", window.location.pathname); } catch { /* history may be unavailable */ }
  if (outcome === "done") toast(`Signed in${state.session?.email ? ` as ${state.session.email}` : ""}.`);
  if (outcome === "expired") { toast("That sign-in link has expired or was already used — ask for a new one.", true); state.signInOpen = true; renderAccount(); }
  if (outcome === "failed") { toast("That sign-in did not complete. Try again, or ask for a link by email.", true); state.signInOpen = true; renderAccount(); }
}

function handoffTarget() {
  let target = "";
  try { target = new URLSearchParams(window.location.search).get("target") || ""; } catch { return ""; }
  target = target.trim().slice(0, 512);
  if (!target) return "";
  try { window.history.replaceState({}, "", window.location.pathname); } catch { /* history may be unavailable */ }
  return target;
}

try {
  try { setChatCollapsed(localStorage.getItem("tapp:chat-collapsed") === "1"); } catch { /* storage may be unavailable */ }
  await refreshSession();
  await refresh();
  if (state.project?.connected && !state.project?.state?.inspected) await runOperation("initialize", { write:true });
  signInOutcome();
  // A link to /#runs (or a bookmark) opens what you own rather than the empty prompt.
  if (window.location.hash === "#runs" && (state.journeys?.length || state.audits?.length || state.explores?.length)) {
    showProduct(); activateView("runs"); renderRuns();
  }

  const handoff = handoffTarget();
  if (handoff) {
    const input = $("#prompt-input");
    if (input) input.value = handoff;
    await startFromPrompt(handoff);
  }
} catch (error) { toast(error.message, true); }

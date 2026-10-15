import { customerProductContract } from "./product-contract.js";
import { operationIsPending } from "./view-model.js";

const API_BASE = String(document.querySelector('meta[name="tapp-api-base"]')?.content || "").replace(/\/$/, "");
const LOGIN_URL = String(document.querySelector('meta[name="tapp-login-url"]')?.content || "");
function apiRoute(route) {
  if (!API_BASE) return route;
  if (route === "/api" || route.startsWith("/api/")) return `${API_BASE}${route.slice(4)}`;
  if (route === "/evidence" || route.startsWith("/evidence/")) return `${API_BASE}${route}`;
  return route;
}

const state = {
  csrf: "", session: null, project: null, audits: [], activeJob: null, activeView: "overview",
  selectedTargetId: "", selectedRunId: "", live: { active:false }, transcript: [], transcriptSource: "", frameTimer: null,
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[character]));
const pretty = (value) => String(value || "").replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const compactDate = (value) => value ? new Intl.DateTimeFormat(undefined, { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" }).format(new Date(value)) : "—";

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

function evidenceLink(id, label = "Open visual evidence") {
  return id ? `<a class="button-link" href="${esc(apiRoute(`/evidence/captures/${encodeURIComponent(id)}/report.html`))}" target="_blank" rel="noreferrer">${esc(label)}</a>` : "";
}
function reportLink(report, label) { return evidenceLink(captureId(report), label); }

function currentTarget() { return (state.project?.targets || []).find((target) => target.id === state.selectedTargetId) || null; }
function targetStorageKey() { return `tapp:selected-target:${state.project?.repository?.id || "none"}`; }

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

function showSourceOnboarding() {
  $("#source-onboarding").classList.remove("hidden");
  $("#product-shell").classList.add("hidden");
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
  renderDeviceChrome(target);
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

function renderDeviceChrome(target) {
  const platform = state.live?.active ? state.live.platform : target?.platform;
  const frame = $("#device-frame");
  frame.className = `device-frame ${platform === "ios" ? "" : platform || ""}`.trim();
  $("#device-feed-label").textContent = platform === "android" ? "Live Android Feed" : platform === "web" ? "Live Browser Feed" : "Live iPhone Feed";
  $("#device-meta-device").textContent = platform === "ios" ? (target?.runtime?.surface || "iOS Simulator")
    : platform === "android" ? (target?.runtime?.serial || "Android emulator / device")
    : platform === "web" ? "Chromium" : "—";
}

// The device panel shows whichever real surface exists right now: an interactive session's frame,
// else the newest screenshot the running operation wrote. Nothing is synthesized.
function frameSource() {
  if (state.live?.active) return "/api/live-session/frame";
  if (state.activeJob && state.jobHasFrame) return `/api/jobs/${state.activeJob}/frame`;
  return "";
}

// One in-flight capture at a time; the next request waits for the previous image to land so a
// slow simulator does not pile up frame requests.
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

function scheduleLiveFrame() {
  clearTimeout(state.frameTimer);
  if (frameSource()) state.frameTimer = setTimeout(refreshLiveFrame, 1500);
}

function stopLiveFrames() {
  clearTimeout(state.frameTimer);
  state.frameTimer = null;
}

function renderLiveSession() {
  const live = state.live || { active:false };
  $("#live-session-panel").classList.toggle("hidden", !live.active);
  if (!live.active) {
    // Keep the last real frame on screen after a run; only show the placeholder when nothing was ever captured.
    if (!frameSource()) stopLiveFrames();
    const hasFrame = !!$("#live-frame-image").getAttribute("src");
    $("#live-frame-loading").classList.toggle("hidden", hasFrame || !frameSource());
    $("#device-placeholder").classList.toggle("hidden", hasFrame);
    if (!state.activeJob) $("#live-screen-title").textContent = hasFrame ? $("#live-screen-title").textContent : "—";
    renderDeviceChrome(currentTarget());
    return;
  }
  renderDeviceChrome(currentTarget());
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
  // The decision reflects the GATE outcome (pass/fail/inconclusive), not a ship verdict — exploration
  // only observes (ADR-0005). Without a gate, it's an observation, not a merge decision.
  const outcome = report.gate?.outcome || (report.gate?.failed === true ? "fail" : report.inconclusive ? "inconclusive" : report.gate ? "pass" : null);
  const cssClass = { pass: "ready", fail: "blocked", inconclusive: "caution" }[outcome] || "caution";
  card.className = `decision-card ${cssClass}`;
  $("#decision-title").textContent = outcome === "fail" ? "Do not merge" : outcome === "inconclusive" ? "Inconclusive" : outcome === "pass" ? "Ready to merge" : "Observed — not a release decision";
  $("#decision-detail").textContent = report.gate?.reasons?.join(" · ") || report.headline || "Review the evidence below.";
  $("#overview-evidence").innerHTML = `<div class="latest-run-line"><span class="verdict-dot ${esc(cssClass)}"></span><div><strong>${esc(report.headline || pretty(cssClass))}</strong><small>${esc(pretty(report.platform || "unknown"))} · ${compactDate(latest.createdAt)} · ${(report.contracts || []).filter((item) => item.passed).length}/${(report.contracts || []).length} contracts passed</small></div></div><p>${esc((report.gate?.reasons || ["No blocking release-gate reason reported."])[0])}</p>${reportLink(report)}`;
}

// Runs are two kinds with one list: gate runs on the repository (`report`) and read-only website
// audits (`audit`). Both open the report page the engine wrote.
function allRuns() {
  const gates = (state.project?.evidence || []).map((run) => ({ ...run, kind:"gate" }));
  const audits = (state.audits || []).map((audit) => ({ id:audit.id, createdAt:audit.createdAt, kind:"audit", audit }));
  return [...gates, ...audits].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function renderRuns() {
  const runs = allRuns();
  setCount("#run-count", runs.length);
  $("#runs-list").innerHTML = runs.length ? runs.map((run) => {
    if (run.kind === "audit") {
      const audit = run.audit;
      const issues = audit.issueCount || 0;
      const host = (() => { try { return new URL(audit.url).host; } catch { return audit.url; } })();
      return `<button class="run-row ${run.id === state.selectedRunId ? "selected" : ""}" data-run-id="${esc(run.id)}"><span class="run-status ${issues ? "inconclusive" : "ready"}">${issues ? "!" : "✓"}</span><span><strong>Audit · ${esc(host)}</strong><small>${compactDate(run.createdAt)} · ${audit.pagesAudited || 0} page${audit.pagesAudited === 1 ? "" : "s"} · read-only</small></span><em>${issues ? `${issues} issue${issues === 1 ? "" : "s"}` : "Nothing broken"}</em></button>`;
    }
    const report = run.report;
    const failed = report?.gate?.failed === true;
    const status = !report ? run.status
      : report.gate?.outcome === "fail" || failed ? "blocked"
      : report.gate?.outcome === "inconclusive" || report.inconclusive ? "inconclusive"
      : report.gate?.outcome === "pass" ? "ready" : "completed";
    return `<button class="run-row ${run.id === state.selectedRunId ? "selected" : ""}" data-run-id="${esc(run.id)}"><span class="run-status ${esc(status)}">${failed ? "×" : report ? "✓" : "…"}</span><span><strong>${esc(report?.headline || `Release run ${run.id.slice(-8)}`)}</strong><small>${compactDate(run.createdAt)} · ${esc(pretty(report?.platform || "unknown"))}</small></span><em>${esc(pretty(status))}</em></button>`;
  }).join("") : '<div class="empty">No runs yet. Run a release check, or audit a website above.</div>';
  const selected = runs.find((run) => run.id === state.selectedRunId) || runs[0];
  if (selected) state.selectedRunId = selected.id;
  renderRunDetail(selected);
}

function renderAuditDetail(audit) {
  const counts = audit.findingCounts || {};
  const issues = audit.issues || [];
  $("#run-detail").innerHTML = `<div class="run-detail-head"><div><p class="eyebrow">READ-ONLY AUDIT</p><h2>${esc(audit.url)}</h2><small><code>${esc(audit.id)}</code> · ${compactDate(audit.createdAt)} · nothing was clicked</small></div>${evidenceLink(audit.id, "Visual report")}</div><div class="run-stats"><div><strong>${audit.pagesAudited || 0}</strong><small>pages</small></div><div><strong>${issues.length}</strong><small>distinct issues</small></div><div><strong>${counts.high || 0}</strong><small>high</small></div><div><strong>${counts.medium || 0}</strong><small>medium</small></div></div><h3>Issues</h3>${issues.length ? `<ul class="detail-list">${issues.slice(0, 40).map((issue) => `<li><b>${esc(issue.severity)}</b> · ${esc(issue.title)}${issue.pages?.length > 1 ? ` <small>(${issue.pages.length} pages)</small>` : ""}</li>`).join("")}</ul>` : '<p class="muted">Nothing broken was observed. This says the pages are served without structural defects, not that the site works.</p>'}<h3>Not checked</h3><ul class="detail-list boundary">${(audit.notChecked || []).slice(0, 6).map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
}

function renderRunDetail(run) {
  if (run?.kind === "audit") { renderAuditDetail(run.audit); return; }
  if (!run?.report) { $("#run-detail").innerHTML = '<div class="empty">Select a completed run to inspect its evidence.</div>'; return; }
  const report = run.report;
  const contracts = report.contracts || [];
  $("#run-detail").innerHTML = `<div class="run-detail-head"><div><p class="eyebrow">${esc(report.gate?.failed ? "BLOCKED" : report.inconclusive ? "INCONCLUSIVE" : "RELEASE RUN")}</p><h2>${esc(report.headline || "Release gate completed")}</h2><small><code>${esc(run.id)}</code> · ${compactDate(run.createdAt)}</small></div>${reportLink(report, "Visual report")}</div><div class="run-stats"><div><strong>${report.screensExplored || 0}</strong><small>states</small></div><div><strong>${report.actionsPerformed || 0}</strong><small>actions</small></div><div><strong>${contracts.filter((item) => item.passed).length}/${contracts.length}</strong><small>contracts</small></div><div><strong>${report.findingCounts?.total ?? (report.findings || []).length}</strong><small>findings</small></div></div><h3>Decision rationale</h3><ul class="detail-list">${(report.gate?.reasons || ["No blocking gate reason reported."]).map((item) => `<li>${esc(item)}</li>`).join("")}</ul><h3>Deterministic contracts</h3>${contracts.length ? contracts.map((contract) => `<div class="contract-result"><span class="${contract.passed ? "pass" : "fail"}">${contract.passed ? "✓" : "×"}</span><div><strong>${esc(contract.title || contract.name || contract.path)}</strong><small>${esc(contract.detail || contract.path || "Deterministic replay")}</small></div></div>`).join("") : '<p class="muted">No committed release contracts applied to this target.</p>'}<h3>What Tapp checked</h3><ul class="detail-list">${(report.checkedFor || []).slice(0, 8).map((item) => `<li>${esc(item)}</li>`).join("")}</ul><h3>Not checked</h3><ul class="detail-list boundary">${(report.notChecked || []).slice(0, 8).map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
}

const chatTime = (value) => new Intl.DateTimeFormat(undefined, { hour:"numeric", minute:"2-digit" }).format(new Date(value));

function renderChat() {
  const node = $("#chat-transcript");
  const stickToBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 24;
  node.innerHTML = state.transcript.map((entry) => `<div class="chat-bubble ${esc(entry.kind || "")} ${esc(entry.severity || "")}">${esc(entry.text)}<small>${chatTime(entry.at)}</small></div>`).join("")
    + (state.activeJob ? '<div class="chat-bubble typing">tapp is working…</div>' : "");
  if (stickToBottom) node.scrollTop = node.scrollHeight;
}

// The transcript is the engine's own progress log, bubble per entry. Phase changes get the
// `phase` style; everything else is narration of what actually happened.
function syncTranscriptFromJob(name, job) {
  const key = job.id;
  if (state.transcriptSource !== key) { state.transcript = [{ at: job.createdAt, kind: "phase", text: `${pretty(name)} started` }]; state.transcriptSource = key; }
  const seen = state.transcript.length - 1;
  for (const entry of job.progress.slice(seen)) {
    const text = String(entry.text || "").trim().replace(/\s+/g, " ").slice(0, 220).replace(/(.{219}).+/, "$1…");
    if (!text) continue;
    const last = state.transcript.at(-1);
    if (last && last.text === text) continue;
    state.transcript.push({ at: entry.at, kind: entry.phase === "explore" || entry.phase === "runtime" ? "" : "phase", text });
  }
}

function finishTranscript(name, job) {
  if (job.status === "failed") { state.transcript.push({ at: job.completedAt || new Date().toISOString(), kind: "failed", text: job.error?.message || `${pretty(name)} failed` }); return; }
  const report = job.result?.report || job.result;
  const findings = report?.findings || (report?.issues || []);
  for (const finding of findings.slice(0, 12)) {
    const severity = String(finding.severity || "info").toLowerCase();
    state.transcript.push({ at: job.completedAt || new Date().toISOString(), kind: "finding", severity, text: `${pretty(severity)} issue${finding.screen ? ` on ${finding.screen}` : ""}: ${finding.title || finding.message || finding.type}` });
  }
  const summary = report?.headline
    || (name === "gate" ? (job.result?.passed === false ? "Release gate blocked this revision." : "Release gate completed.")
    : name === "audit" ? `Audit complete — ${job.result?.pagesAudited || 0} page(s), ${job.result?.issueCount || 0} distinct issue(s), nothing clicked.`
    : `${pretty(name)} completed`);
  state.transcript.push({ at: job.completedAt || new Date().toISOString(), kind: "summary", text: summary });
}

function seedIdleTranscript() {
  if (state.transcriptSource) return;
  const latest = latestRun();
  const report = latest?.report;
  state.transcript = report
    ? [{ at: latest.createdAt, kind: "summary", text: `Last run: ${report.headline || "release run completed"} · ${report.screensExplored || 0} states · ${(report.findings || []).length} findings` }]
    : [{ at: new Date().toISOString(), kind: "phase", text: state.project?.state?.inspected ? "Ready. Run a release check to watch Tapp build, launch and explore the real app." : "Inspecting the project…" }];
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
    target ? `<span><b>${esc(pretty(target.platform))}</b> · ${esc(target.name)}</span>` : "<span>No target selected</span>",
    runner ? `<span>${esc(runner.label)} · ${esc(pretty(runner.status))}</span>` : "",
    `<span>Idle · ${target ? "Ready for the next release check" : "Choose a target to run"}</span>`,
  ].filter(Boolean).join("");
}

function renderProject() {
  const project = state.project;
  renderRepositoryChrome();
  if (!project?.connected) {
    // No repository: the Studio is still a run viewer for website audits.
    if (state.audits.length && state.activeView === "runs") { showProduct(); renderRuns(); return; }
    showSourceOnboarding();
    renderRuns();
    return;
  }
  showProduct();
  $("#app-name").textContent = project.application?.name || "Unnamed product";
  const platforms = project.application?.platforms?.map(pretty).join(" · ") || "Targets not inspected";
  $("#app-summary").textContent = `${platforms} · ${project.capabilities?.length || 0} known capabilities`;
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
  $("#privacy-note-title").textContent = local ? "Your code stays on this machine." : "Your repository stays in your private Tapp workspace.";
}

async function refresh() {
  [state.project, state.live, { audits: state.audits = [] }] = await Promise.all([api("/api/project"), api("/api/live-session"), api("/api/audits").catch(() => ({ audits: [] }))]);
  renderProject();
}

async function runOperation(name, body = {}) {
  if (state.activeJob) throw new Error("Another operation is still running");
  const started = await api(`/api/operations/${name}`, { method:"POST", body:JSON.stringify(body) });
  state.activeJob = started.job.id;
  const drawer = $("#operation-drawer");
  drawer.classList.remove("hidden");
  $("#operation-title").textContent = name === "audit" ? "Read-only audit" : pretty(name);
  $("#operation-progress").textContent = "Starting";
  $("#operation-progress-bar").style.width = "6%";
  syncTranscriptFromJob(name, started.job);
  if ($("#product-shell").classList.contains("hidden") === false) { renderCommandState(started.job, name); renderChat(); }
  try {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 650));
      const job = await api(`/api/jobs/${state.activeJob}`);
      const progress = job.progress.at(-1);
      $("#operation-progress").textContent = progress?.text || "Working…";
      const ratio = progress?.current && progress?.total ? Math.min(92, Math.round(progress.current / progress.total * 100)) : Math.min(88, 8 + job.progress.length * 4);
      $("#operation-progress-bar").style.width = `${ratio}%`;
      syncTranscriptFromJob(name, job);
      if ($("#product-shell").classList.contains("hidden") === false) { renderCommandState(job, name); renderChat(); }
      const screen = [...job.progress].reverse().find((entry) => entry.screen)?.screen;
      if (screen && !state.live?.active) $("#live-screen-title").textContent = screen;
      if (job.frame && !state.jobHasFrame) { state.jobHasFrame = true; refreshLiveFrame(); }
      if (operationIsPending(job.status)) continue;
      finishTranscript(name, job);
      if (job.status === "failed") throw new Error(job.error?.message || "Operation failed");
      if (job.status !== "completed") throw new Error(`Operation ended in an unknown '${job.status}' state`);
      $("#operation-progress-bar").style.width = "100%";
      if (name === "session-act" && job.result.status !== "ok") toast(job.result.detail || `The action ended with ${job.result.status}`, true);
      else if (name === "session-save-flow") toast(`Saved ${job.result.path} as a reviewable deterministic Flow`);
      else if (name === "gate" && job.result.passed === false) toast("The release gate blocked this revision. Tapp did not soften the result.", true);
      else if (name === "audit") toast(`Audited ${job.result.pagesAudited} page(s) — ${job.result.issueCount} distinct issue(s)`);
      else toast(`${pretty(name)} completed`);
      return job.result;
    }
  } finally {
    if (state.jobHasFrame) { state.jobHasFrame = false; await new Promise((resolve) => setTimeout(resolve, 200)); stopLiveFrames(); }
    state.activeJob = null;
    try {
      await refreshSession();
      await refresh();
    } finally {
      // The operation is not visually complete until the resulting snapshot/frame has rendered.
      drawer.classList.add("hidden");
    }
  }
}

async function auditWebsite(url) {
  const trimmed = String(url || "").trim();
  if (!/^https?:\/\//i.test(trimmed)) { toast("Enter an http(s) URL to audit", true); return; }
  const result = await runOperation("audit", { url: trimmed });
  state.selectedRunId = result?.capture?.id || state.selectedRunId;
  showProduct();
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
  const liveControl = event.target.closest("[data-live-control]");
  if (liveControl) {
    const target = liveControl.dataset.liveTarget;
    $("#live-action-target").value = target;
    if (liveControl.dataset.liveInput === "true") {
      $("#live-action-text").focus();
    } else {
      runOperation("session-act", { action:"tap", id:target }).catch((error) => toast(error.message, true));
    }
  }
});

document.addEventListener("submit", (event) => {
  const form = event.target.closest("form.audit-form");
  if (!form) return;
  event.preventDefault();
  auditWebsite(form.elements.url.value).catch((error) => toast(error.message, true));
});

$$("[data-brand-home]").forEach((button) => button.addEventListener("click", () => state.project?.connected ? (showProduct(), activateView("overview")) : showSourceOnboarding()));
$("#command-run").addEventListener("click", () => runOperation("initialize", operationPayload({ explore:true })).catch((error) => toast(error.message, true)));
$("#refresh-project").addEventListener("click", () => refresh().catch((error) => toast(error.message, true)));
$("#change-source").addEventListener("click", showSourceOnboarding);
$("#repository-switcher").addEventListener("change", async (event) => {
  try { await api("/api/repositories/select", { method:"POST", body:JSON.stringify({ id:event.target.value }) }); state.selectedTargetId = ""; await refreshSession(); await refresh(); } catch (error) { toast(error.message, true); }
});
$("#explore").addEventListener("click", () => runOperation("initialize", operationPayload({ explore:true })).catch((error) => toast(error.message, true)));
$("#start-session").addEventListener("click", () => runOperation("session-start", operationPayload()).catch((error) => toast(error.message, true)));
$("#refresh-live-session").addEventListener("click", () => runOperation("session-act", { action:"tree" }).catch((error) => toast(error.message, true)));
$("#end-session").addEventListener("click", () => runOperation("session-end").catch((error) => toast(error.message, true)));
$("#save-live-flow").addEventListener("click", () => { const name=$("#live-flow-name").value.trim(); if (!name) { toast("Name the Flow before saving it", true); return; } runOperation("session-save-flow", { name }).catch((error) => toast(error.message, true)); });
$("#live-tap").addEventListener("click", () => { const id=$("#live-action-target").value.trim(); if (!id) { toast("Choose or enter a semantic target", true); return; } runOperation("session-act", { action:"tap", id }).catch((error) => toast(error.message, true)); });
$("#live-type").addEventListener("click", () => { const id=$("#live-action-target").value.trim(), text=$("#live-action-text").value; if (!id) { toast("Choose or enter a field", true); return; } runOperation("session-act", { action:"type", id, text }).catch((error) => toast(error.message, true)); });
$("#live-back").addEventListener("click", () => runOperation("session-act", { action:"back" }).catch((error) => toast(error.message, true)));
$("#live-swipe").addEventListener("click", () => runOperation("session-act", { action:"swipe", direction:"up" }).catch((error) => toast(error.message, true)));
$("#run-gate").addEventListener("click", () => runOperation("gate", operationPayload()).catch((error) => toast(error.message, true)));

try {
  await refreshSession();
  await refresh();
  // A repository supplied by `tapp app /path` is inspected immediately, then stops for an
  // explicit target choice when detection is ambiguous.
  if (state.project?.connected && !state.project?.state?.inspected) await runOperation("initialize", { write:true });
} catch (error) { toast(error.message, true); }

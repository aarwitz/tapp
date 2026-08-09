import { customerProductContract } from "./product-contract.js";
import { operationIsPending, productJourneyFlags } from "./view-model.js";

const API_BASE = String(document.querySelector('meta[name="tapp-api-base"]')?.content || "").replace(/\/$/, "");
const LOGIN_URL = String(document.querySelector('meta[name="tapp-login-url"]')?.content || "");
function apiRoute(route) {
  if (!API_BASE) return route;
  if (route === "/api" || route.startsWith("/api/")) return `${API_BASE}${route.slice(4)}`;
  if (route === "/evidence" || route.startsWith("/evidence/")) return `${API_BASE}${route}`;
  return route;
}

const state = {
  csrf: "", session: null, project: null, activeJob: null, activeView: "overview",
  selectedTargetId: "", selectedRunId: "", selectedFindingId: "", githubRepositories: [],
  uploadedEntries: [], live: { active:false },
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

function reportLink(report, label = "Open visual evidence") {
  const id = captureId(report);
  return id ? `<a class="button-link" href="${esc(apiRoute(`/evidence/captures/${encodeURIComponent(id)}/report.html`))}" target="_blank" rel="noreferrer">${esc(label)}</a>` : "";
}

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
    ...($("#test-email")?.value ? { testEmail:$("#test-email").value } : {}),
    ...($("#test-password")?.value ? { testPassword:$("#test-password").value } : {}),
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
  activateView(location.hash.slice(1) || state.activeView);
}

function renderRepositoryChrome() {
  const repositories = state.session?.repositories || [];
  const current = state.project?.repository || state.session?.repository;
  const switcher = $("#repository-switcher");
  switcher.classList.toggle("hidden", repositories.length < 1);
  switcher.innerHTML = repositories.map((repository) => `<option value="${esc(repository.id)}" ${repository.id === current?.id ? "selected" : ""}>${esc(repository.name)} · ${esc(repository.source?.kind || "repository")}</option>`).join("") + '<option value="__add__">＋ Add repository…</option>';
  $("#refresh-project").classList.toggle("hidden", !current);
  if (!current) return;
  $("#sidebar-project-name").textContent = state.project?.application?.name || current.name;
  $("#sidebar-project-source").textContent = current.source?.label || current.root || "Repository";
  $("#project-avatar").textContent = (state.project?.application?.name || current.name || "T").slice(0, 1).toUpperCase();
  $("#repository-title").textContent = current.source?.label || current.name;
  $("#repository-detail").textContent = current.source?.note || (current.ephemeral ? "This is an isolated working copy. Review and export changes before updating the source repository." : `Direct local checkout · ${current.root}`);
  $("#settings-repository").innerHTML = `<dl class="settings-dl"><div><dt>Source</dt><dd>${esc(pretty(current.source?.kind))}</dd></div><div><dt>Location</dt><dd><code>${esc(current.root)}</code></dd></div><div><dt>Write mode</dt><dd>${current.ephemeral ? "Isolated review copy" : "Direct checkout"}</dd></div></dl>`;
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
    return `<button type="button" class="target-card ${selected ? "selected" : ""}" data-target-id="${esc(target.id)}" aria-pressed="${selected ? "true" : "false"}"><span class="platform-icon ${esc(target.platform)}">${target.platform === "ios" ? "iOS" : target.platform === "android" ? "A" : "W"}</span><span><b>${esc(target.name)}</b><small>${esc(pretty(target.platform))} · ${esc(detail)}</small><em class="target-state ${esc(target.status)}">${esc(pretty(target.status))}</em></span><i>${selected ? "✓" : ""}</i></button>`;
  }).join("") : '<div class="empty">Inspect the repository to detect iOS, Android, and web targets.</div>';
  const target = currentTarget();
  $("#target-status").textContent = target ? `${pretty(target.platform)} · ${target.name}` : targets.length > 1 ? "Selection required" : "No target selected";
  $("#sidebar-target").textContent = target ? `${pretty(target.platform)} · ${target.name}` : "Select a target";
  $("#sidebar-runner").textContent = target ? (state.session?.runners?.find((runner) => runner.platform === target.platform)?.label || "Runner resolves at execution") : "Runner not selected";
  $("#runtime-row").classList.toggle("hidden", !targets.length);
  $("#serial-field").classList.toggle("hidden", target?.platform !== "android");
  $("#explore").disabled = !target;
  $("#explore").textContent = target && targets.length > 1 ? `Build & explore ${target.name}` : "Build, launch & explore";
  $("#start-session").disabled = !target || state.live?.active === true;
  $("#explore-help").textContent = !target ? (targets.length > 1 ? `Choose one of the ${targets.length} detected targets. Tapp will not select one for you.` : "Inspect to discover a runnable target.")
    : target.platform === "ios" ? "Builds the selected scheme for an iOS simulator, installs it, then explores."
    : target.platform === "android" ? "Builds the selected Gradle application, installs its APK, then explores."
    : "Builds and starts the selected repository web application, then explores it in Chromium.";
}

function refreshLiveFrame() {
  if (!state.live?.active) return;
  const image = $("#live-frame-image");
  const loading = $("#live-frame-loading");
  loading.classList.remove("hidden");
  image.onload = () => loading.classList.add("hidden");
  image.onerror = () => { loading.textContent = "Live frame could not be captured. The semantic controls remain available."; };
  image.src = apiRoute(`/api/live-session/frame?at=${Date.now()}`);
}

function renderLiveSession() {
  const live = state.live || { active:false };
  $("#live-session-panel").classList.toggle("hidden", !live.active);
  if (!live.active) return;
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
  }).join("") : '<div class="empty">The current screen exposed no semantic controls. Add accessibility identifiers or use the map evidence to remediate.</div>';
  refreshLiveFrame();
}

function renderRequirements() {
  const requirements = state.project?.requirements || [];
  $("#requirements").innerHTML = requirements.length ? `<ul class="requirements">${requirements.map((item) => `<li class="${item.severity === "blocking" ? "blocking" : ""}"><span>${item.severity === "blocking" ? "!" : "i"}</span><div><b>${esc(item.message)}</b><small>${esc(item.remediation || "")}</small></div></li>`).join("")}</ul>` : "";
}

function renderMap(map) {
  const nodes = map?.nodes || [];
  const edges = map?.edges || [];
  const controls = nodes.reduce((total, node) => total + (node.controls?.length || 0), 0);
  const covered = nodes.filter((node) => (node.coveredBy?.tasks?.length || 0) + (node.coveredBy?.contracts?.length || 0) > 0).length;
  $("#map-metric").textContent = `${nodes.length} states · ${edges.length} transitions`;
  $("#map-canvas").innerHTML = nodes.length ? nodes.map((node, index) => {
    const tasks = node.coveredBy?.tasks || [], contracts = node.coveredBy?.contracts || [];
    return `<article class="map-node" style="--node-order:${index}"><div class="map-node-title"><span>${String(index + 1).padStart(2, "0")}</span><b>${esc(node.stateLabel || node.name)}</b></div><small>${node.controls?.length || 0} controls · ${esc((node.platforms || []).join("/"))} · ${esc(node.status)}</small><div class="coverage">${tasks.map((item) => `<span class="tag covered">Task: ${esc(item)}</span>`).join("")}${contracts.map((item) => `<span class="tag covered">Contract: ${esc(item)}</span>`).join("")}${!tasks.length && !contracts.length ? '<span class="tag">uncovered</span>' : ""}</div></article>`;
  }).join("") : '<div class="empty">Explore the real product to build its map.</div>';
  $("#coverage-summary").innerHTML = `<p class="eyebrow">MAP COVERAGE</p><dl><div><dt>States</dt><dd>${nodes.length}</dd></div><div><dt>Transitions</dt><dd>${edges.length}</dd></div><div><dt>Controls</dt><dd>${controls}</dd></div><div><dt>Covered states</dt><dd>${covered}/${nodes.length}</dd></div></dl><p class="coverage-honesty">Coverage means observed and contract-linked UI states—not source-line coverage or proof of every possible input.</p>`;
  $("#overview-coverage").innerHTML = `<div><strong>${nodes.length}</strong><small>states observed</small></div><div><strong>${edges.length}</strong><small>transitions</small></div><div><strong>${controls}</strong><small>semantic controls</small></div><div><strong>${nodes.length ? Math.round(covered / nodes.length * 100) : 0}%</strong><small>contract-linked</small></div>`;
  $("#transition-list").innerHTML = edges.length ? `<h3>Observed transitions</h3>${edges.map((edge) => `<div><code>${esc(edge.from)}</code><span>→ ${esc(edge.action?.target || edge.action?.label || edge.action || "action")} →</span><code>${esc(edge.to)}</code><em>${esc(edge.status)}</em></div>`).join("")}` : "";
  $("#screen-list").innerHTML = nodes.length ? `<table><thead><tr><th>Screen / state</th><th>Platform</th><th>Status</th><th>Controls</th><th>Coverage</th></tr></thead><tbody>${nodes.map((node) => `<tr><td><strong>${esc(node.stateLabel || node.name)}</strong><small><code>${esc(node.id)}</code></small></td><td>${esc((node.platforms || []).join(", "))}</td><td>${esc(node.status)}</td><td>${node.controls?.length || 0}</td><td>${(node.coveredBy?.tasks?.length || 0)} Tasks · ${(node.coveredBy?.contracts?.length || 0)} contracts</td></tr>`).join("")}</tbody></table>` : '<div class="empty">No observed screens yet.</div>';
}

function decisionValue(value) { return value === "accepted" ? "approved" : value || "pending"; }

function planHtml(plan) {
  const items = plan?.items || [];
  return items.length ? items.map((item) => `<article class="plan-item" data-id="${esc(item.id)}" data-criticality="${esc(item.criticality)}" data-original="${esc(decisionValue(item.decision))}"><div><div class="plan-title"><h3>${esc(item.title)}</h3><span class="criticality ${esc(item.criticality)}">${esc(item.criticality)}</span></div><p>${esc(item.businessValue)}</p><small class="risk">${esc(item.risk || item.requiredValidation || "Requires real deterministic validation")}</small><div class="plan-meta"><span class="tag">${esc(item.origin)}</span>${(item.platforms || []).map((platform) => `<span class="tag">${esc(platform)}</span>`).join("")}${(item.actors || []).map((actor) => `<span class="tag">actor: ${esc(actor)}</span>`).join("")}${item.generation ? `<span class="tag ${item.generation.trusted ? "covered" : "warning"}">${esc(item.generation.status)}</span>` : ""}</div></div><select aria-label="Decision for ${esc(item.title)}" ${item.origin === "committed" ? "disabled" : ""}><option value="pending" ${decisionValue(item.decision)==="pending"?"selected":""}>Needs review</option><option value="approved" ${decisionValue(item.decision)==="approved"?"selected":""}>Approve</option><option value="deferred" ${decisionValue(item.decision)==="deferred"?"selected":""}>Defer</option><option value="rejected" ${decisionValue(item.decision)==="rejected"?"selected":""}>Reject</option></select></article>`).join("") : '<div class="empty">Inspect and explore to create a grounded release plan.</div>';
}

function renderPlan(plan) {
  const items = plan?.items || [];
  const pending = items.filter((item) => item.decision === "pending").length;
  $("#plan-status").textContent = plan ? `${items.length} proposed · ${pending} pending` : "No plan";
  $("#plan-list").innerHTML = planHtml(plan);
  $("#coverage-plan-list").innerHTML = planHtml(plan);
  $("#contract-count").textContent = state.project?.model?.artifacts?.contracts?.length || 0;
}

function renderArtifacts(model, plan) {
  const tasks = model?.artifacts?.tasks || [];
  const contracts = model?.artifacts?.contracts || [];
  const flows = state.project?.flows || [];
  const items = plan?.items || [];
  const generated = items.filter((item) => item.generation?.path);
  const drafts = generated.filter((item) => item.generation.status !== "promoted");
  const validatedDrafts = drafts.filter((item) => item.generation?.trusted === true || item.generation?.status === "validated-draft");
  const promoted = generated.filter((item) => item.generation.status === "promoted");
  $("#validation-status").textContent = validatedDrafts.length ? "Validated drafts available" : drafts.length ? `${drafts.length} untrusted draft(s)` : promoted.length || contracts.length ? "Promoted suite ready" : "Not generated";
  $("#generate").disabled = !items.some((item) => item.decision === "approved" && item.origin !== "committed" && !item.generation?.path);
  $("#validate-drafts").disabled = !drafts.length || !currentTarget();
  $("#promote").disabled = !validatedDrafts.length;
  const artifacts = [
    ...contracts.map((item) => ({ kind:"Contract", name:item.name, path:item.path, status:"committed", platforms:item.platforms || [] })),
    ...tasks.map((item) => ({ kind:"Task", name:item.name, path:item.path, status:"committed", platforms:item.platforms || Object.keys(item.implementations || {}) })),
    ...flows.map((item) => ({ kind:"Flow", name:item.name, path:item.path, status:item.status, platforms:[item.platform], steps:item.steps })),
    ...drafts.map((item) => ({ kind:"Draft", name:item.name, path:item.generation.path, status:item.generation.trusted ? "validated" : item.generation.status || "untrusted", platforms:item.platforms || [] })),
  ];
  $("#artifact-list").innerHTML = artifacts.length ? artifacts.map((item) => `<div class="artifact"><span><b>${esc(item.kind)}</b> · ${esc(item.name)} <span class="tag ${item.status === "validated" || item.status === "committed" ? "covered" : "warning"}">${esc(item.status)}</span>${item.steps ? ` <small>${item.steps} steps</small>` : ""}</span><span>${(item.platforms || []).map((platform) => `<i>${esc(platform)}</i>`).join("")}<code>${esc(item.path)}</code></span></div>`).join("") : '<div class="empty">No generated or committed Tasks, Flows, or contracts yet.</div>';
}

function latestRun() { return (state.project?.evidence || []).find((run) => run.report) || null; }

function renderDecision(run) {
  const latest = run || latestRun();
  const card = $("#decision-card");
  if (!latest) {
    card.className = "decision-card neutral";
    $("#decision-title").textContent = "Not evaluated";
    $("#decision-detail").textContent = "Run a conclusive release gate to establish evidence.";
    $("#overview-evidence").innerHTML = '<div class="empty">No release run yet.</div>';
    return;
  }
  const report = latest.report;
  const failed = report.gate?.failed === true;
  const verdict = failed ? "blocked" : report.inconclusive ? "caution" : report.verdict || "caution";
  card.className = `decision-card ${verdict}`;
  $("#decision-title").textContent = failed ? "Do not merge" : report.inconclusive ? "Inconclusive" : report.verdict === "ready" ? "Ready to merge" : "Review required";
  $("#decision-detail").textContent = report.gate?.reasons?.join(" · ") || report.headline || "Review the evidence below.";
  $("#overview-evidence").innerHTML = `<div class="latest-run-line"><span class="verdict-dot ${esc(verdict)}"></span><div><strong>${esc(report.headline || pretty(verdict))}</strong><small>${esc(pretty(report.platform || "unknown"))} · ${compactDate(latest.createdAt)} · ${(report.contracts || []).filter((item) => item.passed).length}/${(report.contracts || []).length} contracts passed</small></div></div><p>${esc((report.gate?.reasons || ["No blocking release-gate reason reported."])[0])}</p>${reportLink(report)}`;
}

function renderEvidence(runs) {
  const latest = runs.find((run) => run.report);
  const button = $("#create-baseline");
  button.disabled = state.project?.state?.baselineReady === true || !latest || latest.report?.gate?.failed === true || latest.report?.inconclusive === true;
  button.dataset.runId = latest?.id || "";
  button.textContent = state.project?.state?.baselineReady ? "Baseline active" : "Establish baseline";
  if (!latest) { $("#latest-evidence").innerHTML = '<div class="empty">No release run yet.</div>'; return; }
  const report = latest.report;
  const failed = report.gate?.failed === true;
  $("#latest-evidence").innerHTML = `<article class="evidence-card"><small>Gate</small><strong class="${failed ? "bad" : "good"}">${failed ? "BLOCK" : "PASS"}</strong><small>${esc(report.platform || "unknown")}</small></article><article class="evidence-card"><small>Coverage</small><strong>${report.screensExplored || 0}</strong><small>states · ${report.actionsPerformed || 0} actions</small></article><article class="evidence-card"><small>Contracts</small><strong>${(report.contracts || []).filter((item) => item.passed).length}/${(report.contracts || []).length}</strong><small>deterministic replay</small></article><article class="evidence-card"><small>Findings</small><strong>${report.findingCounts?.total ?? (report.findings || []).length}</strong><small>${report.regression?.new?.length || 0} new vs baseline</small></article><article class="evidence-card wide"><small>Decision rationale</small><h3>${esc(report.headline || "Release gate completed")}</h3><ul class="findings-list">${(report.gate?.reasons || ["No blocking gate reason reported."]).map((item) => `<li>${esc(item)}</li>`).join("")}</ul>${reportLink(report, "Open full report")}</article><article class="evidence-card wide"><small>Known boundary</small><h3>What this run did not prove</h3><ul class="findings-list">${(report.notChecked || ["Only observed and committed journeys are covered."]).slice(0, 5).map((item) => `<li>${esc(item)}</li>`).join("")}</ul></article>`;
}

function allFindings() {
  return (state.project?.evidence || []).flatMap((run) => (run.report?.findings || []).map((finding, index) => ({ ...finding, __runId:run.id, __createdAt:run.createdAt, __id:`${run.id}:${finding.findingKey || finding.id || index}` })));
}

function findingTitle(finding) { return finding.title || finding.message || finding.type || "Finding"; }

function renderFindings() {
  const filter = $("#finding-filter").value;
  const findings = allFindings().filter((finding) => filter === "all" || String(finding.severity).toLowerCase() === filter);
  $("#finding-count").textContent = allFindings().filter((finding) => ["critical", "high"].includes(String(finding.severity).toLowerCase())).length;
  $("#findings-list").innerHTML = findings.length ? findings.map((finding) => `<button class="finding-row ${finding.__id === state.selectedFindingId ? "selected" : ""}" data-finding-id="${esc(finding.__id)}"><span class="severity ${esc(String(finding.severity || "info").toLowerCase())}"></span><span><strong>${esc(findingTitle(finding))}</strong><small>${esc(finding.screen || finding.category || pretty(finding.type))} · ${compactDate(finding.__createdAt)}</small></span><em>${esc(finding.severity || "info")}</em></button>`).join("") : '<div class="empty">No findings match this view.</div>';
  const selected = findings.find((finding) => finding.__id === state.selectedFindingId) || findings[0];
  if (selected) state.selectedFindingId = selected.__id;
  $("#finding-detail").innerHTML = selected ? `<p class="eyebrow">${esc(selected.severity || "FINDING")}</p><h2>${esc(findingTitle(selected))}</h2><p>${esc(selected.description || selected.detail || "Tapp recorded this behavior during the release run.")}</p><dl class="detail-dl"><div><dt>Screen</dt><dd>${esc(selected.screen || "—")}</dd></div><div><dt>Category</dt><dd>${esc(pretty(selected.category || selected.type || "unknown"))}</dd></div><div><dt>Target</dt><dd>${esc(selected.target || "—")}</dd></div><div><dt>Run</dt><dd><code>${esc(selected.__runId)}</code></dd></div></dl>${selected.evidence ? `<h3>Evidence</h3><pre>${esc(typeof selected.evidence === "string" ? selected.evidence : JSON.stringify(selected.evidence, null, 2))}</pre>` : ""}<p class="honesty">Finding acknowledgement and suppression are not yet shared across browser, CLI, and CI, so this browser does not offer a misleading local-only “ignore” button.</p>` : '<div class="empty">Select a finding to inspect its evidence.</div>';
}

function renderRuns(runs) {
  $("#run-count").textContent = runs.length;
  $("#runs-list").innerHTML = runs.length ? runs.map((run) => {
    const report = run.report;
    const failed = report?.gate?.failed === true;
    const status = !report ? run.status : failed ? "blocked" : report.inconclusive ? "inconclusive" : report.verdict || "completed";
    return `<button class="run-row ${run.id === state.selectedRunId ? "selected" : ""}" data-run-id="${esc(run.id)}"><span class="run-status ${esc(status)}">${failed ? "×" : report ? "✓" : "…"}</span><span><strong>${esc(report?.headline || `Release run ${run.id.slice(-8)}`)}</strong><small>${compactDate(run.createdAt)} · ${esc(pretty(report?.platform || "unknown"))}</small></span><em>${esc(pretty(status))}</em></button>`;
  }).join("") : '<div class="empty">No release runs yet.</div>';
  const selected = runs.find((run) => run.id === state.selectedRunId) || runs[0];
  if (selected) state.selectedRunId = selected.id;
  renderRunDetail(selected);
}

function renderRunDetail(run) {
  if (!run?.report) { $("#run-detail").innerHTML = '<div class="empty">Select a completed run to inspect its evidence.</div>'; return; }
  const report = run.report;
  const contracts = report.contracts || [];
  $("#run-detail").innerHTML = `<div class="run-detail-head"><div><p class="eyebrow">${esc(report.gate?.failed ? "BLOCKED" : report.inconclusive ? "INCONCLUSIVE" : "RELEASE RUN")}</p><h2>${esc(report.headline || "Release gate completed")}</h2><small><code>${esc(run.id)}</code> · ${compactDate(run.createdAt)}</small></div>${reportLink(report, "Visual report")}</div><div class="run-stats"><div><strong>${report.screensExplored || 0}</strong><small>states</small></div><div><strong>${report.actionsPerformed || 0}</strong><small>actions</small></div><div><strong>${contracts.filter((item) => item.passed).length}/${contracts.length}</strong><small>contracts</small></div><div><strong>${report.findingCounts?.total ?? (report.findings || []).length}</strong><small>findings</small></div></div><h3>Decision rationale</h3><ul class="detail-list">${(report.gate?.reasons || ["No blocking gate reason reported."]).map((item) => `<li>${esc(item)}</li>`).join("")}</ul><h3>Deterministic contracts</h3>${contracts.length ? contracts.map((contract) => `<div class="contract-result"><span class="${contract.passed ? "pass" : "fail"}">${contract.passed ? "✓" : "×"}</span><div><strong>${esc(contract.title || contract.name || contract.path)}</strong><small>${esc(contract.detail || contract.path || "Deterministic replay")}</small></div></div>`).join("") : '<p class="muted">No committed release contracts applied to this target.</p>'}<h3>What Tapp checked</h3><ul class="detail-list">${(report.checkedFor || []).slice(0, 8).map((item) => `<li>${esc(item)}</li>`).join("")}</ul><h3>Not checked</h3><ul class="detail-list boundary">${(report.notChecked || []).slice(0, 8).map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
}

function renderApplication(model) {
  if (!model) { $("#application-model").innerHTML = '<div class="empty">Inspect the repository to build its Application Model.</div>'; return; }
  const sections = [
    ["Targets", model.targets || [], (item) => `${pretty(item.platform)} · ${item.name}`, (item) => item.status],
    ["Capabilities", model.capabilities || [], (item) => item.name, (item) => item.status],
    ["Actors", model.actors || [], (item) => item.name, (item) => (item.roles || []).join(", ") || item.session],
    ["Business entities", model.entities || [], (item) => item.name, (item) => item.status],
    ["Critical journeys", model.journeys || [], (item) => item.name, (item) => item.criticality],
    ["Revenue paths", model.revenuePaths || [], (item) => item.name, (item) => item.criticality],
  ];
  $("#application-model").innerHTML = sections.map(([title, items, label, meta]) => `<article class="panel model-card"><p class="eyebrow">${esc(title.toUpperCase())}</p><strong>${items.length}</strong>${items.length ? `<ul>${items.slice(0, 12).map((item) => `<li><span>${esc(label(item))}</span><small>${esc(meta(item) || "observed")}</small></li>`).join("")}</ul>` : '<p class="muted">Nothing grounded yet.</p>'}</article>`).join("");
}

function renderRunners() {
  $("#runner-list").innerHTML = (state.session?.runners || []).map((runner) => `<div class="runner-row"><span class="runner-dot ${esc(runner.status)}"></span><div><strong>${esc(runner.label)}</strong><small>${esc(pretty(runner.platform))} · ${esc(pretty(runner.status))}${runner.remediation ? ` · ${esc(runner.remediation)}` : ""}</small></div></div>`).join("");
  const actors = state.project?.actors || [];
  $("#actor-list").innerHTML = actors.length ? actors.map((actor) => `<div class="actor-row"><span>${esc(actor.name.slice(0, 1).toUpperCase())}</span><div><strong>${esc(actor.name)}</strong><small>${esc((actor.roles || []).join(", ") || actor.session || "actor")} · ${(actor.credentialRequirements || []).length} credential binding(s)</small></div></div>`).join("") : '<p class="muted">No actors are configured. Tapp will ask only when a reviewed journey requires one.</p>';
}

function renderJourney(status) {
  const flags = productJourneyFlags({ status, hasTarget:!!currentTarget(), hasEvidence:(state.project?.evidence || []).some((run) => run.report) });
  $$(".journey button").forEach((button, index) => button.classList.toggle("done", !!flags[index]));
}

function renderProject() {
  const project = state.project;
  renderRepositoryChrome();
  if (!project?.connected) { showSourceOnboarding(); return; }
  showProduct();
  $("#app-name").textContent = project.application?.name || "Unnamed product";
  const platforms = project.application?.platforms?.map(pretty).join(" · ") || "Targets not inspected";
  $("#app-summary").textContent = `${platforms} · ${project.capabilities?.length || 0} known capabilities · ${project.actors?.length || 0} configured actors. One model and evidence contract across every interface.`;
  $("#connect-status").textContent = project.state.inspected ? (project.state.explored ? "Observed" : "Inspected") : "Not inspected";
  renderTargets();
  renderRequirements();
  renderMap(project.map);
  renderPlan(project.plan);
  renderArtifacts(project.model, project.plan);
  renderDecision();
  renderEvidence(project.evidence || []);
  renderRuns(project.evidence || []);
  renderFindings();
  renderApplication(project.model);
  renderRunners();
  renderLiveSession();
  renderJourney(project.state);
}

async function refreshSession() {
  state.session = await api("/api/session");
  state.csrf = state.session.csrfToken;
  const local = state.session.mode === "local";
  $("#mode-pill").textContent = local ? "Local engine · private" : "Execution · local Mac";
  $("#privacy-note-title").textContent = local ? "Your code stays on this machine in local mode." : "Your repository stays in your private Tapp workspace.";
  $("#privacy-note-detail").textContent = local ? "Ordinary exploration, replay, and merge decisions are deterministic and require no API key." : "Builds and application runs execute on your connected outbound runner; Render remains the control plane.";
  if (!local) {
    $("#github-source-copy").textContent = "Repository upload works now. GitHub App connection will add selected-repository import without changing the product workflow.";
    $("#github-source-note").textContent = "Use This Mac now; GitHub can be added independently later.";
    const result = await api("/api/repositories/local");
    $("#local-repositories").innerHTML = result.repositories?.length
      ? result.repositories.map(repo=>`<button class="primary" data-local-runner="${esc(repo.runnerId)}" data-local-repository="${esc(repo.id)}">Use ${esc(repo.name)} <small>${esc(repo.runnerName)}${repo.branch ? ` · ${esc(repo.branch)}`:""}</small></button>`).join("")
      : '<small>Start the Tapp runner on this Mac to make local checkouts available.</small>';
  }
}

async function refresh() {
  [state.project, state.live] = await Promise.all([api("/api/project"), api("/api/live-session")]);
  renderProject();
}

async function runOperation(name, body = {}) {
  if (state.activeJob) throw new Error("Another product operation is still running");
  const started = await api(`/api/operations/${name}`, { method:"POST", body:JSON.stringify(body) });
  state.activeJob = started.job.id;
  const drawer = $("#operation-drawer");
  drawer.classList.remove("hidden");
  $("#operation-title").textContent = pretty(name);
  $("#operation-progress").textContent = "Starting operation";
  $("#operation-progress-bar").style.width = "6%";
  try {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 650));
      const job = await api(`/api/jobs/${state.activeJob}`);
      const progress = job.progress.at(-1);
      $("#operation-progress").textContent = progress?.text || "Working…";
      const ratio = progress?.current && progress?.total ? Math.min(92, Math.round(progress.current / progress.total * 100)) : Math.min(88, 8 + job.progress.length * 4);
      $("#operation-progress-bar").style.width = `${ratio}%`;
      if (operationIsPending(job.status)) continue;
      if (job.status === "failed") throw new Error(job.error?.message || "Operation failed");
      if (job.status !== "completed") throw new Error(`Operation ended in an unknown '${job.status}' state`);
      $("#operation-progress-bar").style.width = "100%";
      if (name === "ci-preview") { $("#ci-preview").textContent = job.result.workflow; $("#ci-preview").classList.remove("hidden"); }
      if (name === "session-act" && job.result.status !== "ok") toast(job.result.detail || `The action ended with ${job.result.status}`, true);
      else if (name === "session-save-flow") toast(`Saved ${job.result.path} as a reviewable deterministic Flow`);
      else if (name === "gate" && job.result.passed === false) toast("The release gate blocked this revision. Tapp did not soften the result.", true);
      else toast(`${pretty(name)} completed`);
      return job.result;
    }
  } finally {
    state.activeJob = null;
    try {
      await refreshSession();
      await refresh();
    } finally {
      // The operation is not visually complete until the resulting canonical
      // product snapshot/frame has rendered. Hiding this earlier caused stale
      // decisions and black loading frames to flash after successful work.
      drawer.classList.add("hidden");
    }
  }
}

async function beginRepositoryJourney() {
  await runOperation("initialize", { write:true });
  const targets = state.project?.targets || [];
  chooseDefaultTarget();
  const target = currentTarget();
  if (targets.length !== 1) {
    if (targets.length > 1) toast("Repository inspected. Choose which target Tapp should build and explore.");
    return;
  }
  if (!target || target.status !== "configured") {
    toast("Repository inspected. Resolve the reported target requirement before Tapp builds it.", true);
    return;
  }
  toast(`Detected ${pretty(target.platform)} target ${target.name}. Building and exploring now.`);
  await runOperation("initialize", operationPayload({ explore:true }));
}

const BLOCKED_UPLOAD_DIRECTORIES = new Set([".git", ".gradle", ".next", ".DS_Store", "Carthage", "DerivedData", "Pods", "build", "dist", "node_modules", "vendor"]);

function normalizeInputFiles(fileList) {
  const files = [...fileList];
  const prefix = files[0]?.webkitRelativePath?.split("/")[0] || "repository";
  return files.flatMap((file) => {
    const raw = file.webkitRelativePath || file.name;
    const parts = raw.split("/");
    if (parts[0] === prefix && parts.length > 1) parts.shift();
    if (!parts.length || parts.some((part) => BLOCKED_UPLOAD_DIRECTORIES.has(part))) return [];
    return [{ file, path:parts.join("/") }];
  });
}

async function entriesFromWebkitEntry(entry, prefix = "") {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    return [{ file, path:`${prefix}${entry.name}` }];
  }
  if (!entry.isDirectory || BLOCKED_UPLOAD_DIRECTORIES.has(entry.name)) return [];
  const reader = entry.createReader();
  const children = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    children.push(...batch);
  }
  const nextPrefix = prefix ? `${prefix}${entry.name}/` : "";
  return (await Promise.all(children.map((child) => entriesFromWebkitEntry(child, nextPrefix)))).flat();
}

async function entriesFromDrop(event) {
  const items = [...event.dataTransfer.items];
  const entries = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) {
    const rootName = entries.length === 1 && entries[0].isDirectory ? entries[0].name : "repository";
    const files = (await Promise.all(entries.map((entry) => entriesFromWebkitEntry(entry)))).flat();
    return { name:rootName, entries:files };
  }
  return { name:"repository", entries:[...event.dataTransfer.files].map((file) => ({ file, path:file.name })) };
}

// The webkitdirectory input (and some drop implementations) silently exclude hidden
// entries, which destroys committed .tapp/ config. The File System Access picker
// enumerates hidden files, so it is preferred wherever it exists.
async function entriesFromDirectoryHandle(handle, prefix = "") {
  const entries = [];
  for await (const child of handle.values()) {
    if (BLOCKED_UPLOAD_DIRECTORIES.has(child.name)) continue;
    if (child.kind === "file") entries.push({ file:await child.getFile(), path:`${prefix}${child.name}` });
    else if (child.kind === "directory") entries.push(...await entriesFromDirectoryHandle(child, `${prefix}${child.name}/`));
  }
  return entries;
}

async function chooseFolder() {
  if (!window.showDirectoryPicker) { $("#folder-input").click(); return; }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode:"read" });
  } catch (error) {
    if (error?.name === "AbortError") return;
    $("#folder-input").click();
    return;
  }
  await uploadRepository(handle.name, await entriesFromDirectoryHandle(handle), { hiddenComplete:true });
}

async function uploadRepository(name, entries, { hiddenComplete = false } = {}) {
  if (!entries.length) throw new Error("The selected folder contained no uploadable source files");
  if (state.activeJob) throw new Error("Another product operation is still running");
  state.activeJob = "repository-upload";
  const drawer = $("#operation-drawer");
  drawer.classList.remove("hidden");
  $("#operation-title").textContent = "Import local repository";
  $("#operation-progress-bar").style.width = "2%";
  let upload;
  try {
    const bytes = entries.reduce((total, entry) => total + entry.file.size, 0);
    upload = await api("/api/repositories/uploads", { method:"POST", body:JSON.stringify({ name, expectedFiles:entries.length, expectedBytes:bytes }) });
    let cursor = 0;
    let completed = 0;
    const worker = async () => {
      while (cursor < entries.length) {
        const entry = entries[cursor++];
        $("#operation-progress").textContent = `Uploading ${entry.path} · ${completed}/${entries.length}`;
        const response = await fetch(apiRoute(`/api/repositories/uploads/${upload.id}/files`), { method:"PUT", headers:{ "content-type":"application/octet-stream", "x-tapp-csrf":state.csrf, "x-tapp-relative-path":encodeURIComponent(entry.path) }, body:entry.file });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `Could not upload ${entry.path}`);
        completed += 1;
        $("#operation-progress-bar").style.width = `${Math.max(3, Math.round(completed / entries.length * 94))}%`;
      }
    };
    await Promise.all(Array.from({ length:Math.min(4, entries.length) }, worker));
    await api(`/api/repositories/uploads/${upload.id}/complete`, { method:"POST", body:"{}" });
    $("#operation-progress-bar").style.width = "100%";
    const hasHiddenEntries = entries.some((entry) => entry.path.split("/").some((part) => part.startsWith(".")));
    if (!hiddenComplete && !hasHiddenEntries) {
      toast("Imported, but no hidden files (like .tapp/) came through — this browser's folder picker skips them. Committed Tapp config was not uploaded.", true);
    } else {
      toast("Repository imported into an isolated Tapp workspace");
    }
  } catch (error) {
    if (upload?.id) await api(`/api/repositories/uploads/${upload.id}`, { method:"DELETE" }).catch(() => {});
    throw error;
  } finally {
    state.activeJob = null;
    drawer.classList.add("hidden");
    await refreshSession();
    await refresh();
  }
  await beginRepositoryJourney();
}

async function openGithubDialog() {
  const dialog = $("#github-dialog");
  dialog.showModal();
  $("#github-repositories").innerHTML = '<div class="empty">Loading authorized repositories…</div>';
  try {
    const result = await api("/api/repositories/github");
    state.githubRepositories = result.repositories || [];
    if (result.unavailable) {
      $("#github-repositories").innerHTML = `<div class="remediation"><strong>GitHub connection is not configured yet</strong><p>${esc(result.unavailable)}</p></div>`;
    } else renderGithubRepositories();
  } catch (error) {
    $("#github-repositories").innerHTML = `<div class="remediation"><strong>GitHub needs attention</strong><p>${esc(error.message)}</p></div>`;
  }
}

function renderGithubRepositories() {
  const query = $("#github-search").value.trim().toLowerCase();
  const repositories = state.githubRepositories.filter((repository) => !query || repository.nameWithOwner.toLowerCase().includes(query));
  $("#github-repositories").innerHTML = repositories.length ? repositories.map((repository) => `<button type="button" data-github-repository="${esc(repository.nameWithOwner)}"><span class="repository-icon">${esc(repository.name.slice(0, 1).toUpperCase())}</span><span><strong>${esc(repository.nameWithOwner)}</strong><small>${repository.private ? "Private" : "Public"} · ${esc(repository.permission || "authorized")} · ${esc(repository.defaultBranch || "default branch")}</small></span><em>Connect</em></button>`).join("") : '<div class="empty">No repositories match this search.</div>';
}

async function connectGithub(repository) {
  $("#github-dialog").close();
  await runOperation("connect-github", { repository });
  await beginRepositoryJourney();
}

function reviewDecisions() {
  const decisions = { approve:[], reject:[], defer:[] };
  $$("#plan-list .plan-item").forEach((node) => {
    const value = node.querySelector("select").value;
    if (value === node.dataset.original) return;
    if (value === "approved") decisions.approve.push(node.dataset.id);
    if (value === "rejected") decisions.reject.push(node.dataset.id);
    if (value === "deferred") decisions.defer.push(node.dataset.id);
  });
  return decisions;
}

document.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton && $("#product-shell").contains(viewButton)) activateView(viewButton.dataset.view);
  const targetButton = event.target.closest("[data-target-id]");
  if (targetButton) {
    state.selectedTargetId = targetButton.dataset.targetId;
    localStorage.setItem(targetStorageKey(), state.selectedTargetId);
    renderTargets(); renderJourney(state.project.state); renderArtifacts(state.project.model, state.project.plan);
  }
  const runButton = event.target.closest("[data-run-id]");
  if (runButton) { state.selectedRunId = runButton.dataset.runId; renderRuns(state.project.evidence || []); }
  const findingButton = event.target.closest("[data-finding-id]");
  if (findingButton) { state.selectedFindingId = findingButton.dataset.findingId; renderFindings(); }
  const coverageButton = event.target.closest("[data-coverage-tab]");
  if (coverageButton) {
    $$('[data-coverage-tab]').forEach((button) => button.classList.toggle("active", button === coverageButton));
    $$('[data-coverage-panel]').forEach((panel) => panel.classList.toggle("active", panel.dataset.coveragePanel === coverageButton.dataset.coverageTab));
  }
  const githubButton = event.target.closest("[data-github-repository]");
  if (githubButton) connectGithub(githubButton.dataset.githubRepository).catch((error) => toast(error.message, true));
  const jump = event.target.closest("[data-jump]");
  if (jump) {
    const destination = jump.dataset.jump;
    const view = ["map"].includes(destination) ? "coverage" : ["contracts", "validate"].includes(destination) ? "contracts" : destination === "evidence" ? "settings" : "overview";
    activateView(view);
    setTimeout(() => document.getElementById(destination)?.scrollIntoView({ behavior:"smooth", block:"start" }), 20);
  }
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

$("#brand-home").addEventListener("click", () => state.project?.connected ? activateView("overview") : showSourceOnboarding());
$("#refresh-project").addEventListener("click", () => refresh().catch((error) => toast(error.message, true)));
$("#change-source").addEventListener("click", showSourceOnboarding);
$("#settings-add-repository").addEventListener("click", showSourceOnboarding);
$("#browse-folder").addEventListener("click", () => chooseFolder().catch((error) => toast(error.message, true)));
$("#repository-drop-zone").addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); chooseFolder().catch((error) => toast(error.message, true)); } });
$("#folder-input").addEventListener("change", (event) => {
  const entries = normalizeInputFiles(event.target.files);
  const name = event.target.files[0]?.webkitRelativePath?.split("/")[0] || "repository";
  uploadRepository(name, entries).catch((error) => toast(error.message, true));
  event.target.value = "";
});
for (const name of ["dragenter", "dragover"]) $("#repository-drop-zone").addEventListener(name, (event) => { event.preventDefault(); $("#repository-drop-zone").classList.add("dragging"); });
for (const name of ["dragleave", "drop"]) $("#repository-drop-zone").addEventListener(name, (event) => { event.preventDefault(); $("#repository-drop-zone").classList.remove("dragging"); });
$("#repository-drop-zone").addEventListener("drop", async (event) => { try { const dropped = await entriesFromDrop(event); await uploadRepository(dropped.name, dropped.entries); } catch (error) { toast(error.message, true); } });
$("#connect-github").addEventListener("click", () => openGithubDialog());
$("#github-search").addEventListener("input", renderGithubRepositories);
$("#repository-switcher").addEventListener("change", async (event) => {
  if (event.target.value === "__add__") { showSourceOnboarding(); return; }
  try { await api("/api/repositories/select", { method:"POST", body:JSON.stringify({ id:event.target.value }) }); state.selectedTargetId = ""; await refreshSession(); await refresh(); } catch (error) { toast(error.message, true); }
});
$("#inspect").addEventListener("click", () => runOperation("initialize", { write:true }).catch((error) => toast(error.message, true)));
$("#explore").addEventListener("click", () => runOperation("initialize", operationPayload({ explore:true })).catch((error) => toast(error.message, true)));
$("#start-session").addEventListener("click", () => runOperation("session-start", operationPayload()).catch((error) => toast(error.message, true)));
$("#refresh-live-session").addEventListener("click", () => runOperation("session-act", { action:"tree" }).catch((error) => toast(error.message, true)));
$("#end-session").addEventListener("click", () => runOperation("session-end").catch((error) => toast(error.message, true)));
$("#save-live-flow").addEventListener("click", () => { const name=$("#live-flow-name").value.trim(); if (!name) { toast("Name the Flow before saving it", true); return; } runOperation("session-save-flow", operationPayload({ name })).catch((error) => toast(error.message, true)); });
$("#live-tap").addEventListener("click", () => { const id=$("#live-action-target").value.trim(); if (!id) { toast("Choose or enter a semantic target", true); return; } runOperation("session-act", { action:"tap", id }).catch((error) => toast(error.message, true)); });
$("#live-type").addEventListener("click", () => { const id=$("#live-action-target").value.trim(), text=$("#live-action-text").value; if (!id) { toast("Choose or enter a field", true); return; } runOperation("session-act", { action:"type", id, text }).catch((error) => toast(error.message, true)); });
$("#live-back").addEventListener("click", () => runOperation("session-act", { action:"back" }).catch((error) => toast(error.message, true)));
$("#live-swipe").addEventListener("click", () => runOperation("session-act", { action:"swipe", direction:"up" }).catch((error) => toast(error.message, true)));
$("#approve-high").addEventListener("click", () => $$("#plan-list .plan-item").forEach((node) => { if (["high", "critical"].includes(node.dataset.criticality) && node.querySelector("select").value === "pending") node.querySelector("select").value = "approved"; }));
$("#defer-rest").addEventListener("click", () => $$("#plan-list .plan-item select").forEach((select) => { if (select.value === "pending") select.value = "deferred"; }));
$("#save-review").addEventListener("click", () => { const decisions = reviewDecisions(); if (![...decisions.approve, ...decisions.reject, ...decisions.defer].length) { toast("No review decisions changed"); return; } runOperation("review", decisions).catch((error) => toast(error.message, true)); });
$("#generate").addEventListener("click", () => runOperation("generate").catch((error) => toast(error.message, true)));
$("#validate-drafts").addEventListener("click", () => runOperation("validate", operationPayload()).catch((error) => toast(error.message, true)));
$("#promote").addEventListener("click", () => runOperation("promote").catch((error) => toast(error.message, true)));
$("#run-gate").addEventListener("click", () => runOperation("gate", operationPayload()).catch((error) => toast(error.message, true)));
$("#create-baseline").addEventListener("click", () => runOperation("baseline", operationPayload({ runId:$("#create-baseline").dataset.runId })).catch((error) => toast(error.message, true)));
$("#preview-ci").addEventListener("click", () => runOperation("ci-preview").catch((error) => toast(error.message, true)));
$("#install-ci").addEventListener("click", () => runOperation("ci-install").catch((error) => toast(error.message, true)));
$("#finding-filter").addEventListener("change", renderFindings);

try {
  await refreshSession();
  await refresh();
  // A repository supplied by `tapp app /path` should enter the same journey as
  // drag/drop and GitHub: inspect immediately, then stop for an explicit target
  // choice when detection is ambiguous.
  if (state.project?.connected && !state.project?.state?.inspected) await runOperation("initialize", { write:true });
} catch (error) { toast(error.message, true); }
  const localButton = event.target.closest("[data-local-repository]");
  if(localButton) api("/api/repositories/local",{method:"POST",body:JSON.stringify({runnerId:localButton.dataset.localRunner,repositoryId:localButton.dataset.localRepository})}).then(async()=>{state.selectedTargetId="";await refreshSession();await refresh();}).catch(error=>toast(error.message,true));

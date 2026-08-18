// Bounded deterministic Android exploration. It intentionally mirrors the
// XCUITest harness's marker contract so report.js, baselines, and the CI gate do
// not know or care which platform produced the evidence.
import fs from "node:fs";
import path from "node:path";
import { AndroidDriver, androidElementKey, isAndroidAppSnapshot } from "./android-driver.js";
import { semanticUiKey } from "./ui-map.js";

const ERROR_RE = /\b(something went wrong|internal server error|an error occurred|failed to load|unhandled exception|has stopped)\b/i;
const DESTRUCTIVE_RE = /\b(delete|remove|purchase|buy now|pay now|reset|erase|unsubscribe|sign out|log out|logout)\b/i;
const AUTH_SUBMIT_RE = /\b(sign[ -]?in|log[ -]?in|continue|submit)\b/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stateHash(snap) {
  return snap.elements.map((e) => `${androidElementKey(e)}:${e.text}:${e.x},${e.y}`).join("|");
}

function inputDescriptors(elements) {
  return elements.filter((e) => /EditText/i.test(e.type)).map((e) => ({
    key: androidElementKey(e), label: e.label || e.id, secure: e.secure,
  }));
}

export function androidMapControls(elements) {
  return elements.filter((element) => /EditText/i.test(element.type) || element.clickable || /Button|Tab|Switch|CheckBox/i.test(element.type))
    .map((element) => ({
      kind: /EditText/i.test(element.type) ? (element.secure ? "secureField" : "field")
        : /Tab/i.test(element.type) ? "tab" : /Switch|CheckBox/i.test(element.type) ? "toggle" : "button",
      type: element.type,
      id: element.id || "",
      resourceId: element.id || "",
      accessibilityId: element.description || "",
      label: /EditText/i.test(element.type) ? (element.label || element.description || element.id) : controlLabel(element),
      secure: !!element.secure,
      enabled: element.enabled !== false,
      hittable: !!element.hittable,
    }));
}

function controlLabel(e) { return e.label || e.text || e.description || e.id; }
function isDestructive(e) {
  return DESTRUCTIVE_RE.test(`${e.label || ""} ${e.text || ""} ${e.description || ""} ${e.id || ""}`.replace(/[_-]+/g, " "));
}

export function isAndroidAuthSubmit(element) {
  return AUTH_SUBMIT_RE.test(`${element?.label || ""} ${element?.text || ""} ${element?.description || ""} ${element?.id || ""}`.replace(/[_-]+/g, " "));
}

export function isAndroidBlankSnapshot(snapshot) {
  const elements = snapshot?.elements || [];
  const meaningful = elements.some((element) =>
    String(element.text || "").trim() ||
    String(element.description || "").trim() ||
    (String(element.id || "").trim() && !/^(android:)?id\/content$/i.test(String(element.id || "").trim()))
  );
  const interactive = elements.some((element) => element.hittable && (element.clickable || /Button|EditText|Tab|Switch|CheckBox/i.test(element.type)));
  return !meaningful && !interactive;
}

export async function exploreAndroid({ appId, apkPath, serial, maxActions = 40, timeoutSec = 300, outDir, testEmail = "", testPassword = "", clearData = true, seedTargets = [], onProgress = () => {}, driver, screenshotDelayMs }) {
  const d = driver || new AndroidDriver({ appId, serial });
  const visualSettleMs = Number.isFinite(screenshotDelayMs) ? Math.max(0, screenshotDelayMs) : (driver ? 0 : 350);
  d.appId = appId;
  await d.ensureDevice();
  if (apkPath) await d.install(apkPath);
  fs.mkdirSync(outDir, { recursive: true });
  const screenshots = path.join(outDir, "screenshots");
  fs.mkdirSync(screenshots, { recursive: true });
  const markersPath = path.join(outDir, "ocqa-markers.txt");
  fs.rmSync(markersPath, { force: true });
  const emit = (kind, payload) => fs.appendFileSync(markersPath, `OCQA_${kind}:${JSON.stringify(payload)}\n`);
  const deadline = Date.now() + timeoutSec * 1000;
  const tried = new Set();
  const visited = new Map();
  let issues = 0;
  let actions = 0;
  const crashExitBaseline = typeof d.latestCrashExitInfo === "function" ? await d.latestCrashExitInfo() : null;
  let snap = await d.launch({ clearData });
  let crashReported = false;

  const reportProcessExit = async (screen, step) => {
    if (typeof d.isProcessAlive !== "function") return false;
    // Android may reveal the launcher before the crashing process disappears from
    // pidof. A one-shot liveness sample made identical crashes scheduler-dependent.
    // Poll only after app ownership is already lost: external intents and ordinary
    // Back boundaries keep the originating process alive and remain boundaries.
    let alive = await d.isProcessAlive();
    let latestCrash = typeof d.latestCrashExitInfo === "function" ? await d.latestCrashExitInfo() : null;
    const exitDeadline = Date.now() + 2_000;
    while (alive && (!latestCrash || latestCrash === crashExitBaseline) && Date.now() < exitDeadline) {
      await sleep(150);
      alive = await d.isProcessAlive();
      latestCrash = typeof d.latestCrashExitInfo === "function" ? await d.latestCrashExitInfo() : null;
    }
    const recordedCrash = !!latestCrash && latestCrash !== crashExitBaseline;
    if ((alive && !recordedCrash) || crashReported) return false;
    crashReported = true;
    emit("ISSUE", { type: "crash", severity: "critical", title: "App process exited during exploration", screen: screen || "Launch", step });
    issues += 1;
    return true;
  };

  if (!isAndroidAppSnapshot(snap, appId)) await reportProcessExit("Launch", 0);

  const normalizedTargets = (Array.isArray(seedTargets) ? seedTargets : []).filter((target) =>
    target?.platform === "android" && target?.status === "planned" && target?.navigation?.status === "replayable" &&
    target.navigation.mode === "ui-map-path" && Array.isArray(target.navigation.steps) && target.navigation.steps.length <= 8
  ).slice(0, 1);

  const recordState = async (snapshot) => {
    if (!isAndroidAppSnapshot(snapshot, appId)) return null;
    const hash = stateHash(snapshot);
    const screen = snapshot.screenTitle;
    if (!visited.has(hash)) {
      visited.set(hash, screen);
      // UIAutomator can expose a fully populated hierarchy a fraction before
      // SurfaceFlinger composites the first app frame. Give real devices one
      // bounded draw interval so retained PNG evidence matches the tree.
      if (visualSettleMs) await sleep(visualSettleMs);
      await d.screenshot(path.join(screenshots, `${String(visited.size).padStart(2, "0")}-${screen.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`)).catch(() => {});
    }
    const inputs = inputDescriptors(snapshot.elements);
    emit("STATE", { screen, hash, elements: snapshot.elements.length, action: actions, role: inputs.some((input) => input.secure) ? "login" : "app", inputs, controls: androidMapControls(snapshot.elements) });
    return { hash, screen, inputs };
  };

  // Replay at most one bounded PR target from the controlled launch state before
  // broad exploration. Every action and resulting state uses the ordinary marker
  // contract, and a miss remains a failed/inconclusive gate target.
  for (const target of normalizedTargets) {
    let failure = "";
    let state = await recordState(snap);
    for (const step of target.navigation.steps) {
      if (!state || actions >= maxActions || Date.now() >= deadline) { failure = "Target path exceeded the exploration budget"; break; }
      const action = step.action;
      const selector = (action.selectors || []).find((item) => ["resourceId", "accessibilityId", "label"].includes(item.kind) && item.value)?.value || action.target;
      let result;
      if (action.type === "back") result = await d.back();
      else result = await d.tap(selector, snap);
      actions += 1;
      emit("ACTION", { type: action.type, target: selector, reason: "pr_ui_map_path", step: actions, screen: state.screen, status: result.status });
      if (result.status !== "ok") { failure = result.detail || `Observed control was not available: ${selector}`; break; }
      const before = state;
      snap = await d.settle();
      state = await recordState(snap);
      if (!state) {
        const crashed = await reportProcessExit(before.screen, actions);
        failure = crashed ? "The application process exited while replaying the UI Map path" : "The UI Map path left the application foreground";
        break;
      }
      emit("TRANSITION", { from: before.screen, to: state.screen, action: selector, changed: before.hash !== state.hash });
      onProgress({ action: actions, max: maxActions, states: visited.size });
    }
    if (!failure && semanticUiKey(snap.screenTitle) !== semanticUiKey(target.node.semanticKey || target.node.name)) {
      failure = `Reached ${snap.screenTitle}, expected ${target.node.name}`;
    }
    if (failure) {
      emit("PR_TARGET", { targetId: target.id, status: "failed", screen: snap.screenTitle, error: failure.slice(0, 160) });
      emit("ISSUE", { type: "pr_target_unreachable", severity: "high", title: failure, screen: snap.screenTitle, step: actions });
      issues += 1;
    } else emit("PR_TARGET", { targetId: target.id, status: "observed", screen: snap.screenTitle });
  }

  while (actions < maxActions && Date.now() < deadline) {
    // UIAutomator can still describe the launcher or a system surface after
    // Back/external navigation. Those are exploration boundaries, never nodes
    // in the application-owned UI Map.
    if (!isAndroidAppSnapshot(snap, appId)) {
      await reportProcessExit(visited.size ? [...visited.values()].at(-1) : "Launch", actions);
      break;
    }
    const recorded = await recordState(snap);
    if (!recorded) break;
    const { hash, screen, inputs } = recorded;
    onProgress({ action: actions, max: maxActions, states: visited.size });

    const visibleText = snap.elements.map((e) => e.text || e.label).filter(Boolean).join(" ");
    if (ERROR_RE.test(visibleText)) {
      emit("ISSUE", { type: "error_surface", severity: "high", title: "Visible error surface", screen, step: actions });
      issues += 1;
    }
    if (isAndroidBlankSnapshot(snap)) {
      emit("ISSUE", { type: "blank_screen", severity: "high", title: "No usable controls or content", screen, step: actions });
      issues += 1;
    }

    // Form values change the state hash. Key field attempts by semantic screen + id,
    // otherwise the explorer repeatedly refills the first field and never submits.
    const unfilled = snap.elements.find((e) => /EditText/i.test(e.type)
      && !tried.has(`${screen}|input|${androidElementKey(e)}`));
    if (unfilled) {
      const key = androidElementKey(unfilled);
      const lower = `${key} ${unfilled.label}`.toLowerCase();
      const value = unfilled.secure || lower.includes("password") ? (testPassword || "TestPass123!")
        : lower.includes("email") ? (testEmail || "test@example.com") : "Tapp test";
      tried.add(`${screen}|input|${key}`);
      const r = await d.type(key, value, snap);
      actions += 1;
      const valueSource = unfilled.secure || lower.includes("password") ? "test-password" : lower.includes("email") ? "test-email" : "generated-text";
      emit("ACTION", { type: "type", target: key, valueSource, reason: "complete_form", step: actions, screen, status: r.status });
      snap = await d.settle();
      continue;
    }

    const candidate = snap.elements.find((e) => {
      const label = controlLabel(e);
      return e.hittable && !/EditText/i.test(e.type) && (e.clickable || /Button|Tab/i.test(e.type))
        && label && !isDestructive(e) && !tried.has(`${hash}|tap|${label}`);
    });
    if (candidate) {
      const target = controlLabel(candidate);
      const loginSubmit = inputs.some((input) => input.secure) && isAndroidAuthSubmit(candidate);
      tried.add(`${hash}|tap|${target}`);
      const before = hash;
      const r = await d.tap(target, snap);
      actions += 1;
      // UIAutomator can miss a short-lived Activity that opens and cleanly
      // returns before its next hierarchy dump. Observe the cheaper Activity
      // signal in parallel so a real transient response is not called dead.
      const activityEffect = r.status === "ok" && typeof d.observeActivityTransition === "function"
        ? d.observeActivityTransition(snap.activity)
        : Promise.resolve(false);
      const [settledSnap, activityEffectObserved] = await Promise.all([d.settle(), activityEffect]);
      snap = settledSnap;
      const after = stateHash(snap);
      emit("ACTION", { type: loginSubmit ? "login_submit" : "tap", target, reason: "untried_control", step: actions, screen, status: r.status });
      if (!isAndroidAppSnapshot(snap, appId)) {
        await reportProcessExit(screen, actions);
        break;
      }
      emit("TRANSITION", { from: screen, to: snap.screenTitle, action: target, changed: before !== after });
      const authFailed = loginSubmit && inputDescriptors(snap.elements).some((input) => input.secure);
      if (r.status === "ok" && authFailed) {
        emit("ISSUE", { type: "auth_failed", severity: "high", title: "Sign-in attempt remained on the login screen", screen, target, step: actions });
        issues += 1;
      } else if (r.status === "ok" && before === after && candidate.clickable && !activityEffectObserved) {
        emit("ISSUE", { type: "unresponsive_element", severity: "medium", title: `Control did not respond: ${target}`, screen, target, step: actions });
        issues += 1;
      }
      continue;
    }

    // Exhausted this state: go back once to expose sibling paths. Stop if back
    // cannot change the state; this is an honest coverage boundary, not a pass.
    const backKey = `${hash}|back`;
    if (!tried.has(backKey)) {
      tried.add(backKey);
      await d.back();
      actions += 1;
      const next = await d.settle();
      emit("ACTION", { type: "back", target: "system back", reason: "state_exhausted", step: actions, screen });
      if (!isAndroidAppSnapshot(next, appId)) {
        await reportProcessExit(screen, actions);
        break;
      }
      emit("TRANSITION", { from: screen, to: next.screenTitle, action: "back", changed: stateHash(next) !== hash });
      if (stateHash(next) !== hash) { snap = next; continue; }
    }
    break;
  }

  const timedOut = Date.now() >= deadline;
  emit("COMPLETE", { actions, states: visited.size, issues, screens: [...new Set(visited.values())].join(","), outcome: timedOut ? "timeout" : "complete", timedOut, ...(timedOut ? { timeoutSeconds: timeoutSec } : {}) });
  onProgress({ action: actions, max: maxActions, states: visited.size });
  return { markersPath, outDir, actions, states: visited.size, issues, timedOut, seedTargets: normalizedTargets };
}

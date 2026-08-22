// Tapp UI Map v1 — the platform-neutral, evidence-grounded graph shared by
// exploration, task/contract authoring, PR selection, CI, MCP, and desktop.
// Keep this dependency-free and deterministic: drivers only emit OCQA markers.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const UI_MAP_SCHEMA_VERSION = 1;

function stableId(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16)}`;
}

function cleanSpace(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function observedWebRoute(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  let parsed;
  try { parsed = new URL(value, "http://tapp.invalid"); } catch { return null; }
  const original = parsed.pathname || "/";
  const redacted = original
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b(?:sk|pk|tok|token)[-_][A-Za-z0-9_-]{12,}\b/g, "<token>")
    .replace(/\b\d{6,}\b/g, "<number>");
  return {
    platform: "web",
    path: redacted,
    replayable: redacted === original && !parsed.search,
    status: "observed",
    ...(parsed.search ? { queryOmitted: true } : {}),
  };
}

export function redactUiText(value) {
  return cleanSpace(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<email>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b(?:sk|pk|tok|token)[-_][A-Za-z0-9_-]{12,}\b/g, "<token>")
    .replace(/\b\d{6,}\b/g, "<number>")
    .slice(0, 160);
}

export function semanticUiKey(value) {
  return redactUiText(value)
    .toLowerCase()
    .replace(/<[^>]+>/g, " dynamic ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function replayStepForEdge(edge, nodes, platform) {
  if (!edge || !["observed", "validated"].includes(edge.status) || edge.confirmed === false) return null;
  if (Array.isArray(edge.platforms) && edge.platforms.length && !edge.platforms.includes(platform)) return null;
  if ((edge.actors || []).length || (edge.preconditions || []).length) return null;
  const type = semanticUiKey(edge.action?.type || "");
  if (!["tap", "back"].includes(type)) return null;
  const observedTarget = redactUiText(edge.action?.target || "");
  const descriptor = observedTarget.match(/^(id|label):(.+)$/i);
  const target = redactUiText(descriptor?.[2] || observedTarget);
  if (!target || /<[^>]+>|\{\{|tab_bar_pos|center_unexplored|_escape|drawer_probe|carousel/i.test(target)) return null;
  const destination = nodes.get(edge.to);
  if (!destination || !["observed", "validated"].includes(destination.status)) return null;
  if (Array.isArray(destination.platforms) && destination.platforms.length && !destination.platforms.includes(platform)) return null;
  const source = nodes.get(edge.from);
  const matchedControl = (source?.controls || []).find((control) =>
    [control.id, control.semanticKey, control.label, ...(control.selectors || []).map((selector) => selector.value)]
      .some((value) => [semanticUiKey(target), semanticUiKey(observedTarget)].includes(semanticUiKey(value)))
  );
  const selectors = mergeUnique([
    ...(matchedControl?.selectors || []),
    ...(edge.action?.selectors || []),
    ...(descriptor ? [{ kind: descriptor[1].toLowerCase() === "id" ? (platform === "android" ? "resourceId" : "accessibilityId") : "label", value: target }] : []),
  ], (selector) => `${selector.kind}:${selector.value}`)
    .filter((selector) => ["testId", "accessibilityId", "resourceId", "cssId", "label"].includes(selector.kind) && selector.value)
    .slice(0, 8);
  return {
    edgeId: edge.id,
    from: edge.from,
    to: edge.to,
    action: { type, target, selectors },
    wait: edge.wait?.type === "condition"
      ? { type: "condition", timeoutMs: Math.max(250, Math.min(30_000, Number(edge.wait.timeoutMs) || 6000)) }
      : { type: "condition", timeoutMs: 6000 },
    expected: { type: "screen", value: destination.semanticKey, name: destination.name },
  };
}

// Produce a bounded deterministic route from the platform's observed navigation
// root to one UI Map node. This is execution infrastructure, not a claim that
// every observed edge is safely replayable: actor/precondition-dependent,
// dynamic, proposed, and unsupported actions are excluded before BFS.
export function replayableUiMapNavigation(map, targetNodeId, platform, { maxSteps = 8, startNodeId = "" } = {}) {
  const limit = Math.max(0, Math.min(12, Number(maxSteps) || 0));
  const nodes = new Map((map?.nodes || []).map((node) => [node.id, node]));
  const target = nodes.get(targetNodeId);
  if (!target) return { status: "blocked", reason: `UI Map target node is missing: ${targetNodeId}` };
  const rootId = startNodeId || map?.app?.navigationRoots?.[platform] || map?.app?.entryNodes?.[platform] || "";
  if (!rootId || !nodes.has(rootId)) return { status: "blocked", reason: `No observed ${platform} navigation root exists in the UI Map` };
  if (rootId === targetNodeId) return {
    status: "replayable", mode: "ui-map-path", provenance: "observed-ui-map",
    entryNodeId: rootId, targetNodeId, steps: [], maxSteps: limit,
  };
  if (limit === 0) return { status: "blocked", reason: "UI Map navigation budget is zero" };

  const adjacency = new Map();
  for (const edge of map?.edges || []) {
    const step = replayStepForEdge(edge, nodes, platform);
    if (!step) continue;
    const list = adjacency.get(edge.from) || [];
    list.push(step);
    adjacency.set(edge.from, list);
  }
  for (const list of adjacency.values()) list.sort((left, right) => left.edgeId.localeCompare(right.edgeId));

  const queue = [{ nodeId: rootId, steps: [] }];
  const visited = new Set([rootId]);
  while (queue.length) {
    const current = queue.shift();
    if (current.steps.length >= limit) continue;
    for (const step of adjacency.get(current.nodeId) || []) {
      if (visited.has(step.to)) continue;
      const steps = [...current.steps, step];
      if (step.to === targetNodeId) return {
        status: "replayable", mode: "ui-map-path", provenance: "observed-ui-map",
        entryNodeId: rootId, targetNodeId, steps, maxSteps: limit,
      };
      visited.add(step.to);
      queue.push({ nodeId: step.to, steps });
    }
  }
  return { status: "blocked", reason: `No bounded replayable ${platform} UI Map path reaches ${target.name || targetNodeId}` };
}

function parseMarkerLine(line) {
  const match = String(line).trim().match(/^OCQA_([A-Z_]+):(\{.*\})$/);
  if (!match) return null;
  try { return { kind: match[1], value: JSON.parse(match[2]) }; } catch { return null; }
}

function selectorList(control) {
  const selectors = [];
  const add = (kind, raw) => {
    const value = redactUiText(raw);
    if (!value || value === "<redacted>") return;
    if (!selectors.some((selector) => selector.kind === kind && selector.value === value)) selectors.push({ kind, value });
  };
  add("testId", control.testId ?? control.selectors?.testId);
  add("accessibilityId", control.accessibilityId ?? control.identifier ?? control.selectors?.accessibilityId);
  add("resourceId", control.resourceId ?? control.id ?? control.selectors?.resourceId);
  add("cssId", control.cssId ?? control.selectors?.cssId);
  add("label", control.label ?? control.name ?? control.placeholder ?? control.selectors?.label);
  add("role", control.role ?? control.selectors?.role);
  return selectors;
}

function normalizeControl(raw, nodeId, platform) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const secure = !!raw.secure;
  const kind = cleanSpace(raw.kind || raw.type || (secure ? "secureField" : "control"));
  const label = secure ? redactUiText(raw.label || raw.placeholder || "Password") : redactUiText(raw.label || raw.name || raw.text || raw.placeholder || raw.id || raw.identifier);
  const selectors = selectorList({ ...raw, label });
  const identity = selectors.find((selector) => selector.kind !== "role")?.value || label || kind;
  if (!identity) return null;
  return {
    id: stableId("control", `${nodeId}|${semanticUiKey(kind)}|${semanticUiKey(identity)}`),
    semanticKey: semanticUiKey(identity),
    kind: kind || "control",
    label: label || identity,
    secure,
    enabled: raw.enabled !== false,
    hittable: raw.hittable !== false,
    selectors,
    platforms: [platform],
    status: "observed",
    sourcePaths: [],
    coveredBy: { tasks: [], contracts: [] },
  };
}

// Visible titles are not unique state identities. Native navigation stacks in particular often
// keep the list title on a selected detail form. Derive a conservative structural landmark set
// from stable selectors and short semantic actions so same-title list/detail states can be split
// without treating dynamic rows, counters, customer content, or global tab chrome as new screens.
const GENERIC_STATE_ANCHORS = new Set([
  "additionaldimmingoverlay", "backbutton", "checklist", "checkmark", "chevron-forward", "circle",
  "gearshape", "gearshape-fill", "home", "house", "house-fill", "selected", "settings", "tasks",
]);

function structuralStateAnchor(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const kind = semanticUiKey(raw.kind || raw.type || "control");
  const selectors = Array.isArray(raw.selectors) ? raw.selectors : selectorList(raw);
  const stableSelector = selectors.find((selector) =>
    ["testId", "accessibilityId", "resourceId", "cssId"].includes(selector.kind) && selector.value
  );
  const stableKey = semanticUiKey(stableSelector?.value || "");
  if (stableKey && !GENERIC_STATE_ANCHORS.has(stableKey) && !/^(?:tab-bar-pos|dynamic|unknown)$/.test(stableKey)) {
    return `${kind}:${stableKey}`;
  }

  const label = redactUiText(raw.label || raw.name || raw.placeholder || "");
  const labelKey = semanticUiKey(label);
  if (!label || label.length > 48 || /[,\d]|<[^>]+>/.test(label) || GENERIC_STATE_ANCHORS.has(labelKey)) return "";
  if (!["button", "field", "securefield", "link", "switch", "toggle"].some((candidate) => kind.includes(candidate))) return "";
  return `${kind}:${labelKey}`;
}

function structuralStateAnchorsFromRaw(raw) {
  return [...new Set([
    ...(Array.isArray(raw?.controls) ? raw.controls : []),
    ...(Array.isArray(raw?.inputs) ? raw.inputs.map((input) => ({ ...input, kind: input.secure ? "secureField" : "field" })) : []),
  ].map(structuralStateAnchor).filter(Boolean))].sort();
}

function structuralStateAnchorsFromNode(node) {
  return [...new Set((node?.controls || []).map(structuralStateAnchor).filter(Boolean))].sort();
}

function stateAnchorSimilarity(left, right) {
  if (!left.length || !right.length) return { intersection: 0, score: 0 };
  const leftSet = new Set(left);
  const intersection = right.filter((item) => leftSet.has(item)).length;
  const union = new Set([...left, ...right]).size;
  return { intersection, score: union ? intersection / union : 0 };
}

function stateVariantKey(raw, anchors) {
  const explicit = semanticUiKey(raw?.stateKey || raw?.variant || "");
  if (explicit && explicit !== "unknown") return explicit;
  const fields = anchors.filter((anchor) => anchor.startsWith("field:") || anchor.startsWith("securefield:"));
  const field = fields.find((anchor) => /(?:^|-)field$/.test(anchor.split(":").slice(1).join(":"))) || fields[0];
  if (field) return field.split(":").slice(1).join(":");
  return `state-${crypto.createHash("sha256").update(anchors.join("|")).digest("hex").slice(0, 10)}`;
}

function stateVariantLabel(anchors, variant) {
  const keys = anchors.map((anchor) => anchor.split(":").slice(1).join(":"));
  const ordered = variant && !variant.startsWith("state-") ? [variant, ...keys.filter((key) => key !== variant)] : keys;
  const words = ordered.slice(0, 3).map((key) => key.replace(/-/g, " "));
  return words.map((value) => value.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())).join(" / ");
}

function inferredControl(action, nodeId, platform) {
  const type = cleanSpace(action?.type || action?.action).toLowerCase();
  const observedTarget = redactUiText(action?.target || action?.label || action?.identifier || action?.direction);
  const descriptor = observedTarget.match(/^(id|label):(.+)$/i);
  const target = redactUiText(descriptor?.[2] || observedTarget);
  if (!target || !["tap", "type", "typetext", "login_type"].some((candidate) => type.includes(candidate))) return null;
  return normalizeControl({
    kind: type.includes("type") ? "field" : "button",
    label: target,
    accessibilityId: descriptor?.[1]?.toLowerCase() === "id" ? target : action?.identifier,
  }, nodeId, platform);
}

function preparationFromAction(action) {
  const type = semanticUiKey(action?.type || action?.action || "");
  if (!type.includes("type") || action?.status === "not_found" || action?.status === "failed") return null;
  const target = redactUiText(action?.target || action?.identifier || action?.label || "");
  if (!target) return null;
  const targetKey = semanticUiKey(target);
  const supplied = semanticUiKey(action?.valueSource || "");
  const valueSource = ["test-email", "test-password", "generated-text"].includes(supplied)
    ? supplied
    : targetKey.includes("password") ? "test-password" : targetKey.includes("email") ? "test-email" : "generated-text";
  return { type: "type", target, valueSource };
}

function mergeUnique(items, key = (item) => JSON.stringify(item)) {
  const seen = new Set();
  return items.filter((item) => {
    const identity = key(item);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function sortMap(map) {
  map.nodes ||= [];
  map.edges ||= [];
  map.nodes.sort((a, b) => a.id.localeCompare(b.id));
  for (const node of map.nodes) {
    node.aliases ||= [];
    node.platforms ||= [];
    node.roles ||= [];
    node.fingerprints ||= [];
    node.controls ||= [];
    node.routes ||= [];
    node.aliases.sort();
    node.platforms.sort();
    node.roles.sort();
    node.fingerprints.sort();
    node.controls.sort((a, b) => a.id.localeCompare(b.id));
    node.routes.sort((a, b) => `${a.platform}:${a.path}`.localeCompare(`${b.platform}:${b.path}`));
    for (const control of node.controls) {
      control.platforms ||= [];
      control.selectors ||= [];
      control.platforms.sort();
      control.selectors.sort((a, b) => `${a.kind}:${a.value}`.localeCompare(`${b.kind}:${b.value}`));
    }
  }
  map.edges.sort((a, b) => a.id.localeCompare(b.id));
  return map;
}

function observation(runId, observedAt, count = 1) {
  return { runIds: runId ? [runId] : [], firstObservedAt: observedAt, lastObservedAt: observedAt, count };
}

export function buildUiMapFromMarkers({ markersPath, platform = "ios", target = "", runId = "", observedAt, build = "" }) {
  if (!markersPath || !fs.existsSync(markersPath)) throw new Error(`UI Map markers not found: ${markersPath || "(missing path)"}`);
  const timestamp = observedAt || fs.statSync(markersPath).mtime.toISOString();
  const parsed = fs.readFileSync(markersPath, "utf8").split(/\r?\n/).map(parseMarkerLine).filter(Boolean);
  const nodeById = new Map();
  const edgeById = new Map();
  const actions = [];
  let lastState = null;
  let previousState = null;
  let pendingTransition = null;
  let actionsSinceState = 0;
  let stateActions = [];
  let entryState = null;
  let navigationRoot = null;

  const ensureNode = (raw = {}, recordStateObservation = false) => {
    const name = redactUiText(raw.screen || raw.name || "Unknown");
    if (!name || name === "Unknown") return null;
    const baseSemanticKey = semanticUiKey(name);
    const suppliedRole = cleanSpace(raw.role || "");
    const role = semanticUiKey(suppliedRole || "screen");
    const anchors = structuralStateAnchorsFromRaw(raw);
    const candidates = [...nodeById.values()].filter((candidate) =>
      (candidate.baseSemanticKey || candidate.semanticKey) === baseSemanticKey
    );
    let node = null;
    if (candidates.length) {
      // Marker-only transition endpoints do not carry controls. Resolve them to the established
      // base identity; state-bearing markers below provide the evidence needed to select a variant.
      if (!anchors.length) node = candidates.find((candidate) => !candidate.variant) || candidates[0];
      else {
        const ranked = candidates.map((candidate) => ({
          candidate,
          ...stateAnchorSimilarity(anchors, structuralStateAnchorsFromNode(candidate)),
        })).sort((left, right) => right.score - left.score || right.intersection - left.intersection || left.candidate.id.localeCompare(right.candidate.id));
        const best = ranked[0];
        const candidateAnchors = best ? structuralStateAnchorsFromNode(best.candidate) : [];
        const strictSamePlatformSubset = !!best && (best.candidate.platforms || []).includes(platform)
          && best.intersection === Math.min(anchors.length, candidateAnchors.length)
          && anchors.length !== candidateAnchors.length;
        const explicitVariant = cleanSpace(raw?.stateKey || raw?.variant || "");
        const route = platform === "web" ? observedWebRoute(raw?.url || raw?.route || "") : null;
        const sameWebRoute = !!best && platform === "web" && !explicitVariant && !!route
          && (best.candidate.routes || []).some((item) => item.platform === "web" && item.path === route.path);
        // SPA forms commonly reveal fields/actions in-place while retaining the same heading and
        // route. Treat that as one screen unless the driver supplies an explicit state identity.
        // Native same-title subsets remain distinct because a disappeared prerequisite (for
        // example Checkout on an empty Cart) materially changes what can be done.
        if (best && (best.score >= 0.35 || best.intersection >= 2 || (sameWebRoute && best.intersection >= 1)) && (!strictSamePlatformSubset || sameWebRoute)) node = best.candidate;
        // A first observation from another platform is a platform variant of the same semantic
        // state, not evidence for a new state merely because its native controls differ.
        else node = candidates.find((candidate) => !(candidate.platforms || []).includes(platform)) || null;
      }
    }
    const variant = node || !candidates.length || !anchors.length ? "" : stateVariantKey(raw, anchors);
    const semanticKey = node?.semanticKey || (variant ? `${baseSemanticKey}--${variant}` : baseSemanticKey);
    const id = node?.id || stableId("screen", semanticKey);
    node ||= nodeById.get(id);
    if (!node) {
      node = {
        id, semanticKey, name, aliases: [], roles: [role], platforms: [platform], status: "observed",
        ...(variant ? { baseSemanticKey, variant, stateLabel: `${name} · ${stateVariantLabel(anchors, variant)}` } : {}),
        fingerprints: [], controls: [], routes: [], sourcePaths: [], coveredBy: { tasks: [], contracts: [] },
        observation: observation(runId, timestamp, 0),
      };
      nodeById.set(id, node);
    }
    if (name !== node.name && !node.aliases.includes(name)) node.aliases.push(name);
    if (!node.platforms.includes(platform)) node.platforms.push(platform);
    if ((suppliedRole || node.roles.length === 0) && !node.roles.includes(role)) node.roles.push(role);
    const fingerprint = redactUiText(raw.hash || raw.fingerprint || "");
    if (fingerprint && !node.fingerprints.includes(fingerprint)) node.fingerprints.push(fingerprint);
    if (platform === "web") {
      const route = observedWebRoute(raw.url || raw.route || "");
      if (route && !node.routes.some((item) => item.platform === route.platform && item.path === route.path)) node.routes.push(route);
    }
    if (recordStateObservation) node.observation.count += 1;
    const rawControls = [
      ...(Array.isArray(raw.controls) ? raw.controls : []),
      ...(Array.isArray(raw.inputs) ? raw.inputs.map((input) => ({ ...input, kind: input.secure ? "secureField" : "field" })) : []),
    ];
    for (const rawControl of rawControls) {
      const control = normalizeControl(rawControl, id, platform);
      if (!control) continue;
      const prior = node.controls.find((item) => item.id === control.id || item.semanticKey === control.semanticKey || semanticUiKey(item.label) === semanticUiKey(control.label));
      if (!prior) node.controls.push(control);
      else {
        prior.platforms = mergeUnique([...prior.platforms, ...control.platforms]);
        prior.selectors = mergeUnique([...prior.selectors, ...control.selectors], (selector) => `${selector.kind}:${selector.value}`);
        prior.enabled ||= control.enabled;
        prior.hittable ||= control.hittable;
      }
    }
    return node;
  };

  const addEdge = (raw, explicitFrom = null, explicitTo = null) => {
    if (!raw || raw.changed === false || raw.to === "pending") return;
    const from = explicitFrom || ensureNode({ screen: raw.from, role: raw.fromRole });
    const to = explicitTo || ensureNode({ screen: raw.to, role: raw.toRole });
    if (!from || !to || from.id === to.id) return;
    const observedTarget = redactUiText(raw.action || raw.target || "transition");
    const descriptor = observedTarget.match(/^(id|label):(.+)$/i);
    const target = redactUiText(descriptor?.[2] || observedTarget);
    const actionType = semanticUiKey(raw.type || (target.toLowerCase().includes("back") ? "back" : "tap"));
    const id = stableId("edge", `${from.id}|${actionType}|${semanticUiKey(target)}|${to.id}`);
    // Drivers may emit a state change before their explicit transition marker.
    // Reconcile that inferred edge with the later confirmation by semantic
    // target/endpoints; the marker's missing action type must not create a
    // second edge for the same observed transition.
    const existing = edgeById.get(id) || [...edgeById.values()].find((edge) =>
      edge.from === from.id &&
      edge.to === to.id &&
      semanticUiKey(edge.action?.target) === semanticUiKey(target)
    );
    if (existing) {
      existing.confirmed = true;
      return;
    }
    const preparation = (raw.preparation || []).map(preparationFromAction).filter(Boolean);
    edgeById.set(id, {
      id, from: from.id, to: to.id, status: "observed",
      platforms: [platform],
      action: {
        type: actionType,
        target,
        selectors: target ? [{ kind: descriptor?.[1]?.toLowerCase() === "id" ? (platform === "android" ? "resourceId" : "accessibilityId") : "label", value: target }] : [],
      },
      preconditions: preparation.map((action) => ({ type: "field-populated", target: action.target })), outcomes: [{ type: "screen", value: to.semanticKey }],
      ...(preparation.length ? { preparation } : {}),
      wait: { type: "condition", timeoutMs: 6000 }, actors: [], sourcePaths: [],
      coveredBy: { tasks: [], contracts: [] }, observation: observation(runId, timestamp),
      ...(raw.confirmed === true ? { confirmed: true } : {}),
    });
  };

  for (const marker of parsed) {
    if (marker.kind === "STATE") {
      const node = ensureNode(marker.value, true);
      if (node) {
        if (pendingTransition) {
          addEdge(pendingTransition.raw, pendingTransition.from, node);
          pendingTransition = null;
        }
        entryState ||= node;
        previousState = lastState;
        if (!lastState || lastState.id !== node.id) stateActions = [];
        lastState = node;
        actionsSinceState = 0;
      }
    } else if (marker.kind === "NAVIGATION_ROOT") {
      const node = ensureNode(marker.value, true);
      if (node) {
        if (pendingTransition) {
          addEdge(pendingTransition.raw, pendingTransition.from, node);
          pendingTransition = null;
        }
        previousState = lastState;
        if (!lastState || lastState.id !== node.id) stateActions = [];
        lastState = node;
        navigationRoot = node;
        actionsSinceState = 0;
      }
    } else if (marker.kind === "ACTION") {
      const action = {
        ...marker.value,
        // Browser BFS opens a route but records the semantic link label in
        // `via`; map the user action, not the transport pathname.
        target: marker.value.type === "open" && marker.value.via ? marker.value.via : marker.value.target,
        screen: redactUiText(marker.value.screen || lastState?.name || ""),
      };
      actions.push(action);
      stateActions.push(action);
      actionsSinceState += 1;
      const screenNode = lastState && semanticUiKey(lastState.name) === semanticUiKey(action.screen)
        ? lastState
        : ensureNode({ screen: action.screen, role: lastState?.roles?.[0] });
      const control = screenNode && inferredControl(action, screenNode.id, platform);
      if (control) {
        const existing = screenNode.controls.find((item) => item.id === control.id || item.semanticKey === control.semanticKey || semanticUiKey(item.label) === semanticUiKey(control.label));
        if (!existing) screenNode.controls.push(control);
        else existing.selectors = mergeUnique([...existing.selectors, ...control.selectors], (selector) => `${selector.kind}:${selector.value}`);
      }
    } else if (marker.kind === "TRANSITION" || marker.kind === "TRANSITION_RESOLVED") {
      const targetKey = semanticUiKey(marker.value.action || marker.value.target || "transition");
      const observedAction = [...actions].reverse().find((candidate) => semanticUiKey(candidate.target) === targetKey);
      // Web BFS uses `open` as its transport, but an explicit transition with
      // a semantic link label represents the user's tap on that link.
      const observedType = observedAction?.type === "open" ? "tap" : observedAction?.type;
      const preparation = stateActions.filter((candidate) => candidate !== observedAction).map(preparationFromAction).filter(Boolean);
      const raw = { ...marker.value, type: marker.value.type || observedType, confirmed: true, ...(preparation.length ? { preparation } : {}) };
      if (actionsSinceState > 0 && lastState && semanticUiKey(lastState.name) === semanticUiKey(raw.from)) {
        // Native/iOS markers resolve the action immediately before emitting the destination
        // OCQA_STATE. Defer endpoint binding so same-title structural variants remain distinct.
        pendingTransition = { raw, from: lastState };
      } else if (lastState && semanticUiKey(lastState.name) === semanticUiKey(raw.to)) {
        addEdge(raw, previousState && semanticUiKey(previousState.name) === semanticUiKey(raw.from) ? previousState : null, lastState);
      } else {
        addEdge(raw);
      }
    }
  }

  const map = {
    schemaVersion: UI_MAP_SCHEMA_VERSION,
    app: {
      target: redactUiText(target), platforms: [platform], sourceRoot: "",
      entryNodes: entryState ? { [platform]: entryState.id } : {},
      navigationRoots: (navigationRoot || entryState) ? { [platform]: (navigationRoot || entryState).id } : {},
    },
    provenance: { generatedBy: "tapp", runIds: runId ? [runId] : [], builds: build ? [redactUiText(build)] : [], firstObservedAt: timestamp, lastObservedAt: timestamp },
    nodes: [...nodeById.values()], edges: [...edgeById.values()],
    coverage: { tasks: [], contracts: [], uncoveredNodeIds: [], uncoveredEdgeIds: [] },
  };
  map.coverage.uncoveredNodeIds = map.nodes.map((node) => node.id);
  map.coverage.uncoveredEdgeIds = map.edges.map((edge) => edge.id);
  return sortMap(map);
}

function mergeObservation(a, b) {
  return {
    runIds: mergeUnique([...(a?.runIds || []), ...(b?.runIds || [])]).sort(),
    firstObservedAt: [a?.firstObservedAt, b?.firstObservedAt].filter(Boolean).sort()[0] || "",
    lastObservedAt: [a?.lastObservedAt, b?.lastObservedAt].filter(Boolean).sort().at(-1) || "",
    count: Number(a?.count || 0) + Number(b?.count || 0),
  };
}

export function mergeUiMaps(existing, observed) {
  if (!existing) return structuredClone(observed);
  if (existing.schemaVersion !== UI_MAP_SCHEMA_VERSION || observed.schemaVersion !== UI_MAP_SCHEMA_VERSION) throw new Error("Unsupported UI Map schema version");
  const result = structuredClone(existing);
  result.app ||= { target: observed.app?.target || "", platforms: [], sourceRoot: "", entryNodes: {}, navigationRoots: {} };
  // Preserve the established repository identity, but let a later target-aware
  // observation fill metadata that an earlier capture could not know.
  result.app.target ||= observed.app?.target || "";
  result.app.sourceRoot ||= observed.app?.sourceRoot || "";
  result.app.platforms = mergeUnique([...(existing.app?.platforms || []), ...(observed.app?.platforms || [])]).sort();
  result.app.entryNodes = { ...(existing.app?.entryNodes || {}), ...(observed.app?.entryNodes || {}) };
  result.app.navigationRoots = { ...(existing.app?.navigationRoots || {}), ...(observed.app?.navigationRoots || {}) };
  result.provenance = {
    ...existing.provenance,
    runIds: mergeUnique([...(existing.provenance?.runIds || []), ...(observed.provenance?.runIds || [])]).sort(),
    builds: mergeUnique([...(existing.provenance?.builds || []), ...(observed.provenance?.builds || [])]).sort(),
    firstObservedAt: [existing.provenance?.firstObservedAt, observed.provenance?.firstObservedAt].filter(Boolean).sort()[0] || "",
    lastObservedAt: [existing.provenance?.lastObservedAt, observed.provenance?.lastObservedAt].filter(Boolean).sort().at(-1) || "",
  };
  for (const incoming of observed.nodes) {
    const prior = result.nodes.find((node) => node.id === incoming.id);
    if (!prior) { result.nodes.push(structuredClone(incoming)); continue; }
    prior.aliases = mergeUnique([...prior.aliases, ...incoming.aliases]);
    prior.platforms = mergeUnique([...prior.platforms, ...incoming.platforms]);
    prior.roles = mergeUnique([...prior.roles, ...incoming.roles]);
    prior.fingerprints = mergeUnique([...prior.fingerprints, ...incoming.fingerprints]);
    prior.routes = mergeUnique([...(prior.routes || []), ...(incoming.routes || [])], (route) => `${route.platform}:${route.path}`);
    prior.observation = mergeObservation(prior.observation, incoming.observation);
    for (const control of incoming.controls) {
      const oldControl = prior.controls.find((item) => item.id === control.id);
      if (!oldControl) prior.controls.push(structuredClone(control));
      else {
        oldControl.platforms = mergeUnique([...oldControl.platforms, ...control.platforms]);
        oldControl.selectors = mergeUnique([...oldControl.selectors, ...control.selectors], (selector) => `${selector.kind}:${selector.value}`);
        oldControl.status = "observed";
      }
    }
    prior.status = "observed";
  }
  for (const incoming of observed.edges) {
    const prior = result.edges.find((edge) => edge.id === incoming.id);
    if (!prior) result.edges.push(structuredClone(incoming));
    else {
      prior.observation = mergeObservation(prior.observation, incoming.observation);
      prior.platforms = mergeUnique([...(prior.platforms || []), ...(incoming.platforms || [])]).sort();
      prior.status = "observed";
    }
  }
  result.coverage.uncoveredNodeIds = result.nodes.filter((node) => !(node.coveredBy?.tasks || []).length && !(node.coveredBy?.contracts || []).length).map((node) => node.id).sort();
  result.coverage.uncoveredEdgeIds = result.edges.filter((edge) => !(edge.coveredBy?.tasks || []).length && !(edge.coveredBy?.contracts || []).length).map((edge) => edge.id).sort();
  return sortMap(result);
}

export function diffUiMaps(previous, current, { comparableFullSweep = false } = {}) {
  const prevNodes = new Map((previous?.nodes || []).map((node) => [node.id, node]));
  const currNodes = new Map((current?.nodes || []).map((node) => [node.id, node]));
  const prevEdges = new Map((previous?.edges || []).map((edge) => [edge.id, edge]));
  const currEdges = new Map((current?.edges || []).map((edge) => [edge.id, edge]));
  const addedNodes = [...currNodes.keys()].filter((id) => !prevNodes.has(id));
  const notObservedNodes = [...prevNodes.keys()].filter((id) => !currNodes.has(id));
  const addedEdges = [...currEdges.keys()].filter((id) => !prevEdges.has(id));
  const notObservedEdges = [...prevEdges.keys()].filter((id) => !currEdges.has(id));
  const changedControls = [];
  for (const [id, currentNode] of currNodes) {
    const prior = prevNodes.get(id);
    if (!prior) continue;
    const oldIds = new Set(prior.controls.map((control) => control.id));
    const newIds = new Set(currentNode.controls.map((control) => control.id));
    const added = [...newIds].filter((controlId) => !oldIds.has(controlId));
    const notObserved = [...oldIds].filter((controlId) => !newIds.has(controlId));
    if (added.length || notObserved.length) changedControls.push({ nodeId: id, added, notObserved });
  }
  return {
    comparableFullSweep,
    addedNodes: addedNodes.sort(),
    notObservedNodes: notObservedNodes.sort(),
    lostReachability: comparableFullSweep ? notObservedNodes.sort() : [],
    addedEdges: addedEdges.sort(),
    notObservedEdges: notObservedEdges.sort(),
    lostTransitions: comparableFullSweep ? notObservedEdges.sort() : [],
    changedControls,
    requiresReview: changedControls.some((change) => change.notObserved.length > 0) || (comparableFullSweep && (notObservedNodes.length > 0 || notObservedEdges.length > 0)),
  };
}

export function validateUiMap(map) {
  const errors = [];
  if (!map || typeof map !== "object") return ["UI Map must be an object"];
  if (map.schemaVersion !== UI_MAP_SCHEMA_VERSION) errors.push(`schemaVersion must be ${UI_MAP_SCHEMA_VERSION}`);
  if (!Array.isArray(map.nodes)) errors.push("nodes must be an array");
  if (!Array.isArray(map.edges)) errors.push("edges must be an array");
  const nodeIds = new Set((map.nodes || []).map((node) => node.id));
  if (nodeIds.size !== (map.nodes || []).length) errors.push("node ids must be unique");
  const edgeIds = new Set();
  for (const [kind, references] of [["entry", map.app?.entryNodes], ["navigation root", map.app?.navigationRoots]]) {
    for (const [platform, nodeId] of Object.entries(references || {})) {
      if (!platform || !nodeIds.has(nodeId)) errors.push(`${kind} for ${platform || "unknown platform"} references a missing node`);
    }
  }
  for (const node of map.nodes || []) for (const route of node.routes || []) {
    if (!route || typeof route !== "object" || !["web"].includes(route.platform) || typeof route.path !== "string" || !route.path.startsWith("/")) {
      errors.push(`node ${node.id} has an invalid observed route`);
    }
    if (route.replayable !== true && route.replayable !== false) errors.push(`node ${node.id} route replayable must be boolean`);
  }
  for (const edge of map.edges || []) {
    if (edgeIds.has(edge.id)) errors.push(`duplicate edge id: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) errors.push(`edge ${edge.id} references a missing node`);
  }
  return errors;
}

export function writeUiMap(outPath, map) {
  const errors = validateUiMap(map);
  if (errors.length) throw new Error(`Invalid UI Map: ${errors.join("; ")}`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(sortMap(structuredClone(map)), null, 2) + "\n");
  return outPath;
}

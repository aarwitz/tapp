// A proven run becomes a journey you own (ADR-0009 slice 3).
//
// An exploration that got somewhere — through a sign-in, across a few screens — is worth more
// than its report: replayed, it is a test of that path through the real application. This
// module turns the capture's action log (OCQA_ACTION / OCQA_STATE markers) into a Flow in the
// vocabulary the deterministic runner already speaks, keeps it where it belongs, and remembers
// how its last replay went.
//
// Where a journey lives:
//   a repository      → <repo>/.tapp/flows/<slug>.yml            (committed, guarded by `tapp ci`)
//   an account        → TAPP_HOME/accounts/journeys/<id>/<slug>.yml
//   a local prompt run → TAPP_HOME/journeys/<slug>.yml
// Its last result lives beside it in .status/<slug>.json. Credentials never enter a journey: a
// sign-in is `login: $TEST_EMAIL / $TEST_PASSWORD`, resolved at replay from the actor store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_STEPS = 40;

export function slugify(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "journey";
}

function readMarkers(captureDir) {
  let text = "";
  try { text = fs.readFileSync(path.join(captureDir, "ocqa-markers.txt"), "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^(OCQA_ACTION|OCQA_STATE):(\{.*\})\s*$/);
    if (!match) continue;
    try { out.push({ kind: match[1], ...JSON.parse(match[2]) }); } catch { /* a torn line */ }
  }
  return out;
}

// tapp names a revisited screen "Orders (refreshed)"; the page itself still says "Orders".
// A screen name is one line. A headline that wraps in the page's source arrives with its
// newlines and indentation attached, and a journey step that pins that string can never match
// again — the browser reports the heading with its whitespace collapsed.
/** A route, not something a person pressed: "/", "/orders", "https://…", "#pricing". */
const isAddress = (via) => /^([/#]|https?:)/i.test(String(via || "").trim());

const pageName = (screen) => String(screen || "").replace(/\s*\((?:refreshed|again|\d+)\)\s*$/i, "").replace(/\s+/g, " ").trim();

/**
 * Build a Flow from an exploration capture. Returns null when the run did nothing worth
 * replaying (no action but the opening).
 */
export function journeyFromCapture(captureDir, { name = "", actor = "default" } = {}) {
  let provenance = null;
  try { provenance = JSON.parse(fs.readFileSync(path.join(captureDir, "provenance.json"), "utf8")); } catch { /* older capture */ }
  const target = String(provenance?.target || "");
  if (!/^https?:\/\//i.test(target)) return null;
  const markers = readMarkers(captureDir);
  const steps = [];
  const screens = [];
  let lastWaited = "";
  const waitFor = (screen) => {
    const page = pageName(screen);
    if (!page || page === lastWaited) return;
    steps.push({ wait_for: page });
    lastWaited = page;
    screens.push(page);
  };
  let acted = false;
  let signedIn = false;
  let stop = false;
  for (let i = 0; i < markers.length && steps.length < MAX_STEPS && !stop; i += 1) {
    const marker = markers[i];
    if (marker.kind === "OCQA_STATE") { waitFor(marker.screen); continue; }
    switch (marker.type) {
      case "open":
        // The first open is the journey's URL. A later one is either a link somebody pressed —
        // which a person can repeat — or the crawler jumping to a route by address, which nobody
        // can. A journey is the path a user could walk, so it ends at the first jump rather than
        // pretending the previous tap led there. (Found by filming: a kept journey had "tap Area"
        // followed by the marketing home page, and the replay rightly refused to believe it.)
        if (!marker.via || marker.via === marker.target || isAddress(marker.via)) { if (acted) stop = true; break; }
        steps.push({ tap: marker.via }); acted = true;
        break;
      case "login":
        steps.push({ login: { email: "$TEST_EMAIL", password: "$TEST_PASSWORD" } });
        signedIn = true; acted = true;
        break;
      case "session":
        // The run started inside from a saved session; the replay will too (storageState).
        signedIn = true;
        break;
      case "tap":
        if (marker.target) { steps.push({ tap: marker.target }); acted = true; }
        break;
      case "type":
        // What was typed during exploration is not part of the path; the field is.
        if (marker.target && !marker.secure) { steps.push({ type: { field: marker.target, value: String(marker.value || "") } }); acted = true; }
        break;
      default:
        break;
    }
  }
  if (!acted) return null;
  // End on the screen the run ended on, so a replay that drifts is a failure, not a pass.
  if (lastWaited) { steps.pop(); steps.push({ assert_screen: lastWaited }); }
  const host = (() => { try { return new URL(target).host; } catch { return "site"; } })();
  const journeyName = String(name || "").trim() || `${host} — ${screens[0] || "start"}${screens.length > 1 ? ` to ${screens[screens.length - 1]}` : ""}`;
  const flow = { name: journeyName, platform: "web", url: target, ...(signedIn ? { actor } : {}), steps };
  return { flow, yaml: flowToYaml(flow), steps: steps.length, screens, signedIn };
}

// The Flow vocabulary is small and flat; a dependency-free emitter keeps the hosted Studio from
// needing python for this. Strings are JSON-quoted, which YAML accepts verbatim.
const q = (value) => JSON.stringify(String(value));
export function flowToYaml(flow) {
  const lines = [`name: ${q(flow.name)}`, `platform: ${flow.platform || "web"}`];
  if (flow.url) lines.push(`url: ${q(flow.url)}`);
  if (flow.actor) lines.push(`actor: ${q(flow.actor)}`);
  lines.push("steps:");
  for (const step of flow.steps || []) {
    const [action, value] = Object.entries(step)[0];
    if (value && typeof value === "object") {
      lines.push(`- ${action}:`);
      for (const [key, inner] of Object.entries(value)) lines.push(`    ${key}: ${/^\$[A-Z_]+$/.test(String(inner)) ? inner : q(inner)}`);
    } else {
      lines.push(`- ${action}: ${q(value)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Where kept journeys and their statuses live for one owner. */
export class JourneyStore {
  constructor({ root }) {
    this.root = root;
  }

  static forAccount(accountId, env = process.env) {
    const home = (env.TAPP_HOME || "").trim() || path.join(os.homedir(), ".tapp");
    if (!/^[a-f0-9]{24}$/.test(String(accountId || ""))) throw new Error("Not an account id");
    return new JourneyStore({ root: path.join(home, "accounts", "journeys", accountId) });
  }

  static forMachine(env = process.env) {
    const home = (env.TAPP_HOME || "").trim() || path.join(os.homedir(), ".tapp");
    return new JourneyStore({ root: path.join(home, "journeys") });
  }

  static forRepository(repoRoot) {
    return new JourneyStore({ root: path.join(repoRoot, ".tapp", "flows") });
  }

  flowPath(slug) {
    const safe = slugify(slug);
    return path.join(this.root, `${safe}.yml`);
  }

  keep(journey, { replace = false } = {}) {
    const slug = slugify(journey.flow.name);
    const file = this.flowPath(slug);
    if (fs.existsSync(file) && !replace) throw Object.assign(new Error(`A journey named '${journey.flow.name}' already exists. Pick another name or replace it.`), { statusCode: 409 });
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, journey.yaml, { mode: 0o600 });
    return { slug, path: file };
  }

  forget(slug) {
    try { fs.rmSync(this.flowPath(slug), { force: true }); fs.rmSync(this.statusPath(slug), { force: true }); return true; } catch { return false; }
  }

  statusPath(slug) {
    return path.join(this.root, ".status", `${slugify(slug)}.json`);
  }

  recordRun(slug, { passed, captureId = null, executed = 0, total = 0, failed = 0 }) {
    const file = this.statusPath(slug);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const status = { passed: !!passed, at: new Date().toISOString(), captureId, executed, total, failed };
    fs.writeFileSync(file, JSON.stringify(status), { mode: 0o600 });
    return status;
  }

  status(slug) {
    try { return JSON.parse(fs.readFileSync(this.statusPath(slug), "utf8")); } catch { return null; }
  }

  /** Every journey here, with its last result. Names only; never the file contents. */
  list() {
    let entries = [];
    try { entries = fs.readdirSync(this.root, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
      const slug = entry.name.replace(/\.ya?ml$/i, "");
      let source = "";
      try { source = fs.readFileSync(path.join(this.root, entry.name), "utf8"); } catch { continue; }
      const scalar = (key) => { const m = source.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m")); return m ? m[1].replace(/^["']|["']$/g, "") : ""; };
      const steps = (source.match(/^- [a-z_]+:/gm) || []).length;
      out.push({ name: scalar("name") || slug, slug, platform: scalar("platform") || "web", url: scalar("url"), actor: scalar("actor"), steps, status: this.status(slug), source: "kept" });
    }
    return out;
  }
}

// Source-connected focused navigation. This module does not ask a model to guess a route: source
// locates the requested surface, while only runtime-observed UI Map edges authorize replay.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { existingProjectArtifactPath } from "./project-paths.js";
import { replayableUiMapNavigation, semanticUiKey, validateUiMap } from "./ui-map.js";

const SOURCE_EXTENSIONS = new Set([
  ".swift", ".m", ".mm", ".h", ".kt", ".kts", ".java", ".xml",
  ".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".html", ".css",
  ".cs", ".xaml", ".dart", ".rb", ".py",
]);
const IGNORED_SEGMENTS = new Set([
  ".git", ".tapp", "node_modules", "Pods", ".build", "build", "dist", "DerivedData",
  ".next", ".nuxt", "vendor", "coverage", "captures",
]);
const INTENT_WORDS = new Set([
  "above", "after", "again", "and", "app", "before", "below", "button", "check", "click",
  "control", "destination", "ensure", "exactly", "field", "find", "go", "keyboard", "link", "make",
  "navigate", "once", "open", "page", "please", "press", "reach", "screen", "should", "show",
  "tap", "tapp", "that", "then", "the", "this", "to", "use", "verify", "view", "visible", "when",
  "where", "with", "works",
]);

function posix(value) { return String(value || "").replaceAll("\\", "/").replace(/^\.\//, ""); }
function words(value) {
  return [...new Set(semanticUiKey(value).split("-").filter((word) => word.length >= 3 && !INTENT_WORDS.has(word)))];
}
function phrase(value) { return String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function uniq(values) { return [...new Set(values.filter(Boolean))]; }
function focusPhrase(value) {
  const tokens = phrase(value).split(" ").filter(Boolean).filter((word) => !INTENT_WORDS.has(word));
  return uniq(tokens).join(" ") || phrase(value);
}

function sourceFiles(projectDir) {
  const tracked = spawnSync("git", ["-C", projectDir, "ls-files", "-co", "--exclude-standard", "-z"], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (tracked.status === 0) return tracked.stdout.split("\0").filter(Boolean).map(posix);
  const found = [];
  const walk = (relative = "") => {
    if (found.length >= 8000) return;
    const absolute = path.join(projectDir, relative);
    let entries;
    try { entries = fs.readdirSync(absolute, { withFileTypes:true }); } catch { return; }
    for (const entry of entries) {
      if (IGNORED_SEGMENTS.has(entry.name)) continue;
      const child = posix(path.join(relative, entry.name));
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) found.push(child);
      if (found.length >= 8000) break;
    }
  };
  walk();
  return found;
}

function symbolNear(lines, index) {
  const patterns = [
    /\b(?:struct|class|enum|protocol|interface|object)\s+([A-Za-z_$][\w$]*)/,
    /\b(?:function|func|fun|def)\s+([A-Za-z_$][\w$]*)/,
    /\b(?:const|let|var)\s+([A-Z][A-Za-z0-9_$]*)\s*=.*(?:=>|function|View|Screen|Page|Component|\()/,
  ];
  for (let i = index; i >= Math.max(0, index - 80); i -= 1) {
    for (const pattern of patterns) {
      const match = pattern.exec(lines[i]);
      if (match) return match[1];
    }
  }
  const enclosingType = /\b(?:struct|class|enum|protocol|interface|object)\s+([A-Za-z_$][\w$]*)/;
  for (let i = Math.max(0, index - 81); i >= 0; i -= 1) {
    const match = enclosingType.exec(lines[i]);
    if (match) return match[1];
  }
  return "";
}

function sourceHint(value) {
  return String(value || "")
    .replace(/\.(?:swift|tsx?|jsx?|kt|java|cs|xaml|vue|svelte|dart)$/i, "")
    .replace(/(?:ViewController|View|Screen|Page|Component|Activity|Fragment)$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

export function findSourceUiMatches({ projectDir, query, limit = 10 } = {}) {
  const root = fs.realpathSync(path.resolve(projectDir || process.cwd()));
  const queryPhrase = focusPhrase(query);
  const queryWords = words(query);
  if (!queryPhrase || !queryWords.length) return [];
  const matches = [];
  for (const relative of sourceFiles(root)) {
    const absolute = path.join(root, relative);
    const ext = path.extname(relative).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(ext) || relative.split("/").some((part) => IGNORED_SEGMENTS.has(part))) continue;
    let stat;
    try { stat = fs.statSync(absolute); } catch { continue; }
    if (stat.size > 768 * 1024) continue;
    let text;
    try { text = fs.readFileSync(absolute, "utf8"); } catch { continue; }
    if (text.includes("\0")) continue;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const linePhrase = phrase(lines[index]);
      if (!linePhrase) continue;
      const hits = queryWords.filter((word) => linePhrase.includes(word));
      if (!hits.length) continue;
      const exact = linePhrase.includes(queryPhrase);
      const coverage = hits.length / queryWords.length;
      if (!exact && hits.length < Math.min(2, queryWords.length) && coverage < 0.6) continue;
      const symbol = symbolNear(lines, index);
      const fileHint = sourceHint(path.basename(relative));
      const uiLiteral = /(?:Text|Button|Label|NavigationLink|accessibilityLabel|contentDescription|aria-label)\s*\(?\s*["']/.test(lines[index]);
      matches.push({
        path:relative, line:index + 1, snippet:lines[index].trim().replace(/\s+/g, " ").slice(0, 240),
        symbol:symbol || undefined, screenHint:sourceHint(symbol) || fileHint || undefined,
        matchedTerms:hits, score:(exact ? 120 : 0) + (uiLiteral ? 35 : 0) + Math.round(coverage * 80) + hits.length * 5,
      });
    }
  }
  return matches
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
    .filter((match, index, all) => index === all.findIndex((item) => item.path === match.path && item.screenHint === match.screenHint))
    .slice(0, Math.max(1, Math.min(25, limit)));
}

function sourceReferenceTrail(projectDir, sourceMatches, { maxDepth = 2, limit = 12 } = {}) {
  const files = sourceFiles(projectDir).filter((relative) =>
    SOURCE_EXTENSIONS.has(path.extname(relative).toLowerCase()) && !relative.split("/").some((part) => IGNORED_SEGMENTS.has(part))
  );
  const documents = [];
  for (const relative of files) {
    const absolute = path.join(projectDir, relative);
    try {
      if (fs.statSync(absolute).size > 768 * 1024) continue;
      const text = fs.readFileSync(absolute, "utf8");
      if (!text.includes("\0")) documents.push({ path:relative, lines:text.split(/\r?\n/) });
    } catch { /* one unreadable source file cannot block location */ }
  }
  // Begin from the strongest UI definition only. Lower-ranked matches often name implementation
  // helpers (`save…`, `sectionCard`) and create irrelevant call-graph noise instead of a route.
  let frontier = uniq(sourceMatches.slice(0, 1).map((match) => match.symbol)).filter((symbol) => symbol.length >= 4);
  const visited = new Set(frontier);
  const trail = [];
  for (let depth = 0; depth < maxDepth && frontier.length && trail.length < limit; depth += 1) {
    const next = [];
    for (const symbol of frontier) {
      const definition = new RegExp(`\\b(?:struct|class|enum|protocol|interface|object|function|func|fun|def)\\s+${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      for (const document of documents) {
        for (let index = 0; index < document.lines.length; index += 1) {
          const line = document.lines[index];
          if (!line.includes(symbol) || definition.test(line)) continue;
          const owner = symbolNear(document.lines, index);
          const key = `${document.path}:${index + 1}`;
          const context = document.lines.slice(Math.max(0, index - 2), Math.min(document.lines.length, index + 3)).map((item) => item.trim()).filter(Boolean).join(" ");
          const followingContext = document.lines.slice(index, Math.min(document.lines.length, index + 3)).join(" ");
          const tag = followingContext.match(/\.tag\([^)]*\.([A-Za-z_$][\w$]*)\)/)?.[1];
          let controlHint = "";
          if (tag) {
            const taggedChoice = document.lines.find((candidate) => candidate.includes(`.${tag},`) && /["'][^"']+["']/.test(candidate));
            const quoted = taggedChoice ? [...taggedChoice.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]) : [];
            controlHint = quoted.at(-1) || "";
          }
          if (!trail.some((item) => `${item.path}:${item.line}` === key)) trail.push({
            path:document.path, line:index + 1, references:symbol, owner:owner || undefined,
            snippet:context.replace(/\s+/g, " ").slice(0, 300), ...(controlHint ? { controlHint } : {}), depth:depth + 1,
          });
          if (owner && owner !== symbol && owner.length >= 4 && !visited.has(owner)) { visited.add(owner); next.push(owner); }
          if (trail.length >= limit) break;
        }
        if (trail.length >= limit) break;
      }
      if (trail.length >= limit) break;
    }
    frontier = uniq(next);
  }
  return trail;
}

function mapScore(node, query, queryWords, sourceMatches) {
  const nodeValues = [node.name, node.semanticKey, ...(node.aliases || [])];
  const controlValues = (node.controls || []).flatMap((control) => [
    control.label, control.id, control.semanticKey, ...(control.selectors || []).map((selector) => selector.value),
  ]);
  const exactQuery = focusPhrase(query);
  const exactControl = controlValues.some((value) => phrase(value) === exactQuery);
  const exactNode = nodeValues.some((value) => phrase(value) === exactQuery);
  const combined = phrase([...nodeValues, ...controlValues].join(" "));
  const hitCount = queryWords.filter((word) => combined.includes(word)).length;
  const hints = sourceMatches.flatMap((match) => [match.screenHint, sourceHint(path.basename(match.path))]).filter(Boolean);
  const hintHit = hints.some((hint) => {
    const key = semanticUiKey(hint);
    return nodeValues.some((value) => semanticUiKey(value) === key || semanticUiKey(value).includes(key) || key.includes(semanticUiKey(value)));
  });
  const ownershipHit = sourceMatches.some((match) => (node.sourcePaths || []).some((owner) => posix(match.path).startsWith(posix(owner).replace(/\/$/, ""))));
  // A destination whose own name exactly matches the request outranks a parent screen that merely
  // contains a same-label navigation control (for example Settings → "Update Profile"). Otherwise
  // focused navigation stops one edge early and hands the routing burden back to the agent.
  return (exactControl ? 260 : 0) + (exactNode ? 420 : 0) + hitCount * 24 + (hintHit ? 110 : 0) + (ownershipHit ? 140 : 0);
}

function readMap(projectDir, mapPath) {
  const resolved = path.resolve(projectDir, mapPath || existingProjectArtifactPath(projectDir, "ui-map.json"));
  if (!resolved.startsWith(`${path.resolve(projectDir)}${path.sep}`) || !fs.existsSync(resolved)) return { path:resolved, map:null, error:"UI Map not found" };
  try {
    const map = JSON.parse(fs.readFileSync(resolved, "utf8"));
    const errors = validateUiMap(map);
    return errors.length ? { path:resolved, map:null, error:`Invalid UI Map: ${errors.join("; ")}` } : { path:resolved, map };
  } catch (error) { return { path:resolved, map:null, error:error.message || String(error) }; }
}

export function locateFocusedTarget({ projectDir = process.cwd(), query, platform = "", mapPath = "", currentScreen = "" } = {}) {
  const root = fs.realpathSync(path.resolve(projectDir));
  const requested = String(query || "").trim();
  if (!requested) throw new Error("A focused UI query is required");
  const sourceMatches = findSourceUiMatches({ projectDir:root, query:requested });
  const sourceTrail = sourceReferenceTrail(root, sourceMatches);
  const loaded = readMap(root, mapPath);
  if (!loaded.map) return {
    kind:"tapp-focused-target", status:sourceMatches.length ? "source-located" : "not-found", query:requested,
    projectDir:root, platform:platform || null, sourceMatches, sourceTrail, map:{ path:loaded.path, available:false, reason:loaded.error },
    navigation:{ status:"blocked", reason:"No valid observed UI Map is available; Tapp will not invent a route from source alone." },
  };
  const map = loaded.map;
  const selectedPlatform = platform || (map.app?.platforms || [])[0] || "";
  const queryWords = words(requested);
  const ranked = (map.nodes || []).map((node) => ({ node, score:mapScore(node, requested, queryWords, sourceMatches) }))
    .filter((item) => item.score > 0 && (!selectedPlatform || !(item.node.platforms || []).length || item.node.platforms.includes(selectedPlatform)))
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  const best = ranked[0];
  if (!best || (ranked[1] && best.score === ranked[1].score && best.score < 200)) return {
    kind:"tapp-focused-target", status:sourceMatches.length ? "source-located" : "not-found", query:requested,
    projectDir:root, platform:selectedPlatform || null, sourceMatches, sourceTrail,
    map:{ path:loaded.path, available:true, candidates:ranked.slice(0, 5).map(({ node, score }) => ({ id:node.id, name:node.name, score })) },
    navigation:{ status:"blocked", reason:best ? "More than one UI Map state matches; choose a screen instead of guessing." : "No observed UI Map state matches the requested surface." },
  };
  const current = currentScreen ? (map.nodes || []).find((node) => [node.name, ...(node.aliases || [])].some((value) => semanticUiKey(value) === semanticUiKey(currentScreen))) : null;
  let navigation = replayableUiMapNavigation(map, best.node.id, selectedPlatform, { maxSteps:8, startNodeId:current?.id || "" });
  if (selectedPlatform === "web") {
    const route = (best.node.routes || []).find((item) => item.platform === "web" && item.replayable === true);
    if (route) navigation = { status:"replayable", mode:"direct-web-route", provenance:"observed-ui-map", targetNodeId:best.node.id, route:route.path, steps:[] };
  }
  return {
    kind:"tapp-focused-target", status:navigation.status === "replayable" ? "route-ready" : "source-and-map-located",
    query:requested, projectDir:root, platform:selectedPlatform || null, sourceMatches, sourceTrail,
    target:{ id:best.node.id, name:best.node.name, semanticKey:best.node.semanticKey, score:best.score,
      matchedControls:(best.node.controls || []).filter((control) => words(`${control.label} ${control.id} ${control.semanticKey}`).some((word) => queryWords.includes(word))).slice(0, 10) },
    map:{ path:loaded.path, available:true }, navigation,
  };
}

export function focusedTargetSummary(result) {
  const lines = [`🎯 ${result.status === "route-ready" ? "Focused route ready" : "Focused target located"} — ${result.query}`];
  if (result.target) lines.push(`Observed screen: **${result.target.name}** (${result.platform || "platform unknown"})`);
  if (result.navigation?.status === "replayable") {
    if (result.navigation.mode === "direct-web-route") lines.push(`Fast path: open observed route \`${result.navigation.route}\``);
    else lines.push(`Fast path: ${(result.navigation.steps || []).map((step) => `tap \`${step.action.target}\``).join(" → ") || "already on the target screen"}`);
  } else lines.push(`Route: unavailable — ${result.navigation?.reason || "not observed"}`);
  if (result.sourceMatches?.length) {
    lines.push("Source evidence:");
    for (const match of result.sourceMatches.slice(0, 5)) lines.push(`- \`${match.path}:${match.line}\`${match.symbol ? ` · ${match.symbol}` : ""} — ${match.snippet}`);
  } else lines.push("Source evidence: no matching owned source text found.");
  if (result.sourceTrail?.length) {
    lines.push("Source navigation breadcrumbs:");
    for (const clue of result.sourceTrail.slice(0, 6)) lines.push(`- \`${clue.path}:${clue.line}\` · ${clue.owner ? `${clue.owner} → ` : ""}${clue.references}${clue.controlHint ? ` · control hint \`${clue.controlHint}\`` : ""} — ${clue.snippet}`);
  }
  lines.push("Source identifies likely intent; only runtime-observed UI Map edges are replayed.");
  return lines.join("\n");
}

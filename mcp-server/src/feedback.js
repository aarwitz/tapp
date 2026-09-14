// Feedback to the tapp maintainers, the agent-native way: a GitHub issue on aarwitz/tapp.
//
// Shared by `tapp feedback` (CLI) and `tapp_feedback` (MCP). Both default to a DRAFT — the
// composed issue plus a prefilled github.com/.../issues/new URL — and only file the issue when
// explicitly asked (`--submit` / `submit: true`), because issues are public and an agent must not
// publish on a user's behalf without consent. Filing uses the machine's authenticated `gh` CLI;
// nothing is uploaded: captures stay local and only the capture id is referenced.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const FEEDBACK_REPO = "aarwitz/tapp";
export const FEEDBACK_TYPES = ["bug", "idea", "question"];
const TYPE_LABEL = { bug: "bug", idea: "idea", question: "question" };

/** Strip home directories and token-shaped secrets before anything leaves the machine. */
export function redactText(text, home = os.homedir()) {
  let s = String(text ?? "");
  if (home && home.length > 1) s = s.split(home).join("~");
  s = s
    .replace(/\/Users\/[^/\s"']+/g, "~")
    .replace(/\/home\/[^/\s"']+/g, "~")
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, "~")
    .replace(/\b(sk-ant-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/g, "[redacted]");
  return s;
}

/** Newest capture directory name under TAPP_HOME, or null. Only the id is ever shared. */
export function latestCaptureId(tappHome) {
  const dir = path.join(tappHome, "captures");
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(dir, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return entries[0]?.name ?? null;
}

/** One line of platform availability from `tapp doctor --json` output. */
export function summarizeDoctor(doctor) {
  if (!doctor || typeof doctor !== "object") return null;
  const p = doctor.platforms || {};
  const parts = [];
  if (p.ios) {
    const detail = [p.ios.xcode, p.ios.bootedSimulator ? `${p.ios.bootedSimulator} booted` : ""].filter(Boolean).join(", ");
    parts.push(`iOS ${p.ios.available ? "✅" : "⬜"}${detail ? ` (${detail})` : ""}`);
  }
  if (p.android) parts.push(`Android ${p.android.adb ? "✅" : "⬜"}${p.android.devicesConnected ? ` (${p.android.devicesConnected} device)` : ""}`);
  if (p.web) parts.push(`web ${p.web.available ? "✅" : "⬜"}`);
  return parts.join(" · ") || null;
}

/** Build the issue: redacted title/body plus an automatic, path-free context footer. */
export function composeFeedback({
  title, body = "", type = "bug", version = "unknown", node = process.version,
  platform = `${process.platform} ${process.arch}`, doctor = null, captureId = null, filedBy = "agent",
}) {
  const cleanTitle = redactText(title).trim();
  if (!cleanTitle) throw new Error("feedback needs a short title");
  if (!FEEDBACK_TYPES.includes(type)) throw new Error(`type must be one of: ${FEEDBACK_TYPES.join(", ")}`);
  const context = [`- tapp ${version} · node ${node} · ${platform}`];
  const platforms = summarizeDoctor(doctor);
  if (platforms) context.push(`- platforms: ${platforms}`);
  if (captureId) context.push(`- capture: \`${redactText(captureId)}\` (kept locally — nothing is uploaded; evidence can be shared privately on request)`);
  const description = redactText(body).trim() || "_(no description provided)_";
  const byline = filedBy === "agent" ? ", filed by a coding agent on the user's behalf" : "";
  const full = `${description}\n\n---\n_Filed with \`tapp feedback\` (${type}${byline}). This issue is public._\n${context.join("\n")}\n`;
  const labels = ["feedback", TYPE_LABEL[type]];
  if (filedBy === "agent") labels.push("agent-filed");
  return { title: cleanTitle.slice(0, 200), body: full, labels };
}

/** Prefilled "new issue" link — works for anyone with a GitHub account, no CLI needed. */
export function feedbackIssueUrl({ title, body, labels }) {
  const url = new URL(`https://github.com/${FEEDBACK_REPO}/issues/new`);
  url.searchParams.set("title", title);
  url.searchParams.set("body", body);
  url.searchParams.set("labels", labels.join(","));
  return url.toString();
}

export function ghStatus(ghBin = process.env.TAPP_GH_BIN || "gh") {
  const r = spawnSync(ghBin, ["auth", "status"], { encoding: "utf8" });
  return { available: r.status === 0, detail: (r.stderr || r.stdout || "").trim() };
}

export function submitFeedbackViaGh(issue, ghBin = process.env.TAPP_GH_BIN || "gh") {
  const r = spawnSync(ghBin, [
    "issue", "create", "--repo", FEEDBACK_REPO,
    "--title", issue.title, "--body-file", "-", "--label", issue.labels.join(","),
  ], { encoding: "utf8", input: issue.body });
  const out = (r.stdout || "").trim();
  const err = (r.stderr || "").trim();
  const url = (out.match(/https:\/\/github\.com\/\S+/) || [])[0] || null;
  return { ok: r.status === 0 && Boolean(url), url, detail: r.status === 0 ? out : (err || out) };
}

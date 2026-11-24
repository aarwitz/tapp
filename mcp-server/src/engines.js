// The agent is the person's own, on their own plan; tapp is its hands (ADR-0012).
//
// tapp signs nobody in to Claude or ChatGPT and holds no token for either. Anthropic's consumer
// terms (2026-02-19) forbid using a Claude Free/Pro/Max OAuth token in any product but Claude
// Code and claude.ai — the Agent SDK included — so the only honest way to put a person's Claude
// plan behind the Studio chat is the one Gideon uses: find the `claude` they already signed in
// to, and drive it. Codex and Gemini are found the same way. This module knows which of those are
// on this machine, whether each is signed in with a plan (or an API key, which bills per use),
// and how to run one with tapp's tools attached and nothing else — no shell, no file edits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";

export const ENGINES = Object.freeze([
  { id: "claude", label: "Claude Code", binary: "claude", plan: "Claude", drives: true,
    install: "Install Claude Code from claude.com/code, then run `claude` in a terminal and sign in with your Claude account." },
  { id: "codex", label: "Codex", binary: "codex", plan: "ChatGPT", drives: false,
    install: "Install Codex (npm i -g @openai/codex), then run `codex login` and sign in with your ChatGPT account." },
  { id: "gemini", label: "Gemini CLI", binary: "gemini", plan: "Google", drives: false,
    install: "Install Gemini CLI (npm i -g @google/gemini-cli), then run `gemini` and sign in with Google." },
]);

// What the Studio chat lets the agent do: tapp's own tools, and reading the project. Never a
// shell, never an edit — the agent drives the application under test, not this machine.
export const AGENT_ALLOWED_TOOLS = "mcp__tapp,Read,Glob,Grep";
export const AGENT_DISALLOWED_TOOLS = "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Agent";

/**
 * A GUI-launched process often has a lean PATH, and these CLIs install into a handful of
 * well-known places; look there too, so "not installed" is only said when it is true.
 */
export function findBinary(name, { env = process.env, home = os.homedir() } = {}) {
  const dirs = [...String(env.PATH || "").split(path.delimiter), path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of dirs) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try { if (fs.statSync(file).isFile()) return file; } catch { /* not here */ }
  }
  return "";
}

export function execStatus(binary, args, { env = process.env, timeoutMs = 15_000 } = {}) {
  const run = spawnSync(binary, args, { encoding: "utf8", timeout: timeoutMs, env });
  return { code: run.status, out: String(run.stdout || ""), err: String(run.stderr || "") };
}

const base = (engine, binary) => ({ id: engine.id, label: engine.label, plan: engine.plan, binary, drives: engine.drives, account: null, billing: null });
const missing = (engine) => ({ ...base(engine, ""), state: "missing", usable: false, detail: "Not installed on this machine.", fix: engine.install });

/** Claude Code: `claude auth status` says how it is signed in. A plan is what makes this free to use. */
export function claudeStatus({ env = process.env, home = os.homedir(), exec = execStatus } = {}) {
  const engine = ENGINES[0];
  const binary = findBinary(engine.binary, { env, home });
  if (!binary) return missing(engine);
  let info = null;
  try { info = JSON.parse(exec(binary, ["auth", "status"], { env }).out); } catch { /* not JSON: an old build, or not signed in */ }
  if (!info || info.loggedIn !== true) {
    return { ...base(engine, binary), state: "warning", usable: false, detail: "Not signed in.", fix: "Run `claude` in a terminal and sign in with your Claude account." };
  }
  const account = { email: String(info.email || ""), plan: String(info.subscriptionType || "") };
  if (info.authMethod === "claude.ai") {
    const plan = account.plan ? `Claude ${account.plan[0].toUpperCase()}${account.plan.slice(1)}` : "Claude";
    return { ...base(engine, binary), state: "ok", usable: true, billing: "plan", account, detail: `${plan} plan${account.email ? ` · ${account.email}` : ""}`, fix: "" };
  }
  return { ...base(engine, binary), state: "warning", usable: true, billing: "api-key", account, detail: "Signed in with an API key, which bills per use.", fix: "Sign in with your Claude account instead: run `claude`, then /login." };
}

// The ChatGPT account Codex is signed in with, from its saved sign-in: the id token's payload
// carries the address. Read for display only; nothing here is verified or sent anywhere.
function codexEmail(home) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(home, ".codex", "auth.json"), "utf8"));
    const token = String(saved?.tokens?.id_token || "");
    const payload = token.split(".")[1];
    if (!payload) return "";
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return String(claims.email || "");
  } catch { return ""; }
}

/** Codex: `codex login status` says "Logged in using ChatGPT", or an API key, or nothing. */
export function codexStatus({ env = process.env, home = os.homedir(), exec = execStatus } = {}) {
  const engine = ENGINES[1];
  const binary = findBinary(engine.binary, { env, home });
  if (!binary) return missing(engine);
  const { out, err } = exec(binary, ["login", "status"], { env });
  const text = `${out}\n${err}`;
  if (/logged in using chatgpt/i.test(text)) {
    const email = codexEmail(home);
    return { ...base(engine, binary), state: "ok", usable: true, billing: "plan", account: { email, plan: "ChatGPT" }, detail: `ChatGPT plan${email ? ` · ${email}` : ""}`, fix: "" };
  }
  if (/api key/i.test(text)) return { ...base(engine, binary), state: "warning", usable: true, billing: "api-key", detail: "Signed in with an API key, which bills per use.", fix: "Sign in with your ChatGPT account instead: run `codex logout`, then `codex login`." };
  return { ...base(engine, binary), state: "warning", usable: false, detail: "Not signed in.", fix: "Run `codex login` in a terminal; you get a link and a code to finish on any device." };
}

/** Gemini CLI keeps its Google sign-in in a credentials file; present means signed in. */
export function geminiStatus({ env = process.env, home = os.homedir() } = {}) {
  const engine = ENGINES[2];
  const binary = findBinary(engine.binary, { env, home });
  if (!binary) return missing(engine);
  if (fs.existsSync(path.join(home, ".gemini", "oauth_creds.json"))) return { ...base(engine, binary), state: "ok", usable: true, billing: "plan", account: { email: "", plan: "Google" }, detail: "Google account", fix: "" };
  return { ...base(engine, binary), state: "warning", usable: false, detail: "Not signed in.", fix: "Run `gemini` in a terminal and sign in with Google." };
}

/** Every engine tapp knows, as found on this machine. */
export function detectEngines(options = {}) {
  return [claudeStatus(options), codexStatus(options), geminiStatus(options)];
}

/** The MCP server the agent gets: this very package, on this machine, sharing TAPP_HOME. */
export function tappMcpConfig({ packageRoot, env = process.env, node = process.execPath }) {
  const serverEnv = {};
  if (env.TAPP_HOME) serverEnv.TAPP_HOME = env.TAPP_HOME;
  return JSON.stringify({ mcpServers: { tapp: { command: node, args: [path.join(packageRoot, "bin", "tapp.js"), "mcp"], ...(Object.keys(serverEnv).length ? { env: serverEnv } : {}) } } });
}

/**
 * How Claude Code is run for one chat turn. Non-interactive, streaming its events as JSON lines,
 * with tapp's tools and the project to read — and the tools that would touch this machine ruled
 * out by name, not only left unlisted. A thread continues with `--resume`.
 */
export function claudeArguments({ prompt, resume = "", mcpConfig, systemPromptFile = "", model = "" }) {
  const args = ["-p", String(prompt), "--output-format", "stream-json", "--verbose", "--permission-mode", "default",
    "--allowedTools", AGENT_ALLOWED_TOOLS, "--disallowedTools", AGENT_DISALLOWED_TOOLS];
  if (mcpConfig) args.push("--mcp-config", mcpConfig);
  if (systemPromptFile) args.push("--append-system-prompt-file", systemPromptFile);
  if (model) args.push("--model", model);
  if (resume) args.push("--resume", resume);
  return args;
}

const TOOL_PREFIX = /^mcp__tapp__/;
const textOf = (content) => Array.isArray(content) ? content.map((b) => (typeof b === "string" ? b : b?.text || "")).join(" ") : String(content ?? "");
function summarizeInput(input) {
  if (!input || typeof input !== "object") return "";
  for (const key of ["goal", "url", "target", "action", "name", "id", "text", "query", "capture", "platform", "projectDir"]) {
    if (typeof input[key] === "string" && input[key].trim()) return `${key}: ${input[key].trim().slice(0, 80)}`;
  }
  return "";
}

/**
 * One Claude Code event → the chat lines a person should see. Thinking and partial deltas are
 * not shown; tool calls are named in tapp's own words; a tool error is a warning; the final
 * answer is the result. Returns an array, since one assistant message can carry several blocks.
 */
export function agentLines(event) {
  if (!event || typeof event !== "object") return [];
  if (event.type === "system" && event.subtype === "init") return [{ phase: "agent", text: "Claude Code is on it." }];
  if (event.type === "assistant") {
    const blocks = event.message?.content;
    if (!Array.isArray(blocks)) return [];
    const lines = [];
    for (const block of blocks) {
      if (block?.type === "text" && String(block.text || "").trim()) lines.push({ phase: "agent", text: String(block.text).trim().slice(0, 1200) });
      if (block?.type === "tool_use") {
        const name = String(block.name || "tool").replace(TOOL_PREFIX, "");
        const summary = summarizeInput(block.input);
        lines.push({ phase: "agent-tool", text: `${name}${summary ? ` — ${summary}` : ""}` });
      }
    }
    return lines;
  }
  if (event.type === "user") {
    const blocks = event.message?.content;
    if (!Array.isArray(blocks)) return [];
    return blocks.filter((b) => b?.type === "tool_result" && b.is_error).map((b) => ({ phase: "agent-warning", text: `Tool error: ${textOf(b.content).trim().slice(0, 300)}` }));
  }
  if (event.type === "result") {
    const text = String(event.result || "").trim().slice(0, 1200);
    if (event.is_error) return [{ phase: "agent-warning", text: text || "Claude Code stopped with an error." }];
    return text ? [{ phase: "agent-done", text }] : [];
  }
  return [];
}

/**
 * Run Claude Code for one turn. Resolves with the result event's facts once the process ends;
 * rejects when it ends with no result. `stop()` ends the turn the way Ctrl-C would.
 */
export function runClaude({ binary, args, cwd, env = process.env, onEvent = () => {} }) {
  const child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let result = null;
  let stderrTail = "";
  let stdoutTail = "";
  child.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk).slice(-2000); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { stdoutTail = (stdoutTail + line).slice(-2000); return; }
    if (event?.type === "result") result = event;
    try { onEvent(event); } catch { /* a listener's problem is not the run's */ }
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", (error) => reject(new Error(`Could not start Claude Code: ${error.message}`)));
    child.on("close", (code, signal) => {
      // The stream can still be draining when the process closes; let it finish.
      setImmediate(() => {
        if (result) {
          resolve({ sessionId: String(result.session_id || ""), text: String(result.result || ""), turns: Number(result.num_turns) || 0, costUsd: Number(result.total_cost_usd) || 0, isError: result.is_error === true, stopped: signal === "SIGINT" });
          return;
        }
        const reason = (stderrTail || stdoutTail).trim().split("\n").filter(Boolean).slice(-3).join(" · ");
        reject(new Error(signal ? `Claude Code was stopped (${signal})` : `Claude Code ended (exit ${code}) without a result${reason ? `: ${reason}` : ""}`));
      });
    });
  });
  return { child, done, stop: () => { try { child.kill("SIGINT"); } catch { /* already gone */ } } };
}

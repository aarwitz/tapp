import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findBinary, claudeStatus, codexStatus, geminiStatus, detectEngines, claudeArguments, tappMcpConfig, agentLines, runClaude, AGENT_ALLOWED_TOOLS, AGENT_DISALLOWED_TOOLS } from "../mcp-server/src/engines.js";

// A machine with a `claude` on it, as a stub: `auth status` answers like the real one (captured
// 2026-11-22 from Claude Code 2.1.270 on a Max plan), and a prompt run prints the event stream.
function machine({ claude = true, codex = false, auth = { loggedIn: true, authMethod: "claude.ai", email: "o@example.test", subscriptionType: "max" }, codexText = "Logged in using ChatGPT", run = "" } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-engines-home-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  if (claude) {
    fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a[0] === "auth") { console.log(${JSON.stringify(JSON.stringify(auth))}); process.exit(0); }\n${run}\n`, { mode: 0o755 });
  }
  if (codex) fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\necho "${codexText}"\n`, { mode: 0o755 });
  return { home, bin, env: { PATH: bin } };
}

test("a binary is found on PATH or in the places these CLIs install, and nowhere else", () => {
  const { bin, env, home } = machine();
  assert.equal(findBinary("claude", { env, home }), path.join(bin, "claude"));
  assert.equal(findBinary("codex", { env, home }), "");
  // A GUI-launched Studio has a lean PATH; ~/.local/bin is where `codex` lands.
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".local", "bin", "codex"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(findBinary("codex", { env: { PATH: "" }, home }), path.join(home, ".local", "bin", "codex"));
});

test("Claude Code is reported by how it is signed in: a plan, an API key, or not at all", () => {
  const plan = claudeStatus(machine());
  assert.equal(plan.state, "ok");
  assert.equal(plan.usable, true);
  assert.equal(plan.billing, "plan");
  assert.equal(plan.detail, "Claude Max plan · o@example.test");
  assert.equal(plan.drives, true);

  const key = claudeStatus(machine({ auth: { loggedIn: true, authMethod: "apiKey", email: "" } }));
  assert.equal(key.state, "warning");
  assert.equal(key.usable, true, "an API key works; it just bills per use");
  assert.equal(key.billing, "api-key");
  assert.match(key.fix, /Sign in with your Claude account/);

  const out = claudeStatus(machine({ auth: { loggedIn: false } }));
  assert.equal(out.state, "warning");
  assert.equal(out.usable, false);
  assert.match(out.fix, /sign in with your Claude account/);

  const none = claudeStatus(machine({ claude: false }));
  assert.equal(none.state, "missing");
  assert.equal(none.usable, false);
  assert.match(none.fix, /claude\.com\/code/);
});

test("Codex and Gemini are read the same way, and never drive the chat yet", () => {
  const chat = codexStatus(machine({ codex: true }));
  assert.equal(chat.state, "ok");
  assert.equal(chat.billing, "plan");
  assert.equal(chat.drives, false);
  const key = codexStatus(machine({ codex: true, codexText: "Logged in using an API key" }));
  assert.equal(key.billing, "api-key");
  const out = codexStatus(machine({ codex: true, codexText: "Not logged in" }));
  assert.equal(out.usable, false);
  assert.match(out.fix, /codex login/);
  assert.equal(geminiStatus(machine()).state, "missing");
  assert.deepEqual(detectEngines(machine()).map((e) => e.id), ["claude", "codex", "gemini"]);
});

test("the agent gets tapp's tools and the project to read — never a shell, never an edit", () => {
  const args = claudeArguments({ prompt: "Check the sign-in", mcpConfig: '{"mcpServers":{}}', systemPromptFile: "/tmp/system.md" });
  assert.deepEqual(args.slice(0, 2), ["-p", "Check the sign-in"]);
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.equal(args[args.indexOf("--allowedTools") + 1], AGENT_ALLOWED_TOOLS);
  assert.equal(args[args.indexOf("--disallowedTools") + 1], AGENT_DISALLOWED_TOOLS);
  assert.match(AGENT_ALLOWED_TOOLS, /^mcp__tapp\b/);
  assert.doesNotMatch(AGENT_ALLOWED_TOOLS, /Bash|Edit|Write/);
  assert.match(AGENT_DISALLOWED_TOOLS, /\bBash\b/);
  assert.equal(args.includes("--resume"), false, "a new thread has nothing to resume");
  assert.equal(claudeArguments({ prompt: "x", resume: "sess-9" }).at(-1), "sess-9");
  const config = JSON.parse(tappMcpConfig({ packageRoot: "/pkg", env: { TAPP_HOME: "/home/x/.tapp" }, node: "/usr/bin/node" }));
  assert.deepEqual(config.mcpServers.tapp, { command: "/usr/bin/node", args: ["/pkg/bin/tapp.js", "mcp"], env: { TAPP_HOME: "/home/x/.tapp" } });
  assert.equal(JSON.parse(tappMcpConfig({ packageRoot: "/pkg", env: {} })).mcpServers.tapp.env, undefined);
});

test("Claude Code's events become the lines a person should see", () => {
  // Shapes captured from a real `claude -p … --output-format stream-json --verbose` run.
  const init = { type: "system", subtype: "init", session_id: "c6f1", model: "claude-x", permissionMode: "default" };
  const rate = { type: "rate_limit_event", session_id: "c6f1" };
  const said = { type: "assistant", session_id: "c6f1", message: { content: [{ type: "text", text: "  Looking at the sign-in page.  " }, { type: "tool_use", name: "mcp__tapp__tapp_look", input: { url: "http://localhost:3000/login" } }] } };
  const failed = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: "No booted simulator" }] }] } };
  const fine = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } };
  const done = { type: "result", subtype: "success", session_id: "c6f1", result: "The sign-in works.", num_turns: 3, total_cost_usd: 0.1, is_error: false };
  assert.deepEqual(agentLines(init), [{ phase: "agent", text: "Claude Code is on it." }]);
  assert.deepEqual(agentLines(rate), []);
  assert.deepEqual(agentLines(said), [{ phase: "agent", text: "Looking at the sign-in page." }, { phase: "agent-tool", text: "tapp_look — url: http://localhost:3000/login" }]);
  assert.deepEqual(agentLines(failed), [{ phase: "agent-warning", text: "Tool error: No booted simulator" }]);
  assert.deepEqual(agentLines(fine), [], "a tool that answered is not news; what it found arrives in the agent's words");
  assert.deepEqual(agentLines(done), [{ phase: "agent-done", text: "The sign-in works." }]);
  assert.deepEqual(agentLines({ ...done, is_error: true, result: "" }), [{ phase: "agent-warning", text: "Claude Code stopped with an error." }]);
  assert.deepEqual(agentLines(null), []);
});

test("a turn resolves with the result's facts, fails with the reason, and stops the way Ctrl-C would", async () => {
  const ok = machine({ run: `console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }));\nconsole.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }));\nconsole.log(JSON.stringify({ type: "result", subtype: "success", session_id: "s1", result: "done", num_turns: 2, total_cost_usd: 0.02, is_error: false }));` });
  const events = [];
  const good = await runClaude({ binary: path.join(ok.bin, "claude"), args: ["-p", "x"], cwd: ok.home, onEvent: (e) => events.push(e.type) }).done;
  assert.deepEqual(good, { sessionId: "s1", text: "done", turns: 2, costUsd: 0.02, isError: false, stopped: false });
  assert.deepEqual(events, ["system", "assistant", "result"]);

  const bad = machine({ run: `console.error("Not logged in · Please run /login");\nprocess.exit(2);` });
  await assert.rejects(runClaude({ binary: path.join(bad.bin, "claude"), args: ["-p", "x"], cwd: bad.home }).done, /ended \(exit 2\) without a result: Not logged in · Please run \/login/);

  const slow = machine({ run: `console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s2" }));\nprocess.on("SIGINT", () => process.exit(130));\nsetTimeout(() => {}, 20000);` });
  const run = runClaude({ binary: path.join(slow.bin, "claude"), args: ["-p", "x"], cwd: slow.home });
  await new Promise((resolve) => setTimeout(resolve, 300));
  run.stop();
  await assert.rejects(run.done, /without a result|stopped/);
});

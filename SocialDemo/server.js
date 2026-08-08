import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4180);
const fault = process.env.SOCIAL_DEMO_FAULT || "";
const propagationMs = Number(process.env.SOCIAL_DEMO_PROPAGATION_MS || 350);
const users = {
  "alice@example.test": { id: "alice", name: "Alice" },
  "bob@example.test": { id: "bob", name: "Bob" },
};
const sessions = new Map();
let state;

function reset() {
  state = { posts: [], messages: [], nextPost: 1, nextMessage: 1 };
  sessions.clear();
}
reset();

function json(res, status, value, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error("request body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

function currentUser(req) {
  const cookie = req.headers.cookie || "";
  const sid = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("tapp_session="))?.split("=")[1];
  return sid ? sessions.get(sid) : null;
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) json(res, 401, { error: "sign in required" });
  return user;
}

async function api(req, res, url) {
  if (req.method === "POST" && url.pathname === "/__tapp/reset") {
    reset();
    return json(res, 200, { reset: true });
  }
  if (req.method === "POST" && url.pathname === "/api/login") {
    const input = await body(req);
    const user = users[String(input.email || "").toLowerCase()];
    if (!user || input.password !== "demo") return json(res, 401, { error: "invalid credentials" });
    const sid = crypto.randomUUID();
    sessions.set(sid, user);
    return json(res, 200, user, { "set-cookie": `tapp_session=${sid}; Path=/; HttpOnly; SameSite=Strict` });
  }
  if (req.method === "POST" && url.pathname === "/api/logout") {
    const cookie = req.headers.cookie || "";
    const sid = cookie.match(/tapp_session=([^;]+)/)?.[1];
    if (sid) sessions.delete(sid);
    return json(res, 200, { ok: true }, { "set-cookie": "tapp_session=; Path=/; Max-Age=0" });
  }
  if (req.method === "GET" && url.pathname === "/api/me") return json(res, 200, { user: currentUser(req) });

  const user = requireUser(req, res);
  if (!user) return;
  if (req.method === "GET" && url.pathname === "/api/feed") {
    const now = Date.now();
    const posts = state.posts.filter((post) => post.visibleAt <= now && !(fault === "hide-cross-actor-posts" && post.author.id !== user.id))
      .map((post) => ({ ...post, likes: [...post.likes], liked: post.likes.has(user.id) }));
    return json(res, 200, { posts });
  }
  if (req.method === "POST" && url.pathname === "/api/posts") {
    const input = await body(req);
    if (!String(input.text || "").trim()) return json(res, 422, { error: "text required" });
    const post = { id: state.nextPost++, text: String(input.text).trim(), author: user, likes: new Set(), visibleAt: Date.now() + propagationMs };
    state.posts.unshift(post);
    return json(res, 201, { id: post.id });
  }
  const like = url.pathname.match(/^\/api\/posts\/(\d+)\/like$/);
  if (req.method === "POST" && like) {
    const post = state.posts.find((item) => item.id === Number(like[1]));
    if (!post) return json(res, 404, { error: "post not found" });
    post.likes.add(user.id);
    return json(res, 200, { likes: post.likes.size });
  }
  if (req.method === "GET" && url.pathname === "/api/messages") {
    const other = String(url.searchParams.get("with") || "");
    const now = Date.now();
    const messages = state.messages.filter((message) => message.visibleAt <= now &&
      ((message.from === user.id && message.to === other) || (message.from === other && message.to === user.id)) &&
      !(fault === "drop-cross-actor-messages" && message.to === user.id));
    return json(res, 200, { messages });
  }
  if (req.method === "POST" && url.pathname === "/api/messages") {
    const input = await body(req);
    const to = Object.values(users).find((candidate) => candidate.id === input.to);
    if (!to || !String(input.text || "").trim()) return json(res, 422, { error: "recipient and text required" });
    const message = { id: state.nextMessage++, from: user.id, to: to.id, text: String(input.text).trim(), visibleAt: Date.now() + propagationMs };
    state.messages.push(message);
    return json(res, 201, { id: message.id });
  }
  json(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/") || url.pathname === "/__tapp/reset") return await api(req, res, url);
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!new Set(["index.html", "app.js", "styles.css"]).has(file)) return json(res, 404, { error: "not found" });
    const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
    res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
    fs.createReadStream(path.join(root, file)).pipe(res);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Tapp SocialDemo listening on http://127.0.0.1:${port} (fault=${fault || "none"})`);
});

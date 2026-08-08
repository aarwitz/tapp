const root = document.querySelector("#app");
let user = null;
let screen = "Feed";
let chattingWith = "";
let pollTimer = null;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value;
}

function escape(value) {
  const node = document.createElement("span");
  node.textContent = String(value);
  return node.innerHTML;
}

function shell(content) {
  root.innerHTML = `<nav><strong>Tapp Social</strong><span class="spacer"></span>
    <button class="secondary" data-nav="Feed">Feed</button><button class="secondary" data-nav="Messages">Messages</button>
    <button class="secondary" id="logout">Log out</button></nav>${content}`;
  root.querySelectorAll("[data-nav]").forEach((button) => button.addEventListener("click", () => show(button.dataset.nav)));
  root.querySelector("#logout").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); user = null; login(); });
}

function login(error = "") {
  clearInterval(pollTimer);
  root.innerHTML = `<section class="card"><h1>Sign in</h1><p class="muted">Use one of the isolated test actors.</p>
    ${error ? `<p class="error">${escape(error)}</p>` : ""}
    <label for="email">Email</label><input id="email" autocomplete="username">
    <label for="password">Password</label><input id="password" type="password" autocomplete="current-password">
    <button id="signin">Sign in</button></section>`;
  root.querySelector("#signin").addEventListener("click", async () => {
    try {
      user = await api("/api/login", { method: "POST", body: JSON.stringify({ email: root.querySelector("#email").value, password: root.querySelector("#password").value }) });
      show("Feed");
    } catch (e) { login(e.message); }
  });
}

async function refreshFeed() {
  if (!user || screen !== "Feed") return;
  const { posts } = await api("/api/feed");
  const list = root.querySelector("#posts");
  if (!list) return;
  list.innerHTML = posts.length ? posts.map((post) => `<article><strong>${escape(post.author.name)}</strong>
    <p data-testid="post-${post.id}">${escape(post.text)}</p>
    <button class="secondary like" data-id="${post.id}" aria-label="Like ${escape(post.text)}">${post.liked ? "Liked" : "Like"}</button>
    <span>${post.likes.length} ${post.likes.length === 1 ? "like" : "likes"}</span></article>`).join("") : `<p class="muted">No posts yet.</p>`;
  list.querySelectorAll(".like").forEach((button) => button.addEventListener("click", async () => { await api(`/api/posts/${button.dataset.id}/like`, { method: "POST" }); await refreshFeed(); }));
}

async function feed() {
  shell(`<h1>Feed</h1><section class="card"><label for="post">Post text</label><textarea id="post"></textarea><button id="publish">Publish</button></section><section id="posts"></section>`);
  root.querySelector("#publish").addEventListener("click", async () => {
    const field = root.querySelector("#post");
    await api("/api/posts", { method: "POST", body: JSON.stringify({ text: field.value }) });
    field.value = "";
    await refreshFeed();
  });
  await refreshFeed();
  pollTimer = setInterval(() => refreshFeed().catch(() => {}), 200);
}

async function refreshMessages() {
  if (!user || screen !== "Messages" || !chattingWith) return;
  const { messages } = await api(`/api/messages?with=${encodeURIComponent(chattingWith)}`);
  const list = root.querySelector("#messages-list");
  if (!list) return;
  list.innerHTML = messages.map((message) => `<p class="message ${message.from === user.id ? "mine" : ""}">${escape(message.text)}</p>`).join("");
}

async function openChat(other) {
  chattingWith = other;
  const name = other === "alice" ? "Alice" : "Bob";
  root.querySelector("#conversation").innerHTML = `<h2>Conversation with ${name}</h2><div id="messages-list"></div>
    <label for="message">Message</label><input id="message"><button id="send">Send</button>`;
  root.querySelector("#send").addEventListener("click", async () => {
    const field = root.querySelector("#message");
    await api("/api/messages", { method: "POST", body: JSON.stringify({ to: chattingWith, text: field.value }) });
    field.value = "";
    await refreshMessages();
  });
  await refreshMessages();
}

async function messages() {
  const other = user.id === "alice" ? "bob" : "alice";
  const name = other === "alice" ? "Alice" : "Bob";
  shell(`<h1>Messages</h1><button id="chat" class="secondary">Chat with ${name}</button><section id="conversation" class="card"><p class="muted">Choose a conversation.</p></section>`);
  root.querySelector("#chat").addEventListener("click", () => openChat(other));
  pollTimer = setInterval(() => refreshMessages().catch(() => {}), 200);
}

async function show(next) {
  clearInterval(pollTimer);
  screen = next;
  if (next === "Feed") await feed(); else await messages();
}

const me = await api("/api/me");
user = me.user;
if (user) show("Feed"); else login();

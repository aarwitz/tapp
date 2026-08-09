import { defineContract } from "@aarwitz/tapp/contracts";

export default defineContract({
  name: "socialSystemWorks",
  title: "Alice publishes, Bob reacts, and both exchange messages",
  description: "Proves the social backend as a system rather than checking isolated screens.",
  businessValue: "Customers can publish, discover, react, and communicate across real account boundaries.",
  criticality: "critical",
  platforms: ["web"],
  policy: { always: true, prRelevant: true, nightly: true, tags: ["social", "messaging", "multi-actor"] },
  url: "http://127.0.0.1:4180",
  timeoutMs: 6000,
  variables: {
    POST: "Tapp contract post 7319",
    MESSAGE_TO_ALICE: "Bob received the shared post 8421",
    REPLY_TO_BOB: "Alice received the message 9532",
  },
  actors: {
    alice: {
      session: "isolated",
      role: "member",
      credentials: { email: "$ALICE_EMAIL", password: "$ALICE_PASSWORD" },
    },
    bob: {
      session: "isolated",
      role: "member",
      credentials: { email: "$BOB_EMAIL", password: "$BOB_PASSWORD" },
    },
  },
  setup: [{ request: { method: "POST", path: "/__tapp/reset", status: 200 } }],
  steps: [
    { actor: "alice", task: "signIn", with: { email: "$EMAIL", password: "$PASSWORD" }, reason: "Alice needs an isolated authenticated session." },
    { actor: "bob", task: "signIn", with: { email: "$EMAIL", password: "$PASSWORD" }, reason: "Bob must not share Alice's session." },
    { actor: "alice", task: "createPost", with: { text: "$POST" }, save: { publishedText: "PUBLISHED_POST" } },
    { actor: "bob", expect: { exists: "$PUBLISHED_POST", eventually: { timeoutMs: 6000, pollMs: 250 } }, reason: "Alice's post must propagate across accounts." },
    { actor: "bob", task: "likePost", with: { post: "$PUBLISHED_POST" } },
    { actor: "alice", expect: { exists: "1 like", eventually: { timeoutMs: 6000, pollMs: 250 } }, reason: "Bob's reaction must propagate back to Alice." },
    { actor: "bob", task: "openConversation", with: { recipient: "Alice" } },
    { actor: "bob", task: "sendMessage", with: { message: "$MESSAGE_TO_ALICE" } },
    { actor: "alice", task: "openConversation", with: { recipient: "Bob" } },
    { actor: "alice", expect: { exists: "$MESSAGE_TO_ALICE", eventually: { timeoutMs: 6000, pollMs: 250 } } },
    { actor: "alice", task: "sendMessage", with: { message: "$REPLY_TO_BOB" } },
    { actor: "bob", expect: { exists: "$REPLY_TO_BOB", eventually: { timeoutMs: 6000, pollMs: 250 } }, reason: "Messaging must work bidirectionally." },
  ],
  teardown: [{ request: { method: "POST", path: "/__tapp/reset", status: 200 } }],
  coverage: {
    capabilities: ["authentication", "content publishing", "cross-account feed", "reactions", "bidirectional messaging"],
    sourcePaths: ["app.js", "server.js"],
  },
});

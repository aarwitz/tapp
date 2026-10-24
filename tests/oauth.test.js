import test from "node:test";
import assert from "node:assert/strict";

import { oauthProviders, oauthAuthorizeUrl, oauthEmailFromCode, oauthRedirectUri, isOauthProvider } from "../mcp-server/src/oauth.js";

const GOOGLE = { TAPP_OAUTH_GOOGLE_CLIENT_ID: "google-id", TAPP_OAUTH_GOOGLE_CLIENT_SECRET: "google-secret" };
const GITHUB = { TAPP_OAUTH_GITHUB_CLIENT_ID: "github-id", TAPP_OAUTH_GITHUB_CLIENT_SECRET: "github-secret" };

test("a provider is offered only when this deployment can actually complete it", () => {
  assert.deepEqual(oauthProviders({}), [], "no client id, no button");
  assert.deepEqual(oauthProviders({ TAPP_OAUTH_GOOGLE_CLIENT_ID: "id-only" }), [], "an id without a secret cannot finish the exchange");
  assert.deepEqual(oauthProviders(GOOGLE).map((p) => p.name), ["google"]);
  assert.deepEqual(oauthProviders({ ...GOOGLE, ...GITHUB }).map((p) => p.label), ["Google", "GitHub"]);
  assert.equal(isOauthProvider("google"), true);
  assert.equal(isOauthProvider("facebook"), false);
});

test("the authorize link asks for an email and nothing else, and carries the one-time state", () => {
  const href = oauthAuthorizeUrl({ provider: "google", origin: "https://app.runtapp.com/", state: "abc123", env: GOOGLE });
  const url = new URL(href);
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), "google-id");
  assert.equal(url.searchParams.get("redirect_uri"), "https://app.runtapp.com/auth/google/callback");
  assert.equal(url.searchParams.get("scope"), "openid email", "no profile, no contacts, no drive");
  assert.equal(url.searchParams.get("state"), "abc123");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("prompt"), "select_account", "a shared machine never signs in as whoever was last here");
  assert.doesNotMatch(href, /google-secret/, "the secret never goes near the browser");
  assert.equal(oauthRedirectUri("https://app.runtapp.com", "github"), "https://app.runtapp.com/auth/github/callback");
  assert.throws(() => oauthAuthorizeUrl({ provider: "google", origin: "https://x", state: "s", env: {} }), /not configured/);
});

test("the code is traded for a verified address, and the token is not kept", async () => {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push(String(url));
    if (String(url).includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "at-google" }), { status: 200 });
    if (String(url).includes("openidconnect")) {
      assert.equal(options.headers.authorization, "Bearer at-google");
      return new Response(JSON.stringify({ email: "Owner@Example.test", email_verified: true }), { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  };
  const email = await oauthEmailFromCode({ provider: "google", origin: "https://app.runtapp.com", code: "the-code", env: GOOGLE, fetchImpl });
  assert.equal(email, "Owner@Example.test");
  assert.deepEqual(seen, ["https://oauth2.googleapis.com/token", "https://openidconnect.googleapis.com/v1/userinfo"]);
});

test("an address nobody verified is refused, whichever provider says it", async () => {
  const google = async (url) => (String(url).includes("token")
    ? new Response(JSON.stringify({ access_token: "at" }), { status: 200 })
    : new Response(JSON.stringify({ email: "someone@example.test", email_verified: false }), { status: 200 }));
  await assert.rejects(oauthEmailFromCode({ provider: "google", origin: "https://x", code: "c", env: GOOGLE, fetchImpl: google }), /no verified email/);

  const github = async (url) => (String(url).includes("access_token")
    ? new Response(JSON.stringify({ access_token: "at" }), { status: 200 })
    : new Response(JSON.stringify([{ email: "unverified@example.test", primary: true, verified: false }]), { status: 200 }));
  await assert.rejects(oauthEmailFromCode({ provider: "github", origin: "https://x", code: "c", env: GITHUB, fetchImpl: github }), /no verified email/);

  // GitHub's primary verified address wins over the others it hands back.
  const githubOk = async (url) => (String(url).includes("access_token")
    ? new Response(JSON.stringify({ access_token: "at" }), { status: 200 })
    : new Response(JSON.stringify([{ email: "old@example.test", primary: false, verified: true }, { email: "me@example.test", primary: true, verified: true }]), { status: 200 }));
  assert.equal(await oauthEmailFromCode({ provider: "github", origin: "https://x", code: "c", env: GITHUB, fetchImpl: githubOk }), "me@example.test");
});

test("a provider that refuses says so, including when it refuses with a 200", async () => {
  const refused = async () => new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 200 });
  await assert.rejects(oauthEmailFromCode({ provider: "github", origin: "https://x", code: "c", env: GITHUB, fetchImpl: refused }), /refused the sign-in/);
  const broken = async () => new Response("nope", { status: 500 });
  await assert.rejects(oauthEmailFromCode({ provider: "google", origin: "https://x", code: "c", env: GOOGLE, fetchImpl: broken }), /refused the sign-in \(500\)/);
});

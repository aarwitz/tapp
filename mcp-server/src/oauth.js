// "Continue with Google" — signing in on our own page, without tapp sending a single email.
//
// Two providers, both plain OAuth 2.0 authorization-code flows, both reduced to the one thing a
// tapp account is: a verified email address. No profile, no avatar, no scope beyond that, and no
// token kept after the exchange — the address is traded for a tapp session and everything else
// is dropped on the floor.
//
// Configured by environment, so a Studio that has no client id simply does not offer the button:
//   TAPP_OAUTH_GOOGLE_CLIENT_ID / TAPP_OAUTH_GOOGLE_CLIENT_SECRET
//   TAPP_OAUTH_GITHUB_CLIENT_ID / TAPP_OAUTH_GITHUB_CLIENT_SECRET
//
// The redirect URI is always <origin>/auth/<provider>/callback, which is what you register with
// the provider. Nothing here is ever logged: a client secret, a code and an access token all
// appear only as arguments to fetch.
const PROVIDERS = {
  google: {
    label: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email",
    // `select_account` so a shared machine does not silently sign in as whoever was last here.
    extraAuthorizeParams: { prompt: "select_account", access_type: "online" },
    async email(accessToken, fetchImpl) {
      const response = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw new Error(`Google would not say who signed in (${response.status})`);
      const profile = await response.json();
      // An unverified address would let anyone claim anyone's account.
      if (!profile.email || profile.email_verified === false) throw new Error("That Google account has no verified email address.");
      return String(profile.email);
    },
  },
  github: {
    label: "GitHub",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "user:email",
    extraAuthorizeParams: {},
    async email(accessToken, fetchImpl) {
      const response = await fetchImpl("https://api.github.com/user/emails", {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "tapp" },
      });
      if (!response.ok) throw new Error(`GitHub would not say who signed in (${response.status})`);
      const addresses = await response.json();
      const chosen = (Array.isArray(addresses) ? addresses : []).find((a) => a.primary && a.verified) || (Array.isArray(addresses) ? addresses : []).find((a) => a.verified);
      if (!chosen?.email) throw new Error("That GitHub account has no verified email address.");
      return String(chosen.email);
    },
  },
};

/** Which providers this deployment can actually offer, in the order they should be shown. */
export function oauthProviders(env = process.env) {
  return Object.entries(PROVIDERS)
    .filter(([name]) => (env[`TAPP_OAUTH_${name.toUpperCase()}_CLIENT_ID`] || "").trim() && (env[`TAPP_OAUTH_${name.toUpperCase()}_CLIENT_SECRET`] || "").trim())
    .map(([name, provider]) => ({ name, label: provider.label }));
}

export function isOauthProvider(name) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, String(name));
}

export function oauthRedirectUri(origin, name) {
  return `${String(origin).replace(/\/$/, "")}/auth/${name}/callback`;
}

/** Where to send someone who pressed "Continue with Google". */
export function oauthAuthorizeUrl({ provider, origin, state, env = process.env }) {
  const definition = PROVIDERS[provider];
  if (!definition) throw new Error(`Unknown sign-in provider '${provider}'`);
  const clientId = (env[`TAPP_OAUTH_${provider.toUpperCase()}_CLIENT_ID`] || "").trim();
  if (!clientId) throw new Error(`${definition.label} sign-in is not configured here`);
  const url = new URL(definition.authorizeUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", oauthRedirectUri(origin, provider));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", definition.scope);
  url.searchParams.set("state", state);
  for (const [key, value] of Object.entries(definition.extraAuthorizeParams)) url.searchParams.set(key, value);
  return url.href;
}

/**
 * Trade the code the provider sent back for the one thing we want: a verified email address.
 * The access token is used once, here, and never stored.
 */
export async function oauthEmailFromCode({ provider, origin, code, env = process.env, fetchImpl = fetch }) {
  const definition = PROVIDERS[provider];
  if (!definition) throw new Error(`Unknown sign-in provider '${provider}'`);
  const clientId = (env[`TAPP_OAUTH_${provider.toUpperCase()}_CLIENT_ID`] || "").trim();
  const clientSecret = (env[`TAPP_OAUTH_${provider.toUpperCase()}_CLIENT_SECRET`] || "").trim();
  if (!clientId || !clientSecret) throw new Error(`${definition.label} sign-in is not configured here`);
  const response = await fetchImpl(definition.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "tapp" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: oauthRedirectUri(origin, provider), grant_type: "authorization_code" }).toString(),
  });
  if (!response.ok) throw new Error(`${definition.label} refused the sign-in (${response.status})`);
  const token = await response.json();
  // The provider's own error field, which arrives with a 200 on GitHub.
  if (token.error) throw new Error(`${definition.label} refused the sign-in`);
  if (!token.access_token) throw new Error(`${definition.label} returned no access token`);
  return definition.email(token.access_token, fetchImpl);
}

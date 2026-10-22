// Signing in through Cloudflare Access.
//
// When app.runtapp.com puts Cloudflare Access in front of one path (/auth/cloudflare), Cloudflare
// does the whole identity dance itself — one-time PIN to the address, or Google — and forwards
// the request with a signed JWT (`Cf-Access-Jwt-Assertion`) that names the email. tapp then never
// sends an email of its own; it just checks the signature against the team's published keys and
// opens a session for that address.
//
// Verification is deliberately plain Node: RS256 over the JWT's signing input, keys fetched from
// https://<team>.cloudflareaccess.com/cdn-cgi/access/certs and cached for an hour, `aud` pinned
// to this application's tag, `iss` pinned to the team, `exp` honoured. Nothing else is trusted.
import crypto from "node:crypto";

const b64url = (value) => Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const JWKS_TTL_MS = 60 * 60 * 1000;

export function accessConfig(env = process.env) {
  const teamDomain = (env.TAPP_ACCESS_TEAM_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const aud = (env.TAPP_ACCESS_AUD || "").trim();
  return teamDomain && aud ? { teamDomain, aud } : null;
}

export function createAccessVerifier({ teamDomain, aud, fetchImpl = fetch, now = () => Date.now() }) {
  const issuer = `https://${teamDomain}`;
  let cache = { keys: null, fetchedAt: 0 };

  async function keys(force = false) {
    if (!force && cache.keys && now() - cache.fetchedAt < JWKS_TTL_MS) return cache.keys;
    const response = await fetchImpl(`${issuer}/cdn-cgi/access/certs`);
    if (!response.ok) throw new Error(`Access keys unavailable (${response.status})`);
    const body = await response.json();
    cache = { keys: (body.keys || []).filter((k) => k.kty === "RSA"), fetchedAt: now() };
    return cache.keys;
  }

  /** Returns { email } for a valid assertion, or throws with a one-line reason. */
  async function verify(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) throw new Error("Not an Access token");
    let header, claims;
    try { header = JSON.parse(b64url(parts[0]).toString("utf8")); claims = JSON.parse(b64url(parts[1]).toString("utf8")); }
    catch { throw new Error("Malformed Access token"); }
    if (header.alg !== "RS256" || !header.kid) throw new Error("Unexpected Access token algorithm");
    let jwk = (await keys()).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await keys(true)).find((k) => k.kid === header.kid); // rotated since we cached
    if (!jwk) throw new Error("Access token signed by an unknown key");
    const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
    const valid = crypto.verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key, padding: crypto.constants.RSA_PKCS1_PADDING }, b64url(parts[2]));
    if (!valid) throw new Error("Access token signature does not verify");
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(aud)) throw new Error("Access token is for a different application");
    if (claims.iss !== issuer) throw new Error("Access token is from a different team");
    if (typeof claims.exp !== "number" || claims.exp * 1000 < now()) throw new Error("Access token has expired");
    const email = String(claims.email || "").trim().toLowerCase();
    if (!email) throw new Error("Access token carries no email");
    return { email };
  }

  return { verify, issuer };
}

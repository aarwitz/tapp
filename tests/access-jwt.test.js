import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createAccessVerifier, accessConfig } from "../mcp-server/src/access-jwt.js";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256", use: "sig" };
const b64url = (value) => Buffer.from(value).toString("base64url");
function sign(claims, { kid = "key-1", key = privateKey, alg = "RS256" } = {}) {
  const input = `${b64url(JSON.stringify({ alg, kid, typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const signature = crypto.sign("sha256", Buffer.from(input), { key, padding: crypto.constants.RSA_PKCS1_PADDING });
  return `${input}.${signature.toString("base64url")}`;
}
const fetchJwks = (keys = [jwk]) => async () => ({ ok: true, json: async () => ({ keys }) });
const now = Date.parse("2026-10-22T12:00:00Z");
const good = { aud: ["app-tag"], iss: "https://team.cloudflareaccess.com", exp: now / 1000 + 600, email: "Owner@Example.test" };

test("a Cloudflare Access assertion names who signed in, and nothing else is trusted", async () => {
  const verifier = createAccessVerifier({ teamDomain: "team.cloudflareaccess.com", aud: "app-tag", fetchImpl: fetchJwks(), now: () => now });
  assert.deepEqual(await verifier.verify(sign(good)), { email: "owner@example.test" });
  await assert.rejects(verifier.verify(sign({ ...good, aud: ["someone-elses-app"] })), /different application/);
  await assert.rejects(verifier.verify(sign({ ...good, iss: "https://other.cloudflareaccess.com" })), /different team/);
  await assert.rejects(verifier.verify(sign({ ...good, exp: now / 1000 - 1 })), /expired/);
  await assert.rejects(verifier.verify(sign({ ...good, email: "" })), /no email/);
  await assert.rejects(verifier.verify("not.a.token"), /Malformed|Not an Access/);
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  await assert.rejects(verifier.verify(sign(good, { key: other })), /signature does not verify/);
  await assert.rejects(verifier.verify(sign(good, { alg: "none" })), /algorithm/);
});

test("a rotated key is fetched once more before the token is refused", async () => {
  let calls = 0;
  const rotated = { ...jwk, kid: "key-2" };
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ keys: calls === 1 ? [jwk] : [rotated] }) }; };
  const verifier = createAccessVerifier({ teamDomain: "team.cloudflareaccess.com", aud: "app-tag", fetchImpl, now: () => now });
  assert.deepEqual(await verifier.verify(sign(good)), { email: "owner@example.test" });
  assert.deepEqual(await verifier.verify(sign(good, { kid: "key-2" })), { email: "owner@example.test" });
  assert.equal(calls, 2, "keys are cached and re-fetched only on an unknown kid");
  await assert.rejects(verifier.verify(sign(good, { kid: "key-9" })), /unknown key/);
});

test("Access is configured by two plain values, or not at all", () => {
  assert.equal(accessConfig({}), null);
  assert.equal(accessConfig({ TAPP_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" }), null);
  assert.deepEqual(accessConfig({ TAPP_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com/", TAPP_ACCESS_AUD: "abc" }), { teamDomain: "team.cloudflareaccess.com", aud: "abc" });
});

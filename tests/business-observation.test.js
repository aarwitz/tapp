import test from "node:test";
import assert from "node:assert/strict";
import { passiveUrlRisk, resolveObservationUrl } from "../mcp-server/src/business-observation.js";
import { runHostedBusinessCheck } from "../saas/worker/business-check.mjs";

test("ordinary discovered page paths remain on the connected origin", () => {
  assert.equal(resolveObservationUrl("https://business.example", "/contact?branch=east#form"), "https://business.example/contact?branch=east");
  assert.equal(resolveObservationUrl("https://business.example/contact"), "https://business.example/contact");
  assert.equal(passiveUrlRisk("https://business.example/how-to-cancel"), null);
});

test("a passive check rejects recognizable action and signed URLs", () => {
  for (const value of ["/unsubscribe?token=fixture", "/logout", "/%64elete/123", "/settings?action=refund", "/welcome?code=fixture", "/confirm/123"]) {
    assert.ok(passiveUrlRisk(`https://business.example${value}`), value);
    assert.throws(() => resolveObservationUrl("https://business.example", value), /Passive checks/);
  }
});

test("a page path cannot switch origin, introduce credentials, or use URL parser whitespace/backslash tricks", () => {
  for (const value of ["https://other.example", "//other.example", "/\\other.example", "/\n/other.example", " /contact", "javascript:alert(1)", "https://user:password@business.example"]) {
    assert.throws(() => resolveObservationUrl("https://business.example", value), undefined, value);
  }
  assert.throws(() => resolveObservationUrl("https://business.example/unsubscribe?token=fixture"), /Passive checks/);
});

test("the worker rejects action fields before any browser or network access", async () => {
  const base = { id: "a".repeat(20), source: { kind: "website" }, input: { platform: "web", target: "website", pages: 1 } };
  for (const extra of [{ actor: "owner" }, { action: "submit" }, { pages: 6 }, { testPassword: "fixture" }]) {
    await assert.rejects(runHostedBusinessCheck({ job: { ...base, input: { ...base.input, ...extra } }, root: "/unused" }), /Passive checks require/);
  }
});

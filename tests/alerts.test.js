import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { alertForChange, alertMessage, deliverAlert, AlertStore } from "../mcp-server/src/alerts.js";

const passing = { passed: true, at: "2026-10-25T10:00:00Z", executed: 7, total: 7 };
const failing = { passed: false, at: "2026-10-25T11:00:00Z", executed: 3, total: 7 };

test("the news is the change, not the state", () => {
  assert.equal(alertForChange({ previous: passing, current: failing }), "broke");
  assert.equal(alertForChange({ previous: failing, current: passing }), "recovered");
  // A journey that has been failing for a week does not deserve a message every day.
  assert.equal(alertForChange({ previous: failing, current: { ...failing, at: "2026-10-26T11:00:00Z" } }), null);
  assert.equal(alertForChange({ previous: passing, current: { ...passing, at: "2026-10-26T10:00:00Z" } }), null);
  // A first run has changed nothing; it has only started.
  assert.equal(alertForChange({ previous: null, current: failing }), null);
  assert.equal(alertForChange({ previous: passing, current: null }), null);
});

test("the message says what happened in words a person can act on", () => {
  const broke = alertMessage({ kind: "broke", journey: "Coach books a session", status: failing, origin: "https://app.runtapp.com/" });
  assert.match(broke.text, /stopped working/);
  assert.match(broke.text, /Coach books a session/);
  assert.match(broke.text, /3 of 7 steps/);
  assert.match(broke.text, /https:\/\/app\.runtapp\.com\/#runs/);
  assert.equal(broke.state, "failing");
  const back = alertMessage({ kind: "recovered", journey: "Coach books a session", status: passing, origin: "" });
  assert.match(back.text, /working again/);
  assert.equal(back.state, "passing");
});

test("a webhook is posted once, as JSON both Slack and Discord understand", async () => {
  const sent = [];
  const fetchImpl = async (url, options) => { sent.push({ url, body: JSON.parse(options.body) }); return new Response("ok", { status: 200 }); };
  const result = await deliverAlert({ webhook: "https://hooks.slack.com/services/abc", message: alertMessage({ kind: "broke", journey: "J", status: failing }), fetchImpl });
  assert.deepEqual(result, { delivered: true, status: 200 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.text, sent[0].body.content, "Slack reads text, Discord reads content");
  assert.equal(sent[0].body.state, "failing");
});

test("a webhook that cannot be posted to says why, and never reaches this machine", async () => {
  const never = async () => { throw new Error("fetch should not have been called"); };
  for (const [webhook, reason] of [
    ["", /no webhook/],
    ["not a url", /not a URL/],
    ["http://hooks.slack.com/x", /must be https/],
    ["https://localhost/hook", /public address/],
    ["https://127.0.0.1/hook", /public address/],
    ["https://192.168.1.10/hook", /public address/],
    ["https://nas.local/hook", /public address/],
  ]) {
    const result = await deliverAlert({ webhook, message: { text: "x" }, fetchImpl: never });
    assert.equal(result.delivered, false, `${webhook || "(empty)"} must not be posted to`);
    assert.match(result.reason, reason);
  }
  const refused = await deliverAlert({ webhook: "https://example.test/hook", message: { text: "x" }, fetchImpl: async () => new Response("no", { status: 404 }) });
  assert.equal(refused.delivered, false);
  assert.match(refused.reason, /answered 404/);
});

test("the stored URL is write-only: the owner is told where it points, never what it is", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapp-alerts-"));
  const id = "a".repeat(24);
  const store = AlertStore.forAccount(root, id);
  assert.deepEqual(store.summary(), { configured: false, host: null, updatedAt: null, lastDelivery: null });
  store.write({ webhook: "https://hooks.slack.com/services/T000/B000/XXXXSECRETXXXX" });
  const summary = store.summary();
  assert.equal(summary.configured, true);
  assert.equal(summary.host, "hooks.slack.com");
  assert.doesNotMatch(JSON.stringify(summary), /XXXXSECRETXXXX/, "the URL itself never leaves the store");
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  assert.throws(() => AlertStore.forAccount(root, "../x"), /account id/);
});

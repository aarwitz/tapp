// Telling someone their journey stopped working, without tapp sending email.
//
// A monitoring product that only shows you a failure when you happen to open the page is not one.
// tapp has no mail provider by design (see ADR-0009 slice 2b), so the way out is a webhook: the
// owner pastes a URL — Slack and Discord both give you one, and so does anything else that can
// receive a POST — and tapp posts to it when a journey changes state.
//
// Only on a CHANGE. A journey that has been failing for a week does not deserve a message every
// day; what is news is "this used to pass and now it does not", and "it is working again".
import fs from "node:fs";
import path from "node:path";

export const ALERT_EVENTS = Object.freeze(["broke", "recovered"]);

/** Did this result change anything worth telling someone about? */
export function alertForChange({ previous, current }) {
  if (!current) return null;
  // A journey's first run is not news: nothing has changed yet, it has only started.
  if (!previous) return null;
  if (previous.passed === current.passed) return null;
  return current.passed ? "recovered" : "broke";
}

/** What the message says. Plain words, and never a credential — a journey holds none. */
export function alertMessage({ kind, journey, status, origin = "" }) {
  const where = origin ? `${origin.replace(/\/$/, "")}/#runs` : "";
  if (kind === "broke") {
    const detail = status.total ? ` It got ${status.executed} of ${status.total} steps in.` : "";
    return {
      text: `❌ “${journey}” stopped working.${detail}${where ? ` Evidence: ${where}` : ""}`,
      journey, state: "failing", at: status.at, executed: status.executed, total: status.total,
    };
  }
  return {
    text: `✅ “${journey}” is working again.${where ? ` ${where}` : ""}`,
    journey, state: "passing", at: status.at, executed: status.executed, total: status.total,
  };
}

/**
 * Post one message. Slack and Discord both accept a JSON body with `text`/`content`, so send
 * both keys and let the receiver pick; anything else gets the whole thing as JSON anyway.
 */
export async function deliverAlert({ webhook, message, fetchImpl = fetch, timeoutMs = 8000 }) {
  if (!webhook) return { delivered: false, reason: "no webhook configured" };
  let url;
  try { url = new URL(webhook); } catch { return { delivered: false, reason: "that is not a URL" }; }
  if (url.protocol !== "https:") return { delivered: false, reason: "a webhook must be https" };
  // The Studio posts this from the server, so the same rule as every other outbound call applies:
  // public addresses only. A webhook pointing at localhost would reach this machine's own services.
  if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[?::1)/i.test(url.hostname) || /\.local$/i.test(url.hostname)) {
    return { delivered: false, reason: "a webhook must be a public address" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url.href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: message.text, content: message.text, ...message }),
      signal: controller.signal,
    });
    return response.ok ? { delivered: true, status: response.status } : { delivered: false, reason: `the webhook answered ${response.status}` };
  } catch (error) {
    return { delivered: false, reason: String(error?.name === "AbortError" ? "the webhook did not answer in time" : error.message || error).slice(0, 120) };
  } finally { clearTimeout(timer); }
}

/** Where an account's alert settings live: beside its journeys, 0600, no secret but its own URL. */
export class AlertStore {
  constructor({ file }) { this.file = file; }

  static forAccount(accountsRoot, accountId) {
    if (!/^[a-f0-9]{24}$/.test(String(accountId || ""))) throw new Error("Not an account id");
    return new AlertStore({ file: path.join(accountsRoot, "alerts", `${accountId}.json`) });
  }

  read() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return { webhook: "", updatedAt: null, lastDelivery: null }; }
  }

  write(settings) {
    const next = { ...this.read(), ...settings, updatedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(next), { mode: 0o600 });
    return next;
  }

  /** The URL is a secret of sorts — anyone holding it can post into that channel. Show its shape. */
  summary() {
    const settings = this.read();
    if (!settings.webhook) return { configured: false, host: null, updatedAt: null, lastDelivery: settings.lastDelivery || null };
    let host = "a webhook";
    try { host = new URL(settings.webhook).host; } catch { /* keep the generic word */ }
    return { configured: true, host, updatedAt: settings.updatedAt || null, lastDelivery: settings.lastDelivery || null };
  }
}

// How the hosted Studio sends a sign-in link. Two transports:
//
//   TAPP_MAIL_RESEND_KEY + TAPP_MAIL_FROM   → Resend's HTTP API (https://resend.com), the one
//                                              paid-for path; the key is read off the environment
//                                              and never logged.
//   otherwise                                → an outbox directory (TAPP_MAIL_OUTBOX, default
//                                              TAPP_HOME/mail-outbox), one 0600 .eml per message.
//
// The outbox is what tests and a local Studio use, and what a freshly deployed host falls back to
// before a mail provider is configured: the link is on disk for the operator, not lost, and
// never printed to a log that other people read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export function createMailer(env = process.env) {
  const key = (env.TAPP_MAIL_RESEND_KEY || "").trim();
  const from = (env.TAPP_MAIL_FROM || "").trim();
  if (key && from) return resendMailer({ key, from });
  const home = (env.TAPP_HOME || "").trim() || path.join(os.homedir(), ".tapp");
  return outboxMailer({ dir: (env.TAPP_MAIL_OUTBOX || "").trim() || path.join(home, "mail-outbox"), from: from || "tapp <no-reply@localhost>" });
}

export function signInMessage({ to, link, origin }) {
  const host = (() => { try { return new URL(origin).host; } catch { return origin; } })();
  return {
    to,
    subject: `Sign in to tapp`,
    text: `Here is your sign-in link for ${host}:\n\n${link}\n\nIt works once and expires in 15 minutes. If you did not ask for it, ignore this email — nothing happens without the link.`,
    html: `<p>Here is your sign-in link for <strong>${host}</strong>:</p><p><a href="${link}">${link}</a></p><p>It works once and expires in 15 minutes. If you did not ask for it, ignore this email — nothing happens without the link.</p>`,
  };
}

function resendMailer({ key, from }) {
  return {
    transport: "resend",
    from,
    async send(message) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        // The provider's error may quote the request; keep the status and drop the body.
        throw new Error(`Mail provider refused the message (${response.status}${detail ? ", see provider dashboard" : ""})`);
      }
      const body = await response.json().catch(() => ({}));
      return { transport: "resend", id: body.id || null };
    },
  };
}

function outboxMailer({ dir, from }) {
  return {
    transport: "outbox",
    from,
    dir,
    async send(message) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
      const file = path.join(dir, `${id}.eml`);
      const eml = [`From: ${from}`, `To: ${message.to}`, `Subject: ${message.subject}`, `Date: ${new Date().toUTCString()}`, "Content-Type: text/plain; charset=utf-8", "", message.text, ""].join("\r\n");
      fs.writeFileSync(file, eml, { mode: 0o600 });
      return { transport: "outbox", id, file };
    },
  };
}

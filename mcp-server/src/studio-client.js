// Talking to a hosted Studio as the owner's coding agent.
//
// The agent holds a personal access token (created in the Studio, shown once) and sends it as a
// bearer token. That is the whole protocol: list the journeys with their last result, and run
// one. It exists so "make sure this always works" has an answer that does not require a person
// to open a page — the agent asks, and acts on what it is told.
//
// Configuration is two values, from flags or the environment:
//   TAPP_STUDIO   https://app.runtapp.com
//   TAPP_TOKEN    tapp_…
const POLL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function studioConfig({ studio = "", token = "" } = {}, env = process.env) {
  const origin = String(studio || env.TAPP_STUDIO || "").trim().replace(/\/$/, "");
  const value = String(token || env.TAPP_TOKEN || "").trim();
  if (!origin) return null;
  if (!/^https?:\/\/[^\s/]+$/.test(origin)) throw new Error(`'${origin}' is not a Studio URL (expected https://host)`);
  if (!value) throw new Error("A Studio needs a token: create one in the Studio under “Your coding agent”, then set TAPP_TOKEN (or pass --token).");
  if (!value.startsWith("tapp_")) throw new Error("That does not look like a tapp token (they start with tapp_).");
  return { origin, token: value };
}

async function call({ origin, token }, path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(`${origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new Error(`Could not reach the Studio at ${origin}: ${error.message}`);
  }
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* a proxy's error page */ }
  if (response.status === 401) throw new Error("The Studio refused that token. It may have been revoked; create a new one under “Your coding agent”.");
  if (!response.ok) throw new Error(data.error || `The Studio answered ${response.status}`);
  return data;
}

/** Every journey this account owns, with how its last check went. */
export async function listStudioJourneys(config) {
  const { journeys = [] } = await call(config, "/api/journeys");
  return journeys;
}

/** Replay one journey and wait for the verdict. */
export async function runStudioJourney(config, name, { onProgress = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const started = await call(config, "/api/operations/run-flow", { method: "POST", body: { name } });
  // An iOS or Android journey needs a device the Studio does not have; it says so instead of
  // pretending to run, and that answer is the result.
  if (started.kind === "self-host") return { kind: "self-host", message: started.message, command: started.command };
  const jobId = started.job?.id;
  if (!jobId) throw new Error("The Studio did not start the journey");
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  for (;;) {
    const job = await call(config, `/api/jobs/${jobId}`);
    for (const entry of (job.progress || []).slice(seen)) onProgress(entry.text || "");
    seen = (job.progress || []).length;
    if (job.status !== "running") {
      if (job.error) throw new Error(job.error);
      return job.result || { kind: "journey", name, passed: false };
    }
    if (Date.now() > deadline) throw new Error(`The journey was still running after ${Math.round(timeoutMs / 1000)}s`);
    await sleep(POLL_MS);
  }
}

/** One line per journey, for a terminal or an agent's transcript. */
export function formatJourneyStatus(journey) {
  const status = journey.status;
  const state = !status ? "never run" : status.passed ? "passing" : "FAILING";
  const when = status?.at ? ` · ${new Date(status.at).toISOString().replace("T", " ").slice(0, 16)}` : "";
  return `${state === "FAILING" ? "✗" : state === "passing" ? "✓" : "·"} ${journey.name} — ${journey.steps || 0} steps · ${state}${when}`;
}

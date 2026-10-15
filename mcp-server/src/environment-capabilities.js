// Shared capability contract. Provider-specific code belongs behind named hooks.
// Configuration describes authority; only runtime results establish outcomes.
export const environmentPhases = ["prepare", "verify", "cleanup"];
const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const bindingPattern = /^[A-Z_][A-Z0-9_]{0,127}$/;
export function isCredentialBinding(name) {
  return bindingPattern.test(name || "") && !/^(?:HOME|PATH|USER|LOGNAME|SHELL|TMPDIR|TEMP|TMP|PYTHONPATH|JAVA_HOME|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|TAPP_HOME|TAPP_BROWSER_PROXY_SERVER|TAPP_ENFORCE_PUBLIC_EGRESS|FLOW_LOG|TAPP_FLOW_EVIDENCE_DIR)$/i.test(name);
}

export function environmentReadiness(configuration = {}, availableBindings = []) {
  const present = new Set(availableBindings);
  const actors = Object.entries(configuration.actors || {}).map(([name, actor]) => {
    const missing = Object.values(actor.credentials || {}).map(binding => binding.env).filter(name => !present.has(name));
    return { name, role: actor.role || name, status: missing.length ? "needs-credentials" : "configured", missingBindings: missing, authenticated: false };
  });
  const capabilities = Object.entries(configuration.capabilities || {}).map(([name, capability]) => {
    const missing = Object.values(capability.headers || {}).map(binding => binding.env).filter(name => !present.has(name));
    return { name, phase: capability.phase, description: capability.description || name, status: missing.length ? "needs-credentials" : "configured", missingBindings: missing, verified: false };
  });
  return { actors, capabilities, defaultActor: configuration.defaultActor || (actors.length === 1 ? actors[0].name : null),
    environment: configuration.environment || "unknown", isolation: "not-verified",
    message: "Configured access is reusable. Successful login and backend outcomes are established by execution, not configuration." };
}

export function validateEnvironmentConfiguration(config) {
  const errors = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) return ["Environment must be an object"];
  for (const key of Object.keys(config)) if (!["url", "environment", "defaultActor", "actors", "capabilities"].includes(key)) errors.push(`Unsupported environment field: ${key}`);
  if (config.url) {
    try { const url = new URL(config.url); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(); }
    catch { errors.push("App URL must use HTTPS without credentials, query parameters, or a fragment"); }
  }
  if (!["test", "production", "unknown"].includes(config.environment || "unknown")) errors.push("Environment must be test, production, or unknown");
  for (const section of ["actors", "capabilities"]) {
    if (config[section] && (typeof config[section] !== "object" || Array.isArray(config[section]))) errors.push(`${section} must be an object`);
    if (Object.keys(config[section] || {}).length > 30) errors.push(`Too many ${section}`);
  }
  for (const [name, actor] of Object.entries(config.actors || {})) {
    if (!namePattern.test(name) || !actor || typeof actor !== "object" || Array.isArray(actor)) { errors.push("Invalid actor"); continue; }
    if(actor.role !== undefined && (typeof actor.role !== "string" || actor.role.length > 120))errors.push("Actor role must be a short name");
    for (const key of Object.keys(actor)) if (!["role", "credentials"].includes(key)) errors.push(`Unsupported actor field: ${key}`);
    for (const key of ["email", "password"]) if (!isCredentialBinding(actor.credentials?.[key]?.env)) errors.push(`Actor ${name} needs a ${key} binding`);
    for (const [key, binding] of Object.entries(actor.credentials || {})) {
      if (!["email", "password"].includes(key) || !binding || Object.keys(binding).some(key => key !== "env")) errors.push("Actors contain email/password binding names only");
    }
  }
  if (config.defaultActor && !config.actors?.[config.defaultActor]) errors.push("Default actor is not configured");
  for (const [name, hook] of Object.entries(config.capabilities || {})) {
    if (!namePattern.test(name) || !hook || typeof hook !== "object") { errors.push("Invalid capability"); continue; }
    if(hook.description !== undefined && (typeof hook.description !== "string" || hook.description.length > 500))errors.push("Capability description must be short text");
    for (const key of Object.keys(hook)) if (!["phase", "description", "origin", "path", "method", "headers", "status", "expect"].includes(key)) errors.push(`Unsupported capability field: ${key}`);
    if (hook.origin) {
      try { const origin = new URL(hook.origin); if(origin.protocol !== "https:" || origin.origin !== hook.origin)throw new Error(); }
      catch {errors.push(`Capability ${name} needs an HTTPS origin without a path or credentials`);}
    }
    if (!environmentPhases.includes(hook.phase)) errors.push(`Capability ${name} needs prepare, verify, or cleanup phase`);
    if (!/^\/(?!\/)[^?#\\]*$/.test(hook.path || "")) errors.push(`Capability ${name} needs a same-origin path`);
    if (!["GET", "POST"].includes(hook.method || "POST")) errors.push("Hook method must be GET or POST");
    if (hook.phase !== "verify" && hook.method === "GET") errors.push("Preparation and cleanup must use POST");
    if (hook.status !== undefined && (!Number.isInteger(hook.status) || hook.status < 200 || hook.status > 299)) errors.push("Expected status must be 2xx");
    for (const [header, binding] of Object.entries(hook.headers || {})) {
      if (!/^(authorization|x-[a-z0-9-]+)$/i.test(header) || !isCredentialBinding(binding?.env) || Object.keys(binding).some(key => key !== "env")) errors.push("Hook headers must contain authorized credential binding names");
    }
    if (hook.expect !== undefined && (!hook.expect || typeof hook.expect !== "object" || Array.isArray(hook.expect))) errors.push("Expected JSON fields must be an object");
    for (const [field, value] of Object.entries(hook.expect || {})) {
      if (!/^[A-Za-z][A-Za-z0-9_.]{0,127}$/.test(field) || !["string", "number", "boolean"].includes(typeof value)) errors.push("Expected fields must be scalar JSON paths");
    }
    if (hook.phase === "verify" && !Object.keys(hook.expect || {}).length) errors.push(`Verification ${name} must assert at least one JSON field`);
  }
  return errors;
}

export function selectEnvironmentActor(configuration, requested) {
  const names = Object.keys(configuration.actors || {});
  const name = requested || configuration.defaultActor || (names.length === 1 ? names[0] : null);
  if (name && !configuration.actors?.[name]) throw new Error(`Actor '${name}' is not configured`);
  return name ? { name, ...configuration.actors[name] } : null;
}

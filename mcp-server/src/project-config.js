import fs from "node:fs";
import path from "node:path";
import { TAPP_DIRECTORY, projectArtifactDirectory } from "./project-paths.js";

export const PROJECT_CONFIG_RELATIVE_PATH = `${TAPP_DIRECTORY}/project.json`;

const ACTOR_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const CREDENTIAL_NAME = /^[a-z][A-Za-z0-9_-]{0,63}$/;
const SESSIONS = new Set(["default", "isolated"]);
const PROVISIONING_MODES = new Set(["existing", "seeded", "api", "unknown"]);

function cleanActor(actor) {
  return {
    ...(actor.role ? { role: actor.role } : {}),
    session: actor.session || "default",
    provisioning: actor.provisioning || "existing",
    credentials: Object.fromEntries(Object.entries(actor.credentials || {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, binding]) => [name, { env: binding.env }])),
  };
}

export function validateProjectConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) return ["Project configuration must be an object"];
  for (const key of Object.keys(config)) if (!["kind", "schemaVersion", "actors", "lifecycle", "provenance", "web"].includes(key)) errors.push(`unsupported project configuration field '${key}'`);
  if (config.kind !== "tapp-project-config") errors.push("kind must be 'tapp-project-config'");
  if (config.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (config.actors !== undefined && (!config.actors || typeof config.actors !== "object" || Array.isArray(config.actors))) errors.push("actors must be an object");
  for (const [name, actor] of Object.entries(config.actors || {})) {
    if (!ACTOR_NAME.test(name)) errors.push(`actor '${name}' must match ${ACTOR_NAME}`);
    if (!actor || typeof actor !== "object" || Array.isArray(actor)) { errors.push(`actor '${name}' must be an object`); continue; }
    for (const key of Object.keys(actor)) if (!["role", "session", "provisioning", "credentials"].includes(key)) errors.push(`actor '${name}' has unsupported field '${key}'; credential values are forbidden`);
    if (actor.role !== undefined && (typeof actor.role !== "string" || !actor.role.trim())) errors.push(`actor '${name}'.role must be a non-empty string`);
    if (!SESSIONS.has(actor.session || "default")) errors.push(`actor '${name}'.session must be default|isolated`);
    if (!PROVISIONING_MODES.has(actor.provisioning || "existing")) errors.push(`actor '${name}'.provisioning must be existing|seeded|api|unknown`);
    if (actor.credentials !== undefined && (!actor.credentials || typeof actor.credentials !== "object" || Array.isArray(actor.credentials))) {
      errors.push(`actor '${name}'.credentials must be an object of environment bindings`);
      continue;
    }
    for (const [credential, binding] of Object.entries(actor.credentials || {})) {
      if (!CREDENTIAL_NAME.test(credential)) errors.push(`actor '${name}' credential '${credential}' has an invalid name`);
      if (!binding || typeof binding !== "object" || Array.isArray(binding) || !ENV_NAME.test(String(binding.env || ""))) errors.push(`actor '${name}' credential '${credential}' must define env with an uppercase environment-variable name`);
      for (const key of Object.keys(binding || {})) if (key !== "env") errors.push(`actor '${name}' credential '${credential}' may contain only env; credential values are forbidden`);
    }
  }
  if (config.web !== undefined) {
    if (!config.web || typeof config.web !== "object" || Array.isArray(config.web)) errors.push("web must be an object");
    else {
      for (const key of Object.keys(config.web)) if (key !== "port") errors.push(`web has unsupported field '${key}'; the managed web host is always 127.0.0.1`);
      if (config.web.port !== undefined && (!Number.isInteger(config.web.port) || config.web.port < 1 || config.web.port > 65535)) errors.push("web.port must be an integer between 1 and 65535");
    }
  }
  if (config.lifecycle !== undefined && (!config.lifecycle || typeof config.lifecycle !== "object" || Array.isArray(config.lifecycle))) errors.push("lifecycle must be an object");
  for (const key of Object.keys(config.lifecycle || {})) if (!["setup", "teardown"].includes(key)) errors.push(`lifecycle has unsupported phase '${key}'`);
  if (config.provenance !== undefined && (!config.provenance || typeof config.provenance !== "object" || Array.isArray(config.provenance))) errors.push("provenance must be an object");
  for (const key of Object.keys(config.provenance || {})) if (!["updatedAt", "updatedBy"].includes(key)) errors.push(`provenance has unsupported field '${key}'`);
  for (const phase of ["setup", "teardown"]) {
    if (config.lifecycle?.[phase] !== undefined && !Array.isArray(config.lifecycle[phase])) errors.push(`lifecycle.${phase} must be an array`);
    for (const [index, step] of (config.lifecycle?.[phase] || []).entries()) {
      if (!step?.request || typeof step.request !== "object") errors.push(`lifecycle.${phase}[${index}] must be a request step`);
      else if (!/^\/(?!\/)/.test(String(step.request.path || ""))) errors.push(`lifecycle.${phase}[${index}].request.path must be same-origin and start with one /`);
    }
  }
  return errors;
}

export function readProjectConfig(projectDir, { required = false } = {}) {
  const root = fs.realpathSync(path.resolve(projectDir || process.cwd()));
  const relativePath = `${projectArtifactDirectory(root)}/project.json`;
  const configPath = path.join(root, relativePath);
  if (!fs.existsSync(configPath)) {
    if (required) throw new Error(`Project configuration not found: ${configPath}`);
    return { root, path: configPath, relativePath, config: { kind: "tapp-project-config", schemaVersion: 1, actors: {} }, exists: false, errors: [] };
  }
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); }
  catch (error) { return { root, path: configPath, relativePath, config: null, exists: true, errors: [`Invalid JSON: ${error.message}`] }; }
  return { root, path: configPath, relativePath, config, exists: true, errors: validateProjectConfig(config) };
}

export function configureActor(projectDir, { name, role = "", session = "default", provisioning = "existing", credentials = {}, replace = false } = {}) {
  const loaded = readProjectConfig(projectDir);
  if (loaded.errors.length) throw new Error(`Existing project configuration is invalid: ${loaded.errors.join("; ")}`);
  if (!ACTOR_NAME.test(String(name || ""))) throw new Error("Actor name must start with a letter and contain only letters, numbers, underscore, or hyphen (max 64)");
  if (loaded.config.actors?.[name] && !replace) throw new Error(`Actor '${name}' already exists; inspect it or pass --replace to update its non-secret bindings`);
  const actor = cleanActor({ role: String(role || "").trim(), session, provisioning, credentials });
  const next = {
    ...loaded.config,
    kind: "tapp-project-config",
    schemaVersion: 1,
    actors: { ...(loaded.config.actors || {}), [name]: actor },
    provenance: { ...(loaded.config.provenance || {}), updatedAt: new Date().toISOString(), updatedBy: "explicit-human-configuration" },
  };
  const errors = validateProjectConfig(next);
  if (errors.length) throw new Error(errors.join("; "));
  fs.mkdirSync(path.dirname(loaded.path), { recursive: true });
  const temporary = `${loaded.path}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, loaded.path);
  return { path: loaded.path, relativePath: loaded.relativePath, config: next, actor: next.actors[name] };
}

export function credentialBindingsFromValue(credentials = {}) {
  const out = {};
  for (const [name, value] of Object.entries(credentials || {})) {
    const match = /^\$([A-Z_][A-Z0-9_]*)$/.exec(String(value || ""));
    if (match) out[name] = match[1];
  }
  return out;
}

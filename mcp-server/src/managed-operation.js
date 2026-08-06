// Versioned transport contract between a Tapp control plane and a managed
// runner. This carries identity and intent only; target detection, builds,
// baselines, and verdicts remain owned by shared product operations.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANAGED_OPERATION_SCHEMA_VERSION = 1;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const engineVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;

function cleanCapabilities(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim().toLowerCase()).filter((value) => /^[a-z0-9][a-z0-9._-]{1,63}$/.test(value)))].sort();
}

export function createManagedOperationEnvelope({
  id = crypto.randomBytes(12).toString("hex"),
  repository,
  installationId,
  revision,
  operation = "gate",
  platform = "",
  targetId = "",
  capabilities = [],
  inputs = {},
} = {}) {
  const envelope = {
    kind:"tapp-managed-operation",
    schemaVersion:MANAGED_OPERATION_SCHEMA_VERSION,
    id:String(id || ""),
    repository:{ provider:"github", nameWithOwner:String(repository || ""), installationId:Number(installationId), revision:String(revision || "").toLowerCase() },
    operation:{ name:String(operation || ""), platform:String(platform || "").toLowerCase(), targetId:String(targetId || "") },
    engine:{ version:engineVersion, artifactSchemaVersion:1 },
    capabilities:cleanCapabilities(capabilities),
    inputs:{ actions:Math.max(1, Math.min(200, Number(inputs.actions) || 40)), timeout:Math.max(30, Math.min(3600, Number(inputs.timeout) || 600)), failOn:String(inputs.failOn || "gate") },
  };
  validateManagedOperationEnvelope(envelope);
  return envelope;
}

export function validateManagedOperationEnvelope(envelope) {
  if (!envelope || envelope.kind !== "tapp-managed-operation" || envelope.schemaVersion !== MANAGED_OPERATION_SCHEMA_VERSION) throw new Error(`Unsupported managed-operation envelope; expected schema ${MANAGED_OPERATION_SCHEMA_VERSION}`);
  if (!/^[a-f0-9]{16,64}$/.test(String(envelope.id || ""))) throw new Error("Managed operation id is invalid");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(envelope.repository?.nameWithOwner || ""))) throw new Error("Managed operation repository identity is invalid");
  if (!Number.isSafeInteger(envelope.repository?.installationId) || envelope.repository.installationId < 0) throw new Error("Managed operation installation identity is invalid");
  if (!/^[a-f0-9]{40}$/.test(String(envelope.repository?.revision || ""))) throw new Error("Managed operation requires an exact 40-character Git revision");
  if (!new Set(["inspect", "gate"]).has(envelope.operation?.name)) throw new Error(`Unsupported managed product operation '${envelope.operation?.name || ""}'`);
  if (envelope.operation?.platform && !new Set(["ios", "android", "web"]).has(envelope.operation.platform)) throw new Error("Managed operation platform must be ios, android, or web");
  if (!Array.isArray(envelope.capabilities)) throw new Error("Managed operation capabilities must be an array");
  if (!new Set(["gate", "high", "critical"]).has(envelope.inputs?.failOn)) throw new Error("Managed operation failOn policy is invalid");
  return envelope;
}

export function verifyManagedCheckout(envelope, checkoutRoot) {
  validateManagedOperationEnvelope(envelope);
  const gitHead = path.join(checkoutRoot, ".git", "HEAD");
  if (!fs.existsSync(gitHead)) throw new Error("Managed operation checkout is not a Git worktree");
  return envelope.repository.revision;
}

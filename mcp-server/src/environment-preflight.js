import fs from "node:fs";
import path from "node:path";

export const STORAGE_BLOCK_BYTES = 256 * 1024 * 1024;
export const STORAGE_WARN_BYTES = 5 * 1024 * 1024 * 1024;

function existingAncestor(candidate) {
  let current = path.resolve(candidate || process.cwd());
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

export function formatStorage(bytes) {
  const gib = Number(bytes || 0) / (1024 ** 3);
  return gib >= 1 ? `${gib.toFixed(gib >= 10 ? 0 : 1)} GiB` : `${Math.round(Number(bytes || 0) / (1024 ** 2))} MiB`;
}

export function storagePreflight(candidate, { statfs = fs.statfsSync, blockBytes = STORAGE_BLOCK_BYTES, warnBytes = STORAGE_WARN_BYTES } = {}) {
  const checkedPath = existingAncestor(candidate);
  if (!checkedPath || typeof statfs !== "function") return { ok: true, level: "unknown", path: checkedPath || path.resolve(candidate || process.cwd()), freeBytes: null };
  try {
    const stats = statfs(checkedPath);
    const freeBytes = Number(stats.bavail ?? stats.bfree ?? 0) * Number(stats.bsize ?? 0);
    const level = freeBytes < blockBytes ? "blocked" : freeBytes < warnBytes ? "warning" : "ok";
    return {
      ok: level !== "blocked",
      level,
      path: checkedPath,
      freeBytes,
      message: level === "blocked"
        ? `Only ${formatStorage(freeBytes)} is free where Tapp writes evidence. Free disk space before testing; the run was not started and no app-crash finding was created.`
        : level === "warning"
          ? `Only ${formatStorage(freeBytes)} is free where Tapp writes builds and evidence; iOS builds can require several GiB.`
          : `${formatStorage(freeBytes)} free for Tapp builds and evidence`,
    };
  } catch (error) {
    return { ok: true, level: "unknown", path: checkedPath, freeBytes: null, message: `Free disk space could not be checked: ${error.message || String(error)}` };
  }
}

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

/** Find a working Java runtime for repository-owned Android builds, including common unlinked
 * Homebrew and Android Studio installations on macOS. APK/device testing itself does not need it. */
export function resolveJavaRuntime(env = process.env, { probe = spawnSync, minimumMajor = 17 } = {}) {
  const executable = process.platform === "win32" ? "java.exe" : "java";
  const homes = [
    env.JAVA_HOME,
    process.platform === "darwin" ? "/Applications/Android Studio.app/Contents/jbr/Contents/Home" : "",
    process.platform === "darwin" ? "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home" : "",
    process.platform === "darwin" ? "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home" : "",
    process.platform === "darwin" ? "/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home" : "",
    process.platform === "darwin" ? "/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home" : "",
  ].filter(Boolean);
  const candidates = [
    ...homes.map((home) => ({ javaHome:home, javaPath:path.join(home, "bin", executable) })),
    ...String(env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => ({ javaHome:"", javaPath:path.join(dir, executable) })),
  ];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.javaPath) || !fs.existsSync(candidate.javaPath)) continue;
    seen.add(candidate.javaPath);
    const checked = probe(candidate.javaPath, ["-version"], { encoding:"utf8" });
    if ((checked.status ?? 1) !== 0) continue;
    const version = String(checked.stderr || checked.stdout || "").split(/\r?\n/)[0].trim();
    const matched = version.match(/version\s+"(\d+)(?:\.(\d+))?/i);
    const major = matched ? Number(matched[1] === "1" ? matched[2] : matched[1]) : 0;
    if (!major || major < minimumMajor) continue;
    let javaPath = candidate.javaPath;
    try { javaPath = fs.realpathSync(javaPath); } catch { /* preserve the discovered path */ }
    const javaHome = candidate.javaHome || path.dirname(path.dirname(javaPath));
    return { javaPath, javaHome, version, major };
  }
  return null;
}

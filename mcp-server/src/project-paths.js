import fs from "node:fs";
import path from "node:path";

export const TAPP_DIRECTORY = ".tapp";
export const LEGACY_TAPP_DIRECTORY = ".autotap";
export const TAPP_CONFIG = ".tapp.yml";
export const LEGACY_TAPP_CONFIG = ".autotap.yml";

export function projectArtifactDirectory(projectDir, requested = TAPP_DIRECTORY) {
  const root = path.resolve(projectDir);
  if (requested !== TAPP_DIRECTORY) return requested;
  const canonical = path.join(root, TAPP_DIRECTORY);
  const legacy = path.join(root, LEGACY_TAPP_DIRECTORY);
  if (!fs.existsSync(canonical) && fs.existsSync(legacy)) return LEGACY_TAPP_DIRECTORY;
  return TAPP_DIRECTORY;
}

export function projectArtifactPath(projectDir, ...parts) {
  return path.join(path.resolve(projectDir), projectArtifactDirectory(projectDir), ...parts);
}

export function existingProjectArtifactPath(projectDir, ...parts) {
  const root = path.resolve(projectDir);
  const canonical = path.join(root, TAPP_DIRECTORY, ...parts);
  if (fs.existsSync(canonical)) return canonical;
  const legacy = path.join(root, LEGACY_TAPP_DIRECTORY, ...parts);
  return fs.existsSync(legacy) ? legacy : canonical;
}

export function isProjectArtifactDirectory(name) {
  return name === TAPP_DIRECTORY || name === LEGACY_TAPP_DIRECTORY;
}

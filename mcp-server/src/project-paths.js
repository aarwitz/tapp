import path from "node:path";

export const TAPP_DIRECTORY = ".tapp";
export const TAPP_CONFIG = ".tapp.yml";

export function projectArtifactDirectory(_projectDir, requested = TAPP_DIRECTORY) {
  return requested;
}

export function projectArtifactPath(projectDir, ...parts) {
  return path.join(path.resolve(projectDir), TAPP_DIRECTORY, ...parts);
}

export function existingProjectArtifactPath(projectDir, ...parts) {
  return path.join(path.resolve(projectDir), TAPP_DIRECTORY, ...parts);
}

export function isProjectArtifactDirectory(name) {
  return name === TAPP_DIRECTORY;
}

// Repository-source boundary for Tapp's customer browser. The browser may name a
// GitHub repository or upload repository files, but it never chooses a server
// filesystem path. Every imported repository receives an isolated workspace.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

function boundedLimit(name, fallback, minimum) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= minimum && value <= fallback ? value : fallback;
}

const MAX_FILES = boundedLimit("TAPP_MAX_UPLOAD_FILES", 25_000, 1);
const MAX_FILE_BYTES = boundedLimit("TAPP_MAX_UPLOAD_FILE_BYTES", 32 * 1024 * 1024, 1024);
const MAX_REPOSITORY_BYTES = boundedLimit("TAPP_MAX_UPLOAD_REPOSITORY_BYTES", 768 * 1024 * 1024, 1024);
const fileLimitLabel = `${Math.ceil(MAX_FILE_BYTES / (1024 * 1024))} MiB`;
const repositoryLimitLabel = `${Math.ceil(MAX_REPOSITORY_BYTES / (1024 * 1024))} MiB`;
const BLOCKED_SEGMENTS = new Set([".git", ".gradle", ".next", ".DS_Store", "Carthage", "DerivedData", "Pods", "build", "dist", "node_modules", "vendor"]);

function safeName(value, fallback = "repository") {
  const result = String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return result || fallback;
}

function publicRepository(record) {
  if (!record) return null;
  return {
    id: record.id,
    name: record.name,
    source: record.source,
    writable: record.writable,
    ephemeral: record.ephemeral,
    status: record.status,
    fileCount: record.fileCount || 0,
    byteCount: record.byteCount || 0,
    connectedAt: record.connectedAt || null,
    root: record.root,
  };
}

function safeRelativeFile(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) throw new Error("Repository file path is required");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Repository file path contains an unsafe segment");
  if (parts.some((part) => BLOCKED_SEGMENTS.has(part))) throw new Error(`Repository upload excludes generated or dependency directory '${parts.find((part) => BLOCKED_SEGMENTS.has(part))}'`);
  return parts.join("/");
}

function runFile(command, args, { cwd, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message || "command failed").trim().slice(-2000);
        reject(new Error(detail));
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

export function createLocalGithubProvider({ run = runFile } = {}) {
  return {
    async list() {
      try {
        await run("gh", ["auth", "status"], { timeout: 30_000 });
        // /user/repos covers owned, collaborator, and organization-member
        // repositories. `gh repo list` without an owner silently omits important
        // organization choices, which is exactly the ambiguity this picker must
        // remove. gh's built-in --jq emits one bounded JSON object per line.
        const result = await run("gh", [
          "api", "--paginate", "user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=updated",
          "--jq", ".[] | {nameWithOwner:.full_name,name:.name,url:.html_url,defaultBranch:.default_branch,private:.private,permissions:.permissions}",
        ], { timeout: 90_000 });
        const repositories = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
        return repositories.map((repository) => ({
          nameWithOwner: repository.nameWithOwner,
          name: repository.name,
          url: repository.url,
          defaultBranch: repository.defaultBranch || "",
          private: repository.private === true,
          permission: repository.permissions?.admin ? "ADMIN" : repository.permissions?.maintain ? "MAINTAIN" : repository.permissions?.push ? "WRITE" : "READ",
        })).sort((left, right) => left.nameWithOwner.localeCompare(right.nameWithOwner));
      } catch (error) {
        const wrapped = new Error(`GitHub connection needs an authenticated GitHub CLI session. Run 'gh auth login' locally, then retry. ${error.message || error}`);
        wrapped.code = "github-auth-required";
        throw wrapped;
      }
    },
    async clone(nameWithOwner, destination) {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(nameWithOwner || ""))) throw new Error("Select a repository returned by GitHub");
      await run("gh", ["repo", "clone", nameWithOwner, destination, "--", "--depth=1"], { timeout: 10 * 60_000 });
      return destination;
    },
  };
}

export class BrowserWorkspaceRegistry {
  constructor({ initialProjectDir, workspaceRoot, githubProvider = createLocalGithubProvider() } = {}) {
    this.ownsRoot = !workspaceRoot;
    this.workspaceRoot = workspaceRoot
      ? fs.realpathSync(path.resolve(workspaceRoot))
      : fs.mkdtempSync(path.join(os.tmpdir(), "tapp-browser-workspaces-"));
    this.githubProvider = githubProvider;
    this.repositories = new Map();
    this.uploads = new Map();
    this.currentId = null;
    if (initialProjectDir) this.addExisting(initialProjectDir);
  }

  addExisting(projectDir) {
    const root = fs.realpathSync(path.resolve(projectDir));
    if (!fs.statSync(root).isDirectory()) throw new Error(`Repository directory not found: ${root}`);
    const id = `repo_${crypto.randomBytes(8).toString("hex")}`;
    const record = {
      id, root, name: path.basename(root), status: "ready", writable: true, ephemeral: false,
      source: { kind: "local-checkout", label: root }, connectedAt: new Date().toISOString(),
    };
    this.repositories.set(id, record);
    this.currentId = id;
    return publicRepository(record);
  }

  list() { return [...this.repositories.values()].map(publicRepository); }
  current() { return publicRepository(this.repositories.get(this.currentId)); }
  currentRoot() { return this.repositories.get(this.currentId)?.root || null; }

  select(id) {
    const record = this.repositories.get(String(id || ""));
    if (!record || record.status !== "ready") throw new Error("Repository workspace not found");
    this.currentId = record.id;
    return publicRepository(record);
  }

  createUpload({ name = "repository", expectedFiles = 0, expectedBytes = 0 } = {}) {
    if (Number(expectedFiles) > MAX_FILES) throw new Error(`Repository contains more than ${MAX_FILES.toLocaleString()} uploadable files`);
    if (Number(expectedBytes) > MAX_REPOSITORY_BYTES) throw new Error(`Repository upload exceeds the ${repositoryLimitLabel} workspace limit`);
    const id = `upload_${crypto.randomBytes(10).toString("hex")}`;
    const root = path.join(this.workspaceRoot, id, "repository");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const record = { id, root, name: safeName(name), status: "uploading", fileCount: 0, byteCount: 0, expectedFiles: Number(expectedFiles) || 0, expectedBytes: Number(expectedBytes) || 0 };
    this.uploads.set(id, record);
    return { id, limits: { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxRepositoryBytes: MAX_REPOSITORY_BYTES } };
  }

  async writeUploadFile(id, relativePath, stream, declaredLength = 0) {
    const upload = this.uploads.get(String(id || ""));
    if (!upload || upload.status !== "uploading") throw new Error("Repository upload is not active");
    const relative = safeRelativeFile(relativePath);
    const length = Number(declaredLength) || 0;
    if (length > MAX_FILE_BYTES) throw new Error(`File '${relative}' exceeds the ${fileLimitLabel} upload limit`);
    if (upload.fileCount + 1 > MAX_FILES) throw new Error(`Repository contains more than ${MAX_FILES.toLocaleString()} files`);
    if (upload.byteCount + length > MAX_REPOSITORY_BYTES) throw new Error(`Repository upload exceeds the ${repositoryLimitLabel} workspace limit`);
    const destination = path.resolve(upload.root, relative);
    if (!destination.startsWith(path.resolve(upload.root) + path.sep)) throw new Error("Repository file escapes its isolated workspace");
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.tapp-upload-${crypto.randomBytes(4).toString("hex")}`;
    let received = 0;
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 });
      const fail = (error) => { stream.destroy(); output.destroy(); fs.rmSync(temporary, { force: true }); reject(error); };
      stream.on("data", (chunk) => {
        received += chunk.length;
        if (received > MAX_FILE_BYTES || upload.byteCount + received > MAX_REPOSITORY_BYTES) fail(new Error(`File '${relative}' exceeds the upload limit`));
      });
      stream.on("error", fail);
      output.on("error", fail);
      output.on("finish", resolve);
      stream.pipe(output);
    });
    fs.renameSync(temporary, destination);
    upload.fileCount += 1;
    upload.byteCount += received;
    return { relativePath: relative, bytes: received, fileCount: upload.fileCount, byteCount: upload.byteCount };
  }

  finishUpload(id) {
    const upload = this.uploads.get(String(id || ""));
    if (!upload || upload.status !== "uploading") throw new Error("Repository upload is not active");
    if (!upload.fileCount) throw new Error("The selected folder contained no uploadable repository files");
    upload.status = "ready";
    upload.source = { kind: "local-folder-upload", label: upload.name, note: "isolated working copy; export or apply the reviewed patch to update the original folder" };
    upload.writable = true;
    upload.ephemeral = true;
    upload.connectedAt = new Date().toISOString();
    this.uploads.delete(upload.id);
    this.repositories.set(upload.id, upload);
    this.currentId = upload.id;
    return publicRepository(upload);
  }

  abortUpload(id) {
    const upload = this.uploads.get(String(id || ""));
    if (!upload) return false;
    this.uploads.delete(upload.id);
    fs.rmSync(path.dirname(upload.root), { recursive: true, force: true });
    return true;
  }

  async listGithub() { return this.githubProvider.list(); }

  async cloneGithub(nameWithOwner, onProgress = () => {}) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(nameWithOwner || ""))) throw new Error("Select a valid owner/repository");
    const id = `github_${crypto.randomBytes(10).toString("hex")}`;
    const destination = path.join(this.workspaceRoot, id, "repository");
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    onProgress({ phase: "repository", text: `Cloning ${nameWithOwner} into an isolated workspace` });
    try {
      await this.githubProvider.clone(nameWithOwner, destination);
      const root = fs.realpathSync(destination);
      const record = {
        id, root, name: nameWithOwner.split("/").at(-1), status: "ready", writable: true, ephemeral: true,
        source: { kind: "github", nameWithOwner, label: nameWithOwner, note: "isolated checkout; Tapp never pushes without explicit authorization" },
        connectedAt: new Date().toISOString(),
      };
      this.repositories.set(id, record);
      this.currentId = id;
      onProgress({ phase: "repository", text: `Connected ${nameWithOwner}` });
      return publicRepository(record);
    } catch (error) {
      fs.rmSync(path.dirname(destination), { recursive: true, force: true });
      throw error;
    }
  }

  close() {
    if (this.ownsRoot) fs.rmSync(this.workspaceRoot, { recursive: true, force: true });
  }
}

export const browserWorkspaceLimits = Object.freeze({ MAX_FILES, MAX_FILE_BYTES, MAX_REPOSITORY_BYTES });

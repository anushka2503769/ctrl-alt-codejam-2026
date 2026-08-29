import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readlink,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import type { RunVaultFileChange } from "./types.js";

const RESERVED_DIRECTORY_NAMES = new Set([".codex", ".staging"]);
const BINARY_EXTENSIONS = new Set([
  ".class",
  ".dll",
  ".dylib",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".pyc",
  ".so",
  ".tar",
  ".wasm",
  ".webp",
  ".zip",
]);
const DEPENDENCY_FILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "composer.json",
  "composer.lock",
  "deno.json",
  "deno.jsonc",
  "deno.lock",
  "gemfile",
  "gemfile.lock",
  "go.mod",
  "go.sum",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "yarn.lock",
]);

type WorkspaceEntryType = "directory" | "file" | "symbolic-link";

export interface WorkspaceEntrySnapshot {
  path: string;
  type: WorkspaceEntryType;
  digest: string;
  mode: number;
  binary: boolean;
}

export interface WorkspaceSnapshot {
  fingerprint: string;
  entries: WorkspaceEntrySnapshot[];
}

export interface StagingWorkspace {
  id: string;
  path: string;
  trustedSnapshot: WorkspaceSnapshot;
}

export interface RunVaultWorkspaceInspection {
  changes: RunVaultFileChange[];
  stagingFingerprint: string;
}

export class UnsafeWorkspaceEntryError extends Error {}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..");
}

function validateWorkspaceId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error("Invalid staging workspace ID");
  }
}

function toRelativePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function shouldExclude(relativePath: string): boolean {
  return relativePath
    .split("/")
    .some((segment) => RESERVED_DIRECTORY_NAMES.has(segment));
}

export function isProtectedRunVaultPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  return (
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized === "AGENTS.md" ||
    normalized === ".github/workflows" ||
    normalized.startsWith(".github/workflows/") ||
    normalized === "infra" ||
    normalized.startsWith("infra/") ||
    normalized === "deploy" ||
    normalized.startsWith("deploy/")
  );
}

export function isDependencyFile(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized).toLowerCase();
  return (
    DEPENDENCY_FILE_NAMES.has(basename) ||
    /^requirements(?:[._-].+)?\.txt$/.test(basename)
  );
}

function isKnownBinaryPath(relativePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase());
}

async function hashFile(
  filePath: string,
  relativePath: string,
): Promise<{ digest: string; binary: boolean }> {
  const hash = createHash("sha256");
  const sampleChunks: Buffer[] = [];
  let sampleBytes = 0;

  for await (const rawChunk of createReadStream(filePath)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    hash.update(chunk);
    if (sampleBytes < 8_192) {
      const sample = chunk.subarray(0, 8_192 - sampleBytes);
      sampleChunks.push(sample);
      sampleBytes += sample.length;
    }
  }

  const sample = Buffer.concat(sampleChunks);
  let invalidUtf8 = false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } catch {
    invalidUtf8 = true;
  }

  return {
    digest: hash.digest("hex"),
    binary:
      isKnownBinaryPath(relativePath) || sample.includes(0) || invalidUtf8,
  };
}

async function collectEntries(
  root: string,
  current: string,
  entries: WorkspaceEntrySnapshot[],
): Promise<void> {
  const children = await readdir(current, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));

  for (const child of children) {
    const absolutePath = path.join(current, child.name);
    const relativePath = toRelativePath(root, absolutePath);
    if (shouldExclude(relativePath)) continue;

    const stats = await lstat(absolutePath);
    if (stats.isDirectory()) {
      entries.push({
        path: relativePath,
        type: "directory",
        digest: "",
        mode: stats.mode & 0o777,
        binary: false,
      });
      await collectEntries(root, absolutePath, entries);
      continue;
    }
    if (stats.isFile()) {
      const { digest, binary } = await hashFile(absolutePath, relativePath);
      entries.push({
        path: relativePath,
        type: "file",
        digest,
        mode: stats.mode & 0o777,
        binary,
      });
      continue;
    }
    if (stats.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      entries.push({
        path: relativePath,
        type: "symbolic-link",
        digest: createHash("sha256").update(target).digest("hex"),
        mode: stats.mode & 0o777,
        binary: false,
      });
      continue;
    }

    throw new UnsafeWorkspaceEntryError(
      `Unsupported workspace entry type at ${relativePath}`,
    );
  }
}

function fingerprintEntries(entries: WorkspaceEntrySnapshot[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.type);
    hash.update("\0");
    hash.update(entry.digest);
    hash.update("\0");
    hash.update(String(entry.mode));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function copyWorkspaceEntry(
  trustedRoot: string,
  stagingRoot: string,
  sourcePath: string,
): Promise<void> {
  const children = await readdir(sourcePath, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));

  for (const child of children) {
    const source = path.join(sourcePath, child.name);
    const relativePath = toRelativePath(trustedRoot, source);
    if (shouldExclude(relativePath)) continue;
    const destination = path.join(stagingRoot, ...relativePath.split("/"));
    const stats = await lstat(source);

    if (stats.isDirectory()) {
      await mkdir(destination, { mode: stats.mode & 0o777 });
      await copyWorkspaceEntry(trustedRoot, stagingRoot, source);
      continue;
    }
    if (stats.isFile()) {
      await copyFile(source, destination);
      await chmod(destination, stats.mode & 0o777);
      continue;
    }
    if (stats.isSymbolicLink()) {
      const target = await readlink(source);
      if (path.isAbsolute(target)) {
        throw new UnsafeWorkspaceEntryError(
          `Absolute symbolic link is not allowed at ${relativePath}`,
        );
      }
      const resolvedTarget = path.resolve(path.dirname(source), target);
      if (!isInside(trustedRoot, resolvedTarget)) {
        throw new UnsafeWorkspaceEntryError(
          `Symbolic link escapes the workspace at ${relativePath}`,
        );
      }
      await symlink(target, destination);
      continue;
    }

    throw new UnsafeWorkspaceEntryError(
      `Unsupported workspace entry type at ${relativePath}`,
    );
  }
}

function entriesEqual(
  left: WorkspaceEntrySnapshot,
  right: WorkspaceEntrySnapshot,
): boolean {
  return (
    left.type === right.type &&
    left.digest === right.digest &&
    left.mode === right.mode
  );
}

export class RunVaultWorkspaceManager {
  private readonly stagingRoot: string;

  constructor(private readonly workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.stagingRoot = path.join(this.workspaceRoot, ".staging");
  }

  async initialize(): Promise<void> {
    await mkdir(this.stagingRoot, { recursive: true });
  }

  stagingPath(id: string): string {
    validateWorkspaceId(id);
    return path.join(this.stagingRoot, id);
  }

  async snapshotWorkspace(workspacePath: string): Promise<WorkspaceSnapshot> {
    const resolvedPath = path.resolve(workspacePath);
    if (!isInside(this.workspaceRoot, resolvedPath) || resolvedPath === this.workspaceRoot) {
      throw new Error("Workspace path is outside the managed workspace root");
    }
    const entries: WorkspaceEntrySnapshot[] = [];
    await collectEntries(resolvedPath, resolvedPath, entries);
    return { entries, fingerprint: fingerprintEntries(entries) };
  }

  async createStagingWorkspace(
    id: string,
    trustedWorkspacePath: string,
  ): Promise<StagingWorkspace> {
    const stagingPath = this.stagingPath(id);
    const trustedPath = path.resolve(trustedWorkspacePath);
    if (
      !isInside(this.workspaceRoot, trustedPath) ||
      trustedPath === this.workspaceRoot ||
      isInside(this.stagingRoot, trustedPath)
    ) {
      throw new Error("Trusted workspace path is outside the managed workspace root");
    }

    const trustedSnapshot = await this.snapshotWorkspace(trustedPath);
    await mkdir(stagingPath, { recursive: false });
    try {
      await copyWorkspaceEntry(trustedPath, stagingPath, trustedPath);
      const afterCopy = await this.snapshotWorkspace(trustedPath);
      if (afterCopy.fingerprint !== trustedSnapshot.fingerprint) {
        throw new Error("Trusted workspace changed while staging was created");
      }
      return { id, path: stagingPath, trustedSnapshot };
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true });
      throw error;
    }
  }

  async inspectChanges(
    baseline: WorkspaceSnapshot,
    stagingWorkspacePath: string,
  ): Promise<RunVaultWorkspaceInspection> {
    const stagingPath = path.resolve(stagingWorkspacePath);
    if (!isInside(this.stagingRoot, stagingPath) || stagingPath === this.stagingRoot) {
      throw new Error("Staging workspace path is outside the staging root");
    }

    const stagingSnapshot = await this.snapshotWorkspace(stagingPath);
    const baselineByPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));
    const stagingByPath = new Map(
      stagingSnapshot.entries.map((entry) => [entry.path, entry]),
    );
    const paths = [...new Set([...baselineByPath.keys(), ...stagingByPath.keys()])].sort();
    const changes: RunVaultFileChange[] = [];

    for (const relativePath of paths) {
      const before = baselineByPath.get(relativePath);
      const after = stagingByPath.get(relativePath);
      if (before?.type === "directory" && after?.type === "directory") continue;
      if (before && after && entriesEqual(before, after)) continue;
      if (!before && after?.type === "directory") continue;
      if (before?.type === "directory" && !after) continue;

      const kind = !before ? "added" : !after ? "deleted" : "modified";
      const becameExecutable =
        after?.type === "file" &&
        (after.mode & 0o111) !== 0 &&
        (before?.type !== "file" || (before.mode & 0o111) === 0);
      const becameBinary =
        after?.type === "file" &&
        after.binary &&
        (before?.type !== "file" || !before.binary);
      const introducedSymbolicLink =
        after?.type === "symbolic-link" &&
        (before?.type !== "symbolic-link" || before.digest !== after.digest);

      changes.push({
        path: relativePath,
        kind,
        protected: isProtectedRunVaultPath(relativePath),
        dependencyFile: isDependencyFile(relativePath),
        executable: becameExecutable,
        binary: becameBinary,
        symbolicLink: introducedSymbolicLink,
      });
    }

    return { changes, stagingFingerprint: stagingSnapshot.fingerprint };
  }

  async discardStagingWorkspace(id: string): Promise<void> {
    await rm(this.stagingPath(id), { recursive: true, force: true });
  }
}

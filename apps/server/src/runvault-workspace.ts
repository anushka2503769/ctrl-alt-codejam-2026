import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  MAX_REVIEW_FILE_BYTES,
  MAX_REVIEW_FILE_LINES,
  validateReviewPath,
} from "./runvault-review.js";
import type { Database, RunVaultFileChange } from "./types.js";

const PLATFORM_RESERVED_DIRECTORY_NAMES = new Set([".codex", ".staging"]);
const GIT_METADATA_NAME = ".git";
const DEPENDENCY_METADATA_NAME = "node_modules";
const MAX_GIT_METADATA_PATHS = 1_024;
const MAX_DEPENDENCY_METADATA_PATHS = 1_024;
const MAX_GIT_METADATA_PATH_BYTES = 4_096;
const MAX_DEPENDENCY_METADATA_PATH_BYTES = 4_096;
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
  size: number;
}

export interface WorkspaceSnapshot {
  fingerprint: string;
  entries: WorkspaceEntrySnapshot[];
  entryCount: number;
  estimatedBytes: number;
  gitMetadataPaths: string[];
  dependencyMetadataPaths: string[];
}

export interface StagingWorkspaceMetrics {
  durationMs: number;
  copiedEntryCount: number;
  estimatedCopiedBytes: number;
}

export interface StagingWorkspace {
  id: string;
  path: string;
  trustedSnapshot: WorkspaceSnapshot;
  metrics: StagingWorkspaceMetrics;
}

export interface RunVaultWorkspaceInspection {
  changes: RunVaultFileChange[];
  stagingFingerprint: string;
}

export interface RunVaultPromotion {
  id: string;
  agentId: string;
  trustedWorkspacePath: string;
  stagingWorkspacePath: string;
  backupWorkspacePath: string;
  markerPath: string;
  gitMetadataPaths: string[];
  dependencyMetadataPaths: string[];
  markerVersion: 1 | 2 | 3;
}

export type ReviewFileResult =
  | { status: "available"; text: string }
  | { status: "missing" | "binary" | "symbolic_link" | "too_large" };

type PromotionPhase =
  | "prepared"
  | "installed"
  | "metadata_installed"
  | "committed";

interface PromotionMarkerV1 {
  version: 1;
  runId: string;
  agentId: string;
  phase: "prepared" | "installed" | "committed";
}

interface PromotionMarkerV2 {
  version: 2;
  runId: string;
  agentId: string;
  phase: PromotionPhase;
  gitMetadataPaths: string[];
}

interface PromotionMarkerV3 {
  version: 3;
  runId: string;
  agentId: string;
  phase: PromotionPhase;
  gitMetadataPaths: string[];
  dependencyMetadataPaths: string[];
}

type PromotionMarker = PromotionMarkerV1 | PromotionMarkerV2 | PromotionMarkerV3;

export class UnsafeWorkspaceEntryError extends Error {}
export class TrustedWorkspaceChangedError extends Error {}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..");
}

function validateWorkspaceId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error("Invalid staging workspace ID");
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isPromotionMarker(value: unknown): value is PromotionMarker {
  if (!value || typeof value !== "object") return false;
  const marker = value as Partial<PromotionMarker>;
  if (typeof marker.runId !== "string" || typeof marker.agentId !== "string") {
    return false;
  }
  if (marker.version === 1) {
    return (
      marker.phase === "prepared" ||
      marker.phase === "installed" ||
      marker.phase === "committed"
    );
  }
  if (
    (marker.version !== 2 && marker.version !== 3) ||
    !Array.isArray(marker.gitMetadataPaths)
  ) {
    return false;
  }
  const gitMetadataValid =
    (marker.phase === "prepared" ||
      marker.phase === "installed" ||
      marker.phase === "metadata_installed" ||
      marker.phase === "committed") &&
    marker.gitMetadataPaths.length <= MAX_GIT_METADATA_PATHS &&
    marker.gitMetadataPaths.every(
      (candidate) =>
        typeof candidate === "string" && isValidGitMetadataPath(candidate),
    ) &&
    new Set(marker.gitMetadataPaths).size === marker.gitMetadataPaths.length;
  if (!gitMetadataValid || marker.version === 2) return gitMetadataValid;
  const dependencyMetadataPaths = (marker as Partial<PromotionMarkerV3>)
    .dependencyMetadataPaths;
  return (
    Array.isArray(dependencyMetadataPaths) &&
    dependencyMetadataPaths.length <= MAX_DEPENDENCY_METADATA_PATHS &&
    dependencyMetadataPaths.every(
      (candidate: unknown) =>
        typeof candidate === "string" &&
        isValidDependencyMetadataPath(candidate),
    ) &&
    new Set(dependencyMetadataPaths).size === dependencyMetadataPaths.length
  );
}

function toRelativePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function pathSegments(relativePath: string): string[] {
  return relativePath.replaceAll("\\", "/").split("/");
}

function isGitMetadataName(name: string): boolean {
  return name.toLowerCase() === GIT_METADATA_NAME;
}

function isGitMetadataPath(relativePath: string): boolean {
  return pathSegments(relativePath).some(isGitMetadataName);
}

function isDependencyMetadataName(name: string): boolean {
  return name.toLowerCase() === DEPENDENCY_METADATA_NAME;
}

function isDependencyMetadataPath(relativePath: string): boolean {
  return pathSegments(relativePath).some(isDependencyMetadataName);
}

function isValidGitMetadataPath(relativePath: string): boolean {
  try {
    return (
      validateReviewPath(relativePath) === relativePath &&
      Buffer.byteLength(relativePath) <= MAX_GIT_METADATA_PATH_BYTES &&
      isGitMetadataName(path.posix.basename(relativePath))
    );
  } catch {
    return false;
  }
}

function isValidDependencyMetadataPath(relativePath: string): boolean {
  try {
    return (
      validateReviewPath(relativePath) === relativePath &&
      Buffer.byteLength(relativePath) <= MAX_DEPENDENCY_METADATA_PATH_BYTES &&
      isDependencyMetadataName(path.posix.basename(relativePath))
    );
  } catch {
    return false;
  }
}

function shouldExcludeFromCopy(
  relativePath: string,
  excludeGitMetadata: boolean,
): boolean {
  const segments = pathSegments(relativePath);
  return (
    segments.some((segment) => PLATFORM_RESERVED_DIRECTORY_NAMES.has(segment)) ||
    segments.some(isDependencyMetadataName) ||
    (excludeGitMetadata && segments.some(isGitMetadataName))
  );
}

export function isProtectedRunVaultPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  return (
    isGitMetadataPath(normalized) ||
    isDependencyMetadataPath(normalized) ||
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized === ".codex" ||
    normalized.startsWith(".codex/") ||
    normalized === ".staging" ||
    normalized.startsWith(".staging/") ||
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
    isDependencyMetadataPath(normalized) ||
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
  options: {
    excludePlatformMetadata: boolean;
    excludeGitMetadata: boolean;
    collapseGitMetadata: boolean;
    excludeDependencyMetadata: boolean;
    collapseDependencyMetadata: boolean;
  },
): Promise<void> {
  const children = await readdir(current, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));

  for (const child of children) {
    const absolutePath = path.join(current, child.name);
    const relativePath = toRelativePath(root, absolutePath);
    const segments = pathSegments(relativePath);
    if (
      options.excludePlatformMetadata &&
      segments.some((segment) => PLATFORM_RESERVED_DIRECTORY_NAMES.has(segment))
    ) {
      continue;
    }
    if (options.excludeGitMetadata && isGitMetadataPath(relativePath)) continue;
    if (
      options.excludeDependencyMetadata &&
      isDependencyMetadataPath(relativePath)
    ) {
      continue;
    }

    const stats = await lstat(absolutePath);
    if (isGitMetadataName(child.name) && options.collapseGitMetadata) {
      if (stats.isDirectory()) {
        entries.push({
          path: relativePath,
          type: "directory",
          digest: "git-metadata",
          mode: stats.mode & 0o777,
          binary: true,
          size: 0,
        });
        continue;
      }
      if (stats.isFile()) {
        entries.push({
          path: relativePath,
          type: "file",
          digest: `git-metadata:${stats.size}`,
          mode: stats.mode & 0o777,
          binary: true,
          size: stats.size,
        });
        continue;
      }
      if (stats.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        entries.push({
          path: relativePath,
          type: "symbolic-link",
          digest: `git-metadata-link:${Buffer.byteLength(target)}`,
          mode: stats.mode & 0o777,
          binary: true,
          size: Buffer.byteLength(target),
        });
        continue;
      }
    }
    if (
      isDependencyMetadataName(child.name) &&
      options.collapseDependencyMetadata
    ) {
      entries.push({
        path: relativePath,
        type: stats.isDirectory()
          ? "directory"
          : stats.isFile()
            ? "file"
            : "symbolic-link",
        digest: `dependency-metadata:${stats.isFile() ? stats.size : 0}`,
        mode: stats.mode & 0o777,
        binary: true,
        size: stats.isFile() ? stats.size : 0,
      });
      continue;
    }
    if (stats.isDirectory()) {
      entries.push({
        path: relativePath,
        type: "directory",
        digest: "",
        mode: stats.mode & 0o777,
        binary: false,
        size: 0,
      });
      await collectEntries(root, absolutePath, entries, options);
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
        size: stats.size,
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
        size: Buffer.byteLength(target),
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
  sourceRoot: string,
  stagingRoot: string,
  sourcePath: string,
  excludeGitMetadata: boolean,
): Promise<{ entryCount: number; estimatedBytes: number }> {
  const children = await readdir(sourcePath, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  let entryCount = 0;
  let estimatedBytes = 0;

  for (const child of children) {
    const source = path.join(sourcePath, child.name);
    const relativePath = toRelativePath(sourceRoot, source);
    if (shouldExcludeFromCopy(relativePath, excludeGitMetadata)) continue;
    const destination = path.join(stagingRoot, ...relativePath.split("/"));
    const stats = await lstat(source);
    entryCount += 1;

    if (stats.isDirectory()) {
      await mkdir(destination, { mode: stats.mode & 0o777 });
      const nested = await copyWorkspaceEntry(
        sourceRoot,
        stagingRoot,
        source,
        excludeGitMetadata,
      );
      entryCount += nested.entryCount;
      estimatedBytes += nested.estimatedBytes;
      continue;
    }
    if (stats.isFile()) {
      await copyFile(source, destination);
      await chmod(destination, stats.mode & 0o777);
      estimatedBytes += stats.size;
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
      if (!isInside(sourceRoot, resolvedTarget)) {
        throw new UnsafeWorkspaceEntryError(
          `Symbolic link escapes the workspace at ${relativePath}`,
        );
      }
      await symlink(target, destination);
      estimatedBytes += Buffer.byteLength(target);
      continue;
    }

    throw new UnsafeWorkspaceEntryError(
      `Unsupported workspace entry type at ${relativePath}`,
    );
  }
  return { entryCount, estimatedBytes };
}

async function collectGitMetadataPaths(
  root: string,
  current: string = root,
  results: string[] = [],
): Promise<string[]> {
  const children = await readdir(current, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));

  for (const child of children) {
    const candidate = path.join(current, child.name);
    const relativePath = toRelativePath(root, candidate);
    if (
      pathSegments(relativePath).some((segment) =>
        PLATFORM_RESERVED_DIRECTORY_NAMES.has(segment),
      ) || isDependencyMetadataPath(relativePath)
    ) {
      continue;
    }
    const stats = await lstat(candidate);
    if (isGitMetadataName(child.name)) {
      if (!stats.isDirectory() && !stats.isFile()) {
        throw new UnsafeWorkspaceEntryError(
          `Git metadata must be a file or directory at ${relativePath}`,
        );
      }
      results.push(relativePath);
      if (results.length > MAX_GIT_METADATA_PATHS) {
        throw new UnsafeWorkspaceEntryError(
          `Workspace contains more than ${MAX_GIT_METADATA_PATHS} Git metadata paths`,
        );
      }
      continue;
    }
    if (stats.isDirectory()) {
      await collectGitMetadataPaths(root, candidate, results);
    }
  }
  return results;
}

async function collectDependencyMetadataPaths(
  root: string,
  current: string = root,
  results: string[] = [],
): Promise<string[]> {
  const children = await readdir(current, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));

  for (const child of children) {
    const candidate = path.join(current, child.name);
    const relativePath = toRelativePath(root, candidate);
    if (
      pathSegments(relativePath).some((segment) =>
        PLATFORM_RESERVED_DIRECTORY_NAMES.has(segment),
      ) || isGitMetadataPath(relativePath)
    ) {
      continue;
    }
    const stats = await lstat(candidate);
    if (isDependencyMetadataName(child.name)) {
      if (!stats.isDirectory()) {
        throw new UnsafeWorkspaceEntryError(
          `Dependency metadata must be a directory at ${relativePath}`,
        );
      }
      results.push(relativePath);
      if (results.length > MAX_DEPENDENCY_METADATA_PATHS) {
        throw new UnsafeWorkspaceEntryError(
          `Workspace contains more than ${MAX_DEPENDENCY_METADATA_PATHS} dependency metadata paths`,
        );
      }
      continue;
    }
    if (stats.isDirectory()) {
      await collectDependencyMetadataPaths(root, candidate, results);
    }
  }
  return results;
}

async function moveGitMetadataPaths(
  sourceRoot: string,
  destinationRoot: string,
  relativePaths: string[],
): Promise<void> {
  for (const relativePath of relativePaths) {
    if (!isValidGitMetadataPath(relativePath)) {
      throw new Error("Invalid Git metadata path in promotion");
    }
    const source = path.join(sourceRoot, ...relativePath.split("/"));
    const destination = path.join(destinationRoot, ...relativePath.split("/"));
    const sourceExists = await pathExists(source);
    const destinationExists = await pathExists(destination);
    if (sourceExists && destinationExists) {
      throw new Error(`RunVault found conflicting Git metadata at ${relativePath}`);
    }
    if (!sourceExists) {
      if (destinationExists) continue;
      throw new Error(`RunVault cannot recover Git metadata at ${relativePath}`);
    }
    const destinationParent = path.dirname(destination);
    let parentStats;
    try {
      parentStats = await lstat(destinationParent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new UnsafeWorkspaceEntryError(
          `Cannot preserve nested Git metadata because its parent was removed: ${relativePath}`,
        );
      }
      throw error;
    }
    if (!parentStats.isDirectory()) {
      throw new UnsafeWorkspaceEntryError(
        `Cannot preserve Git metadata under a non-directory path: ${relativePath}`,
      );
    }
    await rename(source, destination);
  }
}

async function assertGitMetadataInventory(
  promotion: RunVaultPromotion,
): Promise<void> {
  const discovered = new Set<string>();
  for (const root of [
    promotion.backupWorkspacePath,
    promotion.trustedWorkspacePath,
  ]) {
    if (!(await pathExists(root))) continue;
    for (const relativePath of await collectGitMetadataPaths(root)) {
      if (discovered.has(relativePath)) {
        throw new Error(
          `RunVault found duplicate Git metadata during promotion: ${relativePath}`,
        );
      }
      discovered.add(relativePath);
    }
  }
  const expected = [...promotion.gitMetadataPaths].sort();
  const actual = [...discovered].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new Error("Trusted Git metadata changed during promotion");
  }
}

async function moveDependencyMetadataPaths(
  sourceRoot: string,
  destinationRoot: string,
  relativePaths: string[],
): Promise<void> {
  for (const relativePath of relativePaths) {
    if (!isValidDependencyMetadataPath(relativePath)) {
      throw new Error("Invalid dependency metadata path in promotion");
    }
    const source = path.join(sourceRoot, ...relativePath.split("/"));
    const destination = path.join(destinationRoot, ...relativePath.split("/"));
    const sourceExists = await pathExists(source);
    const destinationExists = await pathExists(destination);
    if (sourceExists && destinationExists) {
      throw new Error(
        `RunVault found conflicting dependency metadata at ${relativePath}`,
      );
    }
    if (!sourceExists) {
      if (destinationExists) continue;
      throw new Error(
        `RunVault cannot recover dependency metadata at ${relativePath}`,
      );
    }
    const destinationParent = path.dirname(destination);
    let parentStats;
    try {
      parentStats = await lstat(destinationParent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new UnsafeWorkspaceEntryError(
          `Cannot preserve nested dependency metadata because its parent was removed: ${relativePath}`,
        );
      }
      throw error;
    }
    if (!parentStats.isDirectory()) {
      throw new UnsafeWorkspaceEntryError(
        `Cannot preserve dependency metadata under a non-directory path: ${relativePath}`,
      );
    }
    await rename(source, destination);
  }
}

async function assertDependencyMetadataInventory(
  promotion: RunVaultPromotion,
): Promise<void> {
  const discovered = new Set<string>();
  for (const root of [
    promotion.backupWorkspacePath,
    promotion.trustedWorkspacePath,
  ]) {
    if (!(await pathExists(root))) continue;
    for (const relativePath of await collectDependencyMetadataPaths(root)) {
      if (discovered.has(relativePath)) {
        throw new Error(
          `RunVault found duplicate dependency metadata during promotion: ${relativePath}`,
        );
      }
      discovered.add(relativePath);
    }
  }
  const expected = [...promotion.dependencyMetadataPaths].sort();
  const actual = [...discovered].sort();
  if (
    actual.length !== expected.length ||
    actual.some((item, index) => item !== expected[index])
  ) {
    throw new Error("Trusted dependency metadata changed during promotion");
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

  promotionMarkerPath(id: string): string {
    validateWorkspaceId(id);
    return path.join(this.stagingRoot, `${id}.promotion.json`);
  }

  async snapshotWorkspace(workspacePath: string): Promise<WorkspaceSnapshot> {
    const resolvedPath = path.resolve(workspacePath);
    if (!isInside(this.workspaceRoot, resolvedPath) || resolvedPath === this.workspaceRoot) {
      throw new Error("Workspace path is outside the managed workspace root");
    }
    const entries: WorkspaceEntrySnapshot[] = [];
    const trustedWorkspace = !isInside(this.stagingRoot, resolvedPath);
    await collectEntries(
      resolvedPath,
      resolvedPath,
      entries,
      {
        excludePlatformMetadata: trustedWorkspace,
        excludeGitMetadata: trustedWorkspace,
        collapseGitMetadata: !trustedWorkspace,
        excludeDependencyMetadata: trustedWorkspace,
        collapseDependencyMetadata: !trustedWorkspace,
      },
    );
    const gitMetadataPaths = trustedWorkspace
      ? await collectGitMetadataPaths(resolvedPath)
      : entries
          .filter((entry) => isGitMetadataPath(entry.path))
          .map((entry) => entry.path);
    const dependencyMetadataPaths = trustedWorkspace
      ? await collectDependencyMetadataPaths(resolvedPath)
      : entries
          .filter((entry) => isDependencyMetadataPath(entry.path))
          .map((entry) => entry.path);
    return {
      entries,
      fingerprint: fingerprintEntries(entries),
      entryCount: entries.length,
      estimatedBytes: entries.reduce((total, entry) => total + entry.size, 0),
      gitMetadataPaths,
      dependencyMetadataPaths,
    };
  }

  async createStagingWorkspace(
    id: string,
    trustedWorkspacePath: string,
  ): Promise<StagingWorkspace> {
    const startedAt = performance.now();
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
      const copied = await copyWorkspaceEntry(
        trustedPath,
        stagingPath,
        trustedPath,
        true,
      );
      const afterCopy = await this.snapshotWorkspace(trustedPath);
      if (afterCopy.fingerprint !== trustedSnapshot.fingerprint) {
        throw new Error("Trusted workspace changed while staging was created");
      }
      return {
        id,
        path: stagingPath,
        trustedSnapshot,
        metrics: {
          durationMs: performance.now() - startedAt,
          copiedEntryCount: copied.entryCount,
          estimatedCopiedBytes: copied.estimatedBytes,
        },
      };
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true });
      throw error;
    }
  }

  async createRevisionStagingWorkspace(
    id: string,
    sourceId: string,
    trustedWorkspacePath: string,
    expectedSourceFingerprint: string,
    expectedTrustedFingerprint: string,
  ): Promise<StagingWorkspace> {
    const startedAt = performance.now();
    const sourcePath = this.stagingPath(sourceId);
    const destinationPath = this.stagingPath(id);
    const trustedSnapshot = await this.snapshotWorkspace(trustedWorkspacePath);
    if (trustedSnapshot.fingerprint !== expectedTrustedFingerprint) {
      throw new TrustedWorkspaceChangedError(
        "Trusted workspace changed before revision",
      );
    }
    const sourceSnapshot = await this.snapshotWorkspace(sourcePath);
    if (sourceSnapshot.fingerprint !== expectedSourceFingerprint) {
      throw new UnsafeWorkspaceEntryError(
        "Retained staging changed before revision",
      );
    }
    await mkdir(destinationPath, { recursive: false });
    try {
      const copied = await copyWorkspaceEntry(
        sourcePath,
        destinationPath,
        sourcePath,
        false,
      );
      const sourceAfterCopy = await this.snapshotWorkspace(sourcePath);
      if (sourceAfterCopy.fingerprint !== expectedSourceFingerprint) {
        throw new UnsafeWorkspaceEntryError(
          "Retained staging changed while revision was created",
        );
      }
      return {
        id,
        path: destinationPath,
        trustedSnapshot,
        metrics: {
          durationMs: performance.now() - startedAt,
          copiedEntryCount: copied.entryCount,
          estimatedCopiedBytes: copied.estimatedBytes,
        },
      };
    } catch (error) {
      await rm(destinationPath, { recursive: true, force: true });
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
      if (
        !before &&
        after?.type === "directory" &&
        !isGitMetadataPath(relativePath) &&
        !isDependencyMetadataPath(relativePath)
      ) {
        continue;
      }
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

    for (const gitMetadataPath of baseline.gitMetadataPaths) {
      const parentPath = path.posix.dirname(gitMetadataPath);
      if (parentPath === ".") continue;
      const stagedParent = stagingByPath.get(parentPath);
      if (stagedParent?.type === "directory") continue;
      if (!changes.some((change) => change.path === gitMetadataPath)) {
        changes.push({
          path: gitMetadataPath,
          kind: "deleted",
          protected: true,
          dependencyFile: false,
          executable: false,
          binary: true,
          symbolicLink: false,
        });
      }
    }
    for (const dependencyMetadataPath of baseline.dependencyMetadataPaths) {
      const parentPath = path.posix.dirname(dependencyMetadataPath);
      if (parentPath === ".") continue;
      const stagedParent = stagingByPath.get(parentPath);
      if (stagedParent?.type === "directory") continue;
      if (!changes.some((change) => change.path === dependencyMetadataPath)) {
        changes.push({
          path: dependencyMetadataPath,
          kind: "deleted",
          protected: true,
          dependencyFile: true,
          executable: false,
          binary: true,
          symbolicLink: false,
        });
      }
    }
    changes.sort((left, right) => left.path.localeCompare(right.path));

    return { changes, stagingFingerprint: stagingSnapshot.fingerprint };
  }

  async readReviewFile(
    workspacePath: string,
    relativePath: string,
  ): Promise<ReviewFileResult> {
    const normalized = validateReviewPath(relativePath);
    const root = path.resolve(workspacePath);
    if (!isInside(this.workspaceRoot, root) || root === this.workspaceRoot) {
      throw new Error("Review workspace is outside the managed root");
    }
    const candidate = path.resolve(root, ...normalized.split("/"));
    if (!isInside(root, candidate) || candidate === root) {
      throw new Error("Review path escapes the workspace");
    }

    let handle;
    try {
      handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { status: "missing" };
      if (code === "ELOOP") return { status: "symbolic_link" };
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) return { status: "symbolic_link" };
      if (stats.size > MAX_REVIEW_FILE_BYTES) return { status: "too_large" };
      const contents = await handle.readFile();
      if (contents.includes(0) || isKnownBinaryPath(normalized)) {
        return { status: "binary" };
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
      } catch {
        return { status: "binary" };
      }
      if (text.split("\n").length > MAX_REVIEW_FILE_LINES) {
        return { status: "too_large" };
      }
      return { status: "available", text };
    } finally {
      await handle.close();
    }
  }

  async discardStagingWorkspace(id: string): Promise<void> {
    await rm(this.stagingPath(id), { recursive: true, force: true });
  }

  async beginPromotion(
    id: string,
    trustedWorkspacePath: string,
    expectedTrustedFingerprint: string,
  ): Promise<RunVaultPromotion> {
    const stagingWorkspacePath = this.stagingPath(id);
    const trustedPath = path.resolve(trustedWorkspacePath);
    if (path.dirname(trustedPath) !== this.workspaceRoot) {
      throw new Error("Trusted workspace path is outside the managed workspace root");
    }
    const agentId = path.basename(trustedPath);
    validateWorkspaceId(agentId);
    const current = await this.snapshotWorkspace(trustedPath);
    if (current.fingerprint !== expectedTrustedFingerprint) {
      throw new TrustedWorkspaceChangedError(
        "Trusted workspace changed before promotion",
      );
    }
    const stagingSnapshot = await this.snapshotWorkspace(stagingWorkspacePath);
    if (stagingSnapshot.entries.some((entry) => isGitMetadataPath(entry.path))) {
      throw new UnsafeWorkspaceEntryError(
        "Agent-created Git metadata cannot be promoted",
      );
    }
    if (
      stagingSnapshot.entries.some((entry) =>
        isDependencyMetadataPath(entry.path),
      )
    ) {
      throw new UnsafeWorkspaceEntryError(
        "Agent-created dependency metadata cannot be promoted",
      );
    }
    const gitMetadataPaths = current.gitMetadataPaths;
    const dependencyMetadataPaths = current.dependencyMetadataPaths;

    const backupWorkspacePath = path.join(this.stagingRoot, `${id}.backup`);
    const markerPath = this.promotionMarkerPath(id);
    const promotion: RunVaultPromotion = {
      id,
      agentId,
      trustedWorkspacePath: trustedPath,
      stagingWorkspacePath,
      backupWorkspacePath,
      markerPath,
      gitMetadataPaths,
      dependencyMetadataPaths,
      markerVersion: 3,
    };
    await this.writePromotionMarker(promotion, "prepared");
    try {
      await rename(trustedPath, backupWorkspacePath);
      await assertGitMetadataInventory(promotion);
      await assertDependencyMetadataInventory(promotion);
      await rename(stagingWorkspacePath, trustedPath);
      await this.writePromotionMarker(promotion, "installed");
      await moveGitMetadataPaths(
        backupWorkspacePath,
        trustedPath,
        gitMetadataPaths,
      );
      await moveDependencyMetadataPaths(
        backupWorkspacePath,
        trustedPath,
        dependencyMetadataPaths,
      );
      await assertGitMetadataInventory(promotion);
      await assertDependencyMetadataInventory(promotion);
      await this.writePromotionMarker(promotion, "metadata_installed");
    } catch (error) {
      await this.restorePrePromotionState(promotion);
      await rm(markerPath, { force: true });
      throw error;
    }
    return promotion;
  }

  async rollbackPromotion(promotion: RunVaultPromotion): Promise<void> {
    await this.validatePromotion(promotion);
    await this.restorePrePromotionState(promotion);
    await rm(promotion.markerPath, { force: true });
  }

  async finalizePromotion(promotion: RunVaultPromotion): Promise<void> {
    await this.validatePromotion(promotion);
    await this.writePromotionMarker(promotion, "committed");
    await rm(promotion.backupWorkspacePath, { recursive: true, force: true });
    await rm(promotion.markerPath, { force: true });
  }

  async reconcileTransactions(database: Database): Promise<void> {
    await this.initialize();
    const entries = await readdir(this.stagingRoot, { withFileTypes: true });
    const markerNames = entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith(".promotion.json"),
      )
      .map((entry) => entry.name)
      .sort();

    for (const markerName of markerNames) {
      const markerPath = path.join(this.stagingRoot, markerName);
      const parsed = JSON.parse(await readFile(markerPath, "utf8")) as unknown;
      if (!isPromotionMarker(parsed)) {
        throw new Error(`Invalid RunVault promotion marker: ${markerName}`);
      }
      validateWorkspaceId(parsed.runId);
      validateWorkspaceId(parsed.agentId);
      if (markerName !== `${parsed.runId}.promotion.json`) {
        throw new Error(`RunVault promotion marker name does not match its Run`);
      }
      const trustedWorkspacePath = path.join(this.workspaceRoot, parsed.agentId);
      const promotion: RunVaultPromotion = {
        id: parsed.runId,
        agentId: parsed.agentId,
        trustedWorkspacePath,
        stagingWorkspacePath: this.stagingPath(parsed.runId),
        backupWorkspacePath: path.join(
          this.stagingRoot,
          `${parsed.runId}.backup`,
        ),
        markerPath,
        gitMetadataPaths:
          parsed.version === 2 || parsed.version === 3
            ? parsed.gitMetadataPaths
            : [],
        dependencyMetadataPaths:
          parsed.version === 3 ? parsed.dependencyMetadataPaths : [],
        markerVersion: parsed.version,
      };
      const run = database.runs.find(
        (candidate) =>
          candidate.id === parsed.runId && candidate.agentId === parsed.agentId,
      );
      const agent = database.agents.find(
        (candidate) => candidate.id === parsed.agentId,
      );
      if (!run || !agent || path.resolve(agent.workspacePath) !== trustedWorkspacePath) {
        throw new Error(
          `RunVault cannot reconcile promotion ${parsed.runId}: persisted Run or Agent is missing`,
        );
      }

      if (run.runVault?.outcome === "promoted") {
        await this.finishCommittedPromotion(promotion);
      } else {
        await this.restorePrePromotionState(promotion);
        if (run.runVault?.outcome !== "quarantined") {
          await this.discardStagingWorkspace(parsed.runId);
        }
        await rm(markerPath, { force: true });
      }
    }

    const retainedStagingIds = new Set(
      database.runs.flatMap((run) =>
        run.runVault?.outcome === "quarantined" &&
        run.runVault.stagingWorkspaceId
          ? [run.runVault.stagingWorkspaceId]
          : [],
      ),
    );
    const remaining = await readdir(this.stagingRoot, { withFileTypes: true });
    for (const entry of remaining) {
      if (entry.name.endsWith(".promotion.json.tmp")) {
        await rm(path.join(this.stagingRoot, entry.name), { force: true });
        continue;
      }
      if (!entry.isDirectory() || entry.name.endsWith(".backup")) continue;
      if (!retainedStagingIds.has(entry.name)) {
        await rm(path.join(this.stagingRoot, entry.name), {
          recursive: true,
          force: true,
        });
      }
    }
  }

  private async validatePromotion(promotion: RunVaultPromotion): Promise<void> {
    validateWorkspaceId(promotion.id);
    validateWorkspaceId(promotion.agentId);
    if (
      path.resolve(promotion.trustedWorkspacePath) !==
        path.join(this.workspaceRoot, promotion.agentId) ||
      path.resolve(promotion.stagingWorkspacePath) !== this.stagingPath(promotion.id) ||
      path.resolve(promotion.backupWorkspacePath) !==
        path.join(this.stagingRoot, `${promotion.id}.backup`) ||
      path.resolve(promotion.markerPath) !== this.promotionMarkerPath(promotion.id)
    ) {
      throw new Error("Promotion paths are outside the managed workspace root");
    }
    if (
      promotion.gitMetadataPaths.length > MAX_GIT_METADATA_PATHS ||
      promotion.gitMetadataPaths.some((relativePath) =>
        !isValidGitMetadataPath(relativePath),
      ) ||
      new Set(promotion.gitMetadataPaths).size !== promotion.gitMetadataPaths.length
    ) {
      throw new Error("Promotion contains invalid Git metadata paths");
    }
    if (
      promotion.dependencyMetadataPaths.length >
        MAX_DEPENDENCY_METADATA_PATHS ||
      promotion.dependencyMetadataPaths.some(
        (relativePath) => !isValidDependencyMetadataPath(relativePath),
      ) ||
      new Set(promotion.dependencyMetadataPaths).size !==
        promotion.dependencyMetadataPaths.length
    ) {
      throw new Error("Promotion contains invalid dependency metadata paths");
    }
    if (
      promotion.markerVersion !== 1 &&
      promotion.markerVersion !== 2 &&
      promotion.markerVersion !== 3
    ) {
      throw new Error("Promotion contains an invalid marker version");
    }
  }

  private async writePromotionMarker(
    promotion: RunVaultPromotion,
    phase: PromotionPhase,
  ): Promise<void> {
    await this.validatePromotion(promotion);
    const marker: PromotionMarkerV3 = {
      version: 3,
      runId: promotion.id,
      agentId: promotion.agentId,
      phase,
      gitMetadataPaths: promotion.gitMetadataPaths,
      dependencyMetadataPaths: promotion.dependencyMetadataPaths,
    };
    const temporaryPath = promotion.markerPath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(marker) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    const handle = await open(temporaryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, promotion.markerPath);
  }

  private async restorePrePromotionState(
    promotion: RunVaultPromotion,
  ): Promise<void> {
    await this.validatePromotion(promotion);
    const trustedExists = await pathExists(promotion.trustedWorkspacePath);
    const stagingExists = await pathExists(promotion.stagingWorkspacePath);
    const backupExists = await pathExists(promotion.backupWorkspacePath);

    if (!backupExists) {
      if (!trustedExists) {
        throw new Error("RunVault cannot recover the missing trusted workspace");
      }
      return;
    }
    if (trustedExists && stagingExists) {
      throw new Error("RunVault found conflicting trusted and staging workspaces");
    }
    if (trustedExists) {
      if (promotion.markerVersion === 2) {
        await assertGitMetadataInventory(promotion);
        await moveGitMetadataPaths(
          promotion.trustedWorkspacePath,
          promotion.backupWorkspacePath,
          promotion.gitMetadataPaths,
        );
      }
      if (promotion.markerVersion === 3) {
        await assertGitMetadataInventory(promotion);
        await assertDependencyMetadataInventory(promotion);
        await moveGitMetadataPaths(
          promotion.trustedWorkspacePath,
          promotion.backupWorkspacePath,
          promotion.gitMetadataPaths,
        );
        await moveDependencyMetadataPaths(
          promotion.trustedWorkspacePath,
          promotion.backupWorkspacePath,
          promotion.dependencyMetadataPaths,
        );
      }
      await rename(promotion.trustedWorkspacePath, promotion.stagingWorkspacePath);
    }
    await rename(promotion.backupWorkspacePath, promotion.trustedWorkspacePath);
  }

  private async finishCommittedPromotion(
    promotion: RunVaultPromotion,
  ): Promise<void> {
    await this.validatePromotion(promotion);
    const trustedExists = await pathExists(promotion.trustedWorkspacePath);
    const stagingExists = await pathExists(promotion.stagingWorkspacePath);
    const backupExists = await pathExists(promotion.backupWorkspacePath);

    if (trustedExists && stagingExists) {
      if (backupExists) {
        throw new Error("RunVault found conflicting committed workspaces");
      }
      await rename(promotion.trustedWorkspacePath, promotion.backupWorkspacePath);
      await rename(promotion.stagingWorkspacePath, promotion.trustedWorkspacePath);
    } else if (!trustedExists && stagingExists) {
      await rename(promotion.stagingWorkspacePath, promotion.trustedWorkspacePath);
    } else if (!trustedExists) {
      throw new Error("RunVault cannot recover the committed workspace");
    }

    if (promotion.markerVersion === 2) {
      await assertGitMetadataInventory(promotion);
      await moveGitMetadataPaths(
        promotion.backupWorkspacePath,
        promotion.trustedWorkspacePath,
        promotion.gitMetadataPaths,
      );
      await assertGitMetadataInventory(promotion);
    }
    if (promotion.markerVersion === 3) {
      await assertGitMetadataInventory(promotion);
      await assertDependencyMetadataInventory(promotion);
      await moveGitMetadataPaths(
        promotion.backupWorkspacePath,
        promotion.trustedWorkspacePath,
        promotion.gitMetadataPaths,
      );
      await moveDependencyMetadataPaths(
        promotion.backupWorkspacePath,
        promotion.trustedWorkspacePath,
        promotion.dependencyMetadataPaths,
      );
      await assertGitMetadataInventory(promotion);
      await assertDependencyMetadataInventory(promotion);
    }

    await rm(promotion.backupWorkspacePath, { recursive: true, force: true });
    await rm(promotion.markerPath, { force: true });
  }
}

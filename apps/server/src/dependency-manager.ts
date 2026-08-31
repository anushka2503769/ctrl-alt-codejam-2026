import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
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
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";

const CACHE_METADATA_FILE = "cache.json";
const MAX_PACKAGE_JSON_BYTES = 1_048_576;
const MAX_PACKAGE_LOCK_BYTES = 16 * 1_048_576;

export interface DependencyRuntimeIdentity {
  imageId: string;
  platform: string;
  npmVersion: string;
}

export interface DependencyPreparationRequest {
  cacheKey: string;
  cacheHostPath: string;
}

export interface DependencyPreparationRunner {
  runtimeIdentity(): Promise<DependencyRuntimeIdentity>;
  prepare(request: DependencyPreparationRequest): Promise<void>;
}

export type DependencyResolutionStatus =
  | "disabled"
  | "not_applicable"
  | "unsupported"
  | "missing"
  | "available";

export interface DependencyResolution {
  status: DependencyResolutionStatus;
  cacheKey: string | null;
  mountPath: string | null;
  message: string;
}

export interface DependencyPreparationResult {
  status: "prepared" | "already_available";
  cacheKey: string;
}

interface DependencyDescriptor {
  cacheKey: string;
  packageJsonPath: string;
  packageLockPath: string;
  metadata: Omit<DependencyCacheMetadata, "createdAt">;
}

interface DependencyCacheMetadata {
  version: 1;
  cacheKey: string;
  runtimeImage: string;
  runtimeImageId: string;
  platform: string;
  npmVersion: string;
  packageJsonDigest: string;
  packageLockDigest: string;
  createdAt: string;
}

export class DependencyCacheUnavailableError extends Error {}
export class DependencyPreparationError extends Error {}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function digest(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function readRegularFile(
  filePath: string,
  maximumBytes: number,
): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") {
      throw new DependencyCacheUnavailableError(
        `${path.basename(filePath)} must not be a symbolic link`,
      );
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maximumBytes) {
      throw new DependencyCacheUnavailableError(
        `${path.basename(filePath)} must be a regular file no larger than ${maximumBytes} bytes`,
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function metadataMatches(
  candidate: unknown,
  expected: Omit<DependencyCacheMetadata, "createdAt">,
): candidate is DependencyCacheMetadata {
  if (!candidate || typeof candidate !== "object") return false;
  const value = candidate as Partial<DependencyCacheMetadata>;
  return (
    value.version === 1 &&
    value.cacheKey === expected.cacheKey &&
    value.runtimeImage === expected.runtimeImage &&
    value.runtimeImageId === expected.runtimeImageId &&
    value.platform === expected.platform &&
    value.npmVersion === expected.npmVersion &&
    value.packageJsonDigest === expected.packageJsonDigest &&
    value.packageLockDigest === expected.packageLockDigest &&
    typeof value.createdAt === "string"
  );
}

async function makeTreeReadOnly(
  root: string,
  current: string = root,
  symlinkRoot: string = path.join(root, "node_modules"),
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(current, entry.name);
    const stats = await lstat(candidate);
    if (stats.isDirectory()) {
      await makeTreeReadOnly(root, candidate, symlinkRoot);
      await chmod(candidate, 0o555);
    } else if (stats.isFile()) {
      await chmod(candidate, (stats.mode & 0o111) === 0 ? 0o444 : 0o555);
    } else if (stats.isSymbolicLink()) {
      const target = await readlink(candidate);
      const resolvedTarget = path.resolve(path.dirname(candidate), target);
      if (path.isAbsolute(target) || !isInside(symlinkRoot, resolvedTarget)) {
        throw new DependencyPreparationError(
          `Dependency cache symbolic link escapes its root at ${path.relative(root, candidate)}`,
        );
      }
    } else {
      throw new DependencyPreparationError(
        `Unsupported dependency cache entry type at ${entry.name}`,
      );
    }
  }
  await chmod(current, 0o555);
}

async function removeWritableTree(root: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stats.isDirectory()) {
    const entries = await readdir(root, { withFileTypes: true });
    await chmod(root, 0o700);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await removeWritableTree(path.join(root, entry.name));
      }
    }
  }
  await rm(root, { recursive: true, force: true });
}

export class DependencyManager {
  private readonly preparations = new Map<
    string,
    Promise<DependencyPreparationResult>
  >();
  private runtimeIdentityPromise: Promise<DependencyRuntimeIdentity> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly runner: DependencyPreparationRunner,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.config.dependencyCacheRoot, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.config.dependencyCacheRoot, {
      withFileTypes: true,
    });
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() && /^[a-f0-9]{64}\.partial-[A-Za-z0-9-]+$/.test(entry.name),
        )
        .map((entry) =>
          removeWritableTree(
            path.join(this.config.dependencyCacheRoot, entry.name),
          ),
        ),
    );
  }

  async resolve(workspacePath: string): Promise<DependencyResolution> {
    if (this.config.dependencyMode === "disabled") {
      return {
        status: "disabled",
        cacheKey: null,
        mountPath: null,
        message: "Managed dependencies are disabled.",
      };
    }
    const descriptor = await this.describe(workspacePath);
    if (descriptor === null) {
      return {
        status: "not_applicable",
        cacheKey: null,
        mountPath: null,
        message: "No package.json is present.",
      };
    }
    if (descriptor === "unsupported") {
      return {
        status: "unsupported",
        cacheKey: null,
        mountPath: null,
        message: "package-lock.json is required for managed npm dependencies.",
      };
    }
    if (!(await this.validCacheEntry(descriptor))) {
      return {
        status: "missing",
        cacheKey: descriptor.cacheKey,
        mountPath: null,
        message: "No matching managed dependency cache is prepared.",
      };
    }
    return {
      status: "available",
      cacheKey: descriptor.cacheKey,
      mountPath: this.cacheHostPath(descriptor.cacheKey, "node_modules"),
      message: "Matching managed dependencies are available.",
    };
  }

  async prepare(
    workspacePath: string,
    confirmNetworkAccess: boolean,
  ): Promise<DependencyPreparationResult> {
    if (this.config.dependencyMode !== "isolated-ci") {
      throw new DependencyPreparationError(
        "Dependency preparation requires DEPENDENCY_MODE=isolated-ci",
      );
    }
    if (!confirmNetworkAccess) {
      throw new DependencyPreparationError(
        "Dependency preparation requires explicit network confirmation",
      );
    }
    const descriptor = await this.describe(workspacePath);
    if (descriptor === null) {
      throw new DependencyPreparationError("package.json is required");
    }
    if (descriptor === "unsupported") {
      throw new DependencyPreparationError(
        "package-lock.json is required for isolated npm ci preparation",
      );
    }
    if (await this.validCacheEntry(descriptor)) {
      return { status: "already_available", cacheKey: descriptor.cacheKey };
    }
    const active = this.preparations.get(descriptor.cacheKey);
    if (active) return active;
    const preparation = this.prepareDescriptor(descriptor).finally(() => {
      if (this.preparations.get(descriptor.cacheKey) === preparation) {
        this.preparations.delete(descriptor.cacheKey);
      }
    });
    this.preparations.set(descriptor.cacheKey, preparation);
    return preparation;
  }

  private async describe(
    workspacePath: string,
  ): Promise<DependencyDescriptor | "unsupported" | null> {
    const workspace = path.resolve(workspacePath);
    if (
      !isInside(this.config.workspaceRoot, workspace) ||
      workspace === this.config.workspaceRoot
    ) {
      throw new DependencyCacheUnavailableError(
        "Dependency workspace is outside the managed workspace root",
      );
    }
    const packageJsonPath = path.join(workspace, "package.json");
    const packageJson = await readRegularFile(
      packageJsonPath,
      MAX_PACKAGE_JSON_BYTES,
    );
    if (packageJson === null) return null;
    try {
      JSON.parse(packageJson.toString("utf8"));
    } catch {
      throw new DependencyCacheUnavailableError("package.json could not be parsed");
    }
    const packageLockPath = path.join(workspace, "package-lock.json");
    const packageLock = await readRegularFile(
      packageLockPath,
      MAX_PACKAGE_LOCK_BYTES,
    );
    if (packageLock === null) return "unsupported";
    try {
      JSON.parse(packageLock.toString("utf8"));
    } catch {
      throw new DependencyCacheUnavailableError(
        "package-lock.json could not be parsed",
      );
    }
    const identity = await this.runtimeIdentity();
    const keyInput = {
      version: 1,
      runtimeImage: this.config.containerRuntimeImage,
      runtimeImageId: identity.imageId,
      platform: identity.platform,
      npmVersion: identity.npmVersion,
      packageJsonDigest: digest(packageJson),
      packageLockDigest: digest(packageLock),
    } as const;
    const cacheKey = digest(Buffer.from(JSON.stringify(keyInput)));
    return {
      cacheKey,
      packageJsonPath,
      packageLockPath,
      metadata: { ...keyInput, cacheKey },
    };
  }

  private runtimeIdentity(): Promise<DependencyRuntimeIdentity> {
    this.runtimeIdentityPromise ??= this.runner.runtimeIdentity();
    return this.runtimeIdentityPromise;
  }

  private cachePath(cacheKey: string, ...segments: string[]): string {
    if (!/^[a-f0-9]{64}$/.test(cacheKey)) {
      throw new DependencyCacheUnavailableError("Invalid dependency cache key");
    }
    const candidate = path.resolve(
      this.config.dependencyCacheRoot,
      cacheKey,
      ...segments,
    );
    if (!isInside(this.config.dependencyCacheRoot, candidate)) {
      throw new DependencyCacheUnavailableError(
        "Dependency cache path escapes its managed root",
      );
    }
    return candidate;
  }

  private cacheHostPath(cacheKey: string, ...segments: string[]): string {
    if (!/^[a-f0-9]{64}$/.test(cacheKey)) {
      throw new DependencyCacheUnavailableError("Invalid dependency cache key");
    }
    const candidate = path.resolve(
      this.config.dependencyCacheHostRoot,
      cacheKey,
      ...segments,
    );
    if (!isInside(this.config.dependencyCacheHostRoot, candidate)) {
      throw new DependencyCacheUnavailableError(
        "Dependency cache host path escapes its managed root",
      );
    }
    return candidate;
  }

  private async validCacheEntry(descriptor: DependencyDescriptor): Promise<boolean> {
    const root = this.cachePath(descriptor.cacheKey);
    try {
      const rootStats = await lstat(root);
      const modulesStats = await lstat(path.join(root, "node_modules"));
      if (!rootStats.isDirectory() || !modulesStats.isDirectory()) return false;
      const parsed = JSON.parse(
        await readFile(path.join(root, CACHE_METADATA_FILE), "utf8"),
      ) as unknown;
      return metadataMatches(parsed, descriptor.metadata);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return false;
    }
  }

  private async prepareDescriptor(
    descriptor: DependencyDescriptor,
  ): Promise<DependencyPreparationResult> {
    const temporaryName = `${descriptor.cacheKey}.partial-${randomUUID()}`;
    const temporaryPath = path.join(this.config.dependencyCacheRoot, temporaryName);
    const temporaryHostPath = path.join(
      this.config.dependencyCacheHostRoot,
      temporaryName,
    );
    if (
      !isInside(this.config.dependencyCacheRoot, temporaryPath) ||
      !isInside(this.config.dependencyCacheHostRoot, temporaryHostPath)
    ) {
      throw new DependencyPreparationError("Invalid partial dependency cache path");
    }
    await mkdir(temporaryPath, { mode: 0o777 });
    try {
      await copyFile(
        descriptor.packageJsonPath,
        path.join(temporaryPath, "package.json"),
      );
      await copyFile(
        descriptor.packageLockPath,
        path.join(temporaryPath, "package-lock.json"),
      );
      await chmod(path.join(temporaryPath, "package.json"), 0o644);
      await chmod(path.join(temporaryPath, "package-lock.json"), 0o644);
      const copiedPackageJson = await readFile(
        path.join(temporaryPath, "package.json"),
      );
      const copiedPackageLock = await readFile(
        path.join(temporaryPath, "package-lock.json"),
      );
      if (
        digest(copiedPackageJson) !== descriptor.metadata.packageJsonDigest ||
        digest(copiedPackageLock) !== descriptor.metadata.packageLockDigest
      ) {
        throw new DependencyPreparationError(
          "Dependency manifests changed while preparation was starting",
        );
      }
      await this.runner.prepare({
        cacheKey: descriptor.cacheKey,
        cacheHostPath: temporaryHostPath,
      });
      const modulesStats = await lstat(path.join(temporaryPath, "node_modules"));
      if (!modulesStats.isDirectory()) {
        throw new DependencyPreparationError(
          "npm ci did not produce a node_modules directory",
        );
      }
      await rm(path.join(temporaryPath, "package.json"), { force: true });
      await rm(path.join(temporaryPath, "package-lock.json"), { force: true });
      const metadata: DependencyCacheMetadata = {
        ...descriptor.metadata,
        createdAt: new Date().toISOString(),
      };
      await writeFile(
        path.join(temporaryPath, CACHE_METADATA_FILE),
        JSON.stringify(metadata) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
      await makeTreeReadOnly(temporaryPath);
      try {
        await rename(temporaryPath, this.cachePath(descriptor.cacheKey));
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === "EEXIST" ||
          (error as NodeJS.ErrnoException).code === "ENOTEMPTY"
        ) {
          if (await this.validCacheEntry(descriptor)) {
            return {
              status: "already_available",
              cacheKey: descriptor.cacheKey,
            };
          }
        }
        throw error;
      }
      return { status: "prepared", cacheKey: descriptor.cacheKey };
    } catch (error) {
      throw error instanceof DependencyPreparationError
        ? error
        : new DependencyPreparationError(
            error instanceof Error ? error.message : String(error),
          );
    } finally {
      await removeWritableTree(temporaryPath).catch(() => undefined);
    }
  }
}

import { chmod, lstat, mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import {
  DependencyManager,
  DependencyPreparationError,
  type DependencyPreparationRequest,
  type DependencyPreparationRunner,
} from "./dependency-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  const makeWritable = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await chmod(directory, 0o755).catch(() => undefined);
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await makeWritable(candidate);
      else await chmod(candidate, 0o644).catch(() => undefined);
    }
  };
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await makeWritable(directory);
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function harness(mode: "disabled" | "existing-cache" | "isolated-ci") {
  const root = await mkdtemp(path.join(tmpdir(), "dependency-manager-test-"));
  temporaryDirectories.push(root);
  const workspaceRoot = path.join(root, "workspaces");
  const workspace = path.join(workspaceRoot, "agent-1");
  const cacheRoot = path.join(root, "dependency-cache");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0" }),
  );
  await writeFile(
    path.join(workspace, "package-lock.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3 }),
  );
  const prepare = vi.fn(async (request: DependencyPreparationRequest) => {
    await mkdir(path.join(request.cacheHostPath, "node_modules", "fixture"), {
      recursive: true,
    });
    await writeFile(
      path.join(request.cacheHostPath, "node_modules", "fixture", "index.js"),
      "module.exports = true;\n",
    );
  });
  const runtimeIdentity = vi.fn(async () => ({
    imageId: `sha256:${"f".repeat(64)}`,
    platform: "linux/arm64",
    npmVersion: "11.1.0",
  }));
  const runner: DependencyPreparationRunner = { prepare, runtimeIdentity };
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: workspaceRoot,
    CODEX_HOME: path.join(root, "codex"),
    DEPENDENCY_MODE: mode,
    DEPENDENCY_CACHE_ROOT: cacheRoot,
    DEPENDENCY_CACHE_HOST_ROOT: cacheRoot,
    RUNTIME_PROVIDER: mode === "disabled" ? "local-process" : "container",
    VERIFICATION_PROVIDER: "container",
    CONTAINER_RUNTIME_IMAGE: "runtime:test",
    APP_AUTH_TOKEN: mode === "isolated-ci" ? "dependency-test-token" : undefined,
  });
  const manager = new DependencyManager(config, runner);
  await manager.initialize();
  return { cacheRoot, manager, prepare, runtimeIdentity, workspace };
}

describe("DependencyManager", () => {
  it("does not inspect the runtime when managed dependencies are disabled", async () => {
    const fixture = await harness("disabled");
    await expect(fixture.manager.resolve(fixture.workspace)).resolves.toMatchObject({
      status: "disabled",
      mountPath: null,
    });
    expect(fixture.runtimeIdentity).not.toHaveBeenCalled();
    expect(fixture.prepare).not.toHaveBeenCalled();
  });

  it("requires explicit network confirmation and prepares one immutable cache", async () => {
    const fixture = await harness("isolated-ci");
    await expect(fixture.manager.prepare(fixture.workspace, false)).rejects
      .toThrow("explicit network confirmation");

    const [first, second] = await Promise.all([
      fixture.manager.prepare(fixture.workspace, true),
      fixture.manager.prepare(fixture.workspace, true),
    ]);
    expect(first.cacheKey).toBe(second.cacheKey);
    expect(fixture.prepare).toHaveBeenCalledTimes(1);

    const resolution = await fixture.manager.resolve(fixture.workspace);
    expect(resolution).toMatchObject({
      status: "available",
      cacheKey: first.cacheKey,
    });
    expect(resolution.mountPath).toBe(
      path.join(fixture.cacheRoot, first.cacheKey, "node_modules"),
    );
    expect((await lstat(resolution.mountPath!)).mode & 0o222).toBe(0);
    expect(
      (await lstat(path.join(resolution.mountPath!, "fixture", "index.js"))).mode &
        0o222,
    ).toBe(0);
    await expect(fixture.manager.diagnostics()).resolves.toMatchObject({
      mode: "isolated-ci",
      validCacheCount: 1,
      invalidCacheCount: 0,
      partialCacheCount: 0,
      activePreparations: 0,
      totalBytes: expect.any(Number),
    });
    await expect(
      fixture.manager.prepare(fixture.workspace, true),
    ).resolves.toEqual({
      status: "already_available",
      cacheKey: first.cacheKey,
    });
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
  });

  it("invalidates the cache key when the lockfile changes", async () => {
    const fixture = await harness("isolated-ci");
    const prepared = await fixture.manager.prepare(fixture.workspace, true);
    await chmod(path.join(fixture.cacheRoot, prepared.cacheKey), 0o755);
    await writeFile(
      path.join(fixture.workspace, "package-lock.json"),
      JSON.stringify({ name: "fixture", version: "2.0.0", lockfileVersion: 3 }),
    );

    const changed = await fixture.manager.resolve(fixture.workspace);
    expect(changed.status).toBe("missing");
    expect(changed.cacheKey).not.toBe(prepared.cacheKey);
  });

  it("cleans partial caches after preparation failure", async () => {
    const fixture = await harness("isolated-ci");
    fixture.prepare.mockImplementationOnce(async () => {
      throw new DependencyPreparationError("registry unavailable");
    });

    await expect(fixture.manager.prepare(fixture.workspace, true)).rejects
      .toThrow("registry unavailable");
    expect((await readdir(fixture.cacheRoot)).filter((name) => name.includes(".partial-")))
      .toEqual([]);
  });

  it("rejects dependency cache symbolic links that escape the cache", async () => {
    const fixture = await harness("isolated-ci");
    fixture.prepare.mockImplementationOnce(async (request) => {
      await mkdir(path.join(request.cacheHostPath, "node_modules"));
      await symlink("/etc/passwd", path.join(request.cacheHostPath, "node_modules", "escape"));
    });

    await expect(fixture.manager.prepare(fixture.workspace, true)).rejects
      .toThrow("symbolic link escapes its root");
    expect((await readdir(fixture.cacheRoot)).filter((name) => name.includes(".partial-")))
      .toEqual([]);
  });

  it("removes read-only partial caches during startup recovery", async () => {
    const fixture = await harness("isolated-ci");
    const partial = path.join(
      fixture.cacheRoot,
      `${"c".repeat(64)}.partial-interrupted`,
    );
    const nested = path.join(partial, "node_modules", "fixture");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "index.js"), "fixture\n");
    await chmod(nested, 0o555);
    await chmod(path.dirname(nested), 0o555);
    await chmod(partial, 0o555);

    await fixture.manager.initialize();

    await expect(lstat(partial)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports unsupported manifests without invoking preparation", async () => {
    const fixture = await harness("existing-cache");
    const { rm } = await import("node:fs/promises");
    await rm(path.join(fixture.workspace, "package-lock.json"));

    await expect(fixture.manager.resolve(fixture.workspace)).resolves.toMatchObject({
      status: "unsupported",
      mountPath: null,
    });
    await expect(fixture.manager.prepare(fixture.workspace, true)).rejects
      .toThrow("DEPENDENCY_MODE=isolated-ci");
    expect(fixture.prepare).not.toHaveBeenCalled();
  });

  it("rejects dependency workspaces outside the managed root", async () => {
    const fixture = await harness("existing-cache");
    await expect(fixture.manager.resolve(path.dirname(fixture.workspace))).rejects
      .toThrow("outside the managed workspace root");
  });
});

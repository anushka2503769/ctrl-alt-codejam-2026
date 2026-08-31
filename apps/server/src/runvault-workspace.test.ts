import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database, RunVaultOutcome } from "./types.js";
import {
  isDependencyFile,
  isProtectedRunVaultPath,
  RunVaultWorkspaceManager,
  StagingQuotaExceededError,
  UnsafeWorkspaceEntryError,
} from "./runvault-workspace.js";

let root: string;
let trusted: string;
let manager: RunVaultWorkspaceManager;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "runvault-workspace-test-"));
  trusted = path.join(root, "agent-1");
  await mkdir(trusted);
  manager = new RunVaultWorkspaceManager(root);
  await manager.initialize();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function stage(id = "run-1") {
  return manager.createStagingWorkspace(id, trusted);
}

function databaseForRun(
  runId: string,
  outcome: RunVaultOutcome,
): Database {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    version: 1,
    agents: [
      {
        id: "agent-1",
        name: "Recovery Agent",
        description: "",
        instructions: "",
        status: "ready",
        workspacePath: trusted,
        codexThreadId: outcome === "promoted" ? "thread-1" : null,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    messages: [],
    runs: [
      {
        id: runId,
        agentId: "agent-1",
        status: "completed",
        prompt: "change state",
        output: "changed state",
        error: null,
        usage: null,
        runVault: {
          outcome,
          reason: "protected_path",
          resolution: outcome === "promoted" ? "human_approved" : "policy",
          stagingWorkspaceId: runId,
          provisionalThreadId: "thread-1",
          trustedWorkspaceFingerprint: "trusted-fingerprint",
          stagingWorkspaceFingerprint: "staging-fingerprint",
          changedFiles: {
            addedCount: 0,
            modifiedCount: 1,
            deletedCount: 0,
            protectedPathsTouched: ["state.txt"],
          },
          verification: {
            status: "passed",
            command: "npm test",
            redactedSummary: "passed",
          },
          trustedWorkspaceChanged: false,
          decidedAt: timestamp,
        },
        startedAt: timestamp,
        completedAt: timestamp,
        createdAt: timestamp,
      },
    ],
  };
}

describe("RunVaultWorkspaceManager", () => {
  it("copies a trusted workspace without exposing reserved metadata", async () => {
    await mkdir(path.join(trusted, "src"));
    await writeFile(path.join(trusted, "src", "index.ts"), "export const one = 1;\n");
    await mkdir(path.join(trusted, "node_modules"));
    await writeFile(path.join(trusted, "node_modules", "fixture.js"), "module.exports = 1;\n");
    await mkdir(path.join(trusted, ".codex"));
    await writeFile(path.join(trusted, ".codex", "session.json"), "secret metadata");
    await mkdir(path.join(trusted, ".git"));
    await writeFile(path.join(trusted, ".git", "config"), "trusted git metadata");

    const staging = await stage();

    await expect(readFile(path.join(staging.path, "src", "index.ts"), "utf8"))
      .resolves.toBe("export const one = 1;\n");
    await expect(lstat(path.join(staging.path, "node_modules"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(path.join(staging.path, ".codex"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(path.join(staging.path, ".git"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not traverse, hash, or copy trusted dependency metadata", async () => {
    await writeFile(path.join(trusted, "source.ts"), "x");
    await mkdir(path.join(trusted, "node_modules", "large-package"), {
      recursive: true,
    });
    await writeFile(
      path.join(trusted, "node_modules", "large-package", "index.js"),
      "x".repeat(4096),
    );
    await mkdir(path.join(trusted, "packages", "nested", "node_modules"), {
      recursive: true,
    });
    await writeFile(
      path.join(trusted, "packages", "nested", "node_modules", "fixture.js"),
      "nested",
    );

    const before = await manager.snapshotWorkspace(trusted);
    const staging = await stage();
    const after = await manager.snapshotWorkspace(trusted);

    expect(before.fingerprint).toBe(after.fingerprint);
    expect(before.entries.every((entry) => !entry.path.includes("node_modules")))
      .toBe(true);
    expect(before.dependencyMetadataPaths).toEqual([
      "node_modules",
      "packages/nested/node_modules",
    ]);
    await expect(lstat(path.join(staging.path, "node_modules"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      lstat(path.join(staging.path, "packages", "nested", "node_modules")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not traverse, hash, or copy trusted root and nested Git metadata", async () => {
    await writeFile(path.join(trusted, "source.ts"), "x");
    await mkdir(path.join(trusted, ".git", "objects"), { recursive: true });
    await writeFile(path.join(trusted, ".git", "objects", "large"), "g".repeat(4096));
    await mkdir(path.join(trusted, "packages", "nested"), { recursive: true });
    await writeFile(path.join(trusted, "packages", "nested", "index.ts"), "nested");
    await writeFile(
      path.join(trusted, "packages", "nested", ".git"),
      "gitdir: ../../.git/modules/nested\n",
    );
    const before = await manager.snapshotWorkspace(trusted);

    const staging = await stage();

    expect(before.entries.map((entry) => entry.path)).not.toContain(".git");
    expect(before.entries.map((entry) => entry.path)).not.toContain(
      "packages/nested/.git",
    );
    expect(before.estimatedBytes).toBe("x".length + "nested".length);
    expect(staging.metrics.estimatedCopiedBytes).toBe(
      "x".length + "nested".length,
    );
    expect(staging.metrics.durationMs).toBeGreaterThanOrEqual(0);
    await expect(lstat(path.join(staging.path, ".git"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      lstat(path.join(staging.path, "packages", "nested", ".git")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path.join(trusted, ".git", "objects", "large"), "changed");
    expect((await manager.snapshotWorkspace(trusted)).fingerprint).toBe(
      before.fingerprint,
    );
  });

  it("keeps the trusted workspace unchanged when staging is edited", async () => {
    await writeFile(path.join(trusted, "README.md"), "trusted\n");
    const before = await manager.snapshotWorkspace(trusted);
    const staging = await stage();

    await writeFile(path.join(staging.path, "README.md"), "staged\n");
    await writeFile(path.join(staging.path, "new.ts"), "export {};\n");

    expect(await readFile(path.join(trusted, "README.md"), "utf8")).toBe("trusted\n");
    await expect(lstat(path.join(trusted, "new.ts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await manager.snapshotWorkspace(trusted)).fingerprint).toBe(
      before.fingerprint,
    );
  });

  it("reports added, modified, deleted, and permission-only changes", async () => {
    await writeFile(path.join(trusted, "modify.ts"), "before\n");
    await writeFile(path.join(trusted, "delete.ts"), "delete me\n");
    await writeFile(path.join(trusted, "mode.sh"), "#!/bin/sh\n");
    const staging = await stage();

    await writeFile(path.join(staging.path, "modify.ts"), "after\n");
    await rm(path.join(staging.path, "delete.ts"));
    await writeFile(path.join(staging.path, "added.ts"), "new\n");
    await chmod(path.join(staging.path, "mode.sh"), 0o755);

    const inspection = await manager.inspectChanges(
      staging.trustedSnapshot,
      staging.path,
    );
    expect(inspection.changes).toEqual([
      expect.objectContaining({ path: "added.ts", kind: "added" }),
      expect.objectContaining({ path: "delete.ts", kind: "deleted" }),
      expect.objectContaining({ path: "mode.sh", kind: "modified", executable: true }),
      expect.objectContaining({ path: "modify.ts", kind: "modified" }),
    ]);
    expect(inspection.changedBytes).toBe(
      Buffer.byteLength("new\n") +
      Buffer.byteLength("delete me\n") +
      Buffer.byteLength("#!/bin/sh\n") +
      Buffer.byteLength("before\n"),
    );
  });

  it("classifies protected paths without exposing their contents", async () => {
    await writeFile(path.join(trusted, "safe.ts"), "safe\n");
    const staging = await stage();
    await writeFile(path.join(staging.path, ".env.production"), "TOKEN=do-not-return\n");
    await mkdir(path.join(staging.path, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(staging.path, ".github", "workflows", "ci.yml"), "name: CI\n");
    await mkdir(path.join(staging.path, "deploy"));
    await writeFile(path.join(staging.path, "deploy", "app.yml"), "service: app\n");

    const inspection = await manager.inspectChanges(
      staging.trustedSnapshot,
      staging.path,
    );
    expect(inspection.changes.filter((item) => item.protected).map((item) => item.path))
      .toEqual([".env.production", ".github/workflows/ci.yml", "deploy/app.yml"]);
    expect(JSON.stringify(inspection)).not.toContain("do-not-return");
  });

  it("applies custom protection in addition to built-in protections", async () => {
    const staging = await stage();
    await mkdir(path.join(staging.path, "secrets"));
    await writeFile(path.join(staging.path, "secrets", "token.txt"), "hidden\n");
    await writeFile(path.join(staging.path, ".env"), "TOKEN=also-hidden\n");

    const inspection = await manager.inspectChanges(
      staging.trustedSnapshot,
      staging.path,
      [".env", "secrets/**"],
    );

    expect(inspection.changes.map((change) => [change.path, change.protected]))
      .toEqual([
        [".env", true],
        ["secrets/token.txt", true],
      ]);
    expect(JSON.stringify(inspection)).not.toContain("hidden");
  });

  it("rejects a source that exceeds the per-Run staging quota", async () => {
    await writeFile(path.join(trusted, "large.bin"), Buffer.alloc(1_048_577));

    await expect(
      manager.createStagingWorkspace("quota-run", trusted, {
        perRunBytes: 1_048_576,
        totalBytes: 2_097_152,
      }),
    ).rejects.toBeInstanceOf(StagingQuotaExceededError);
    await expect(lstat(manager.stagingPath("quota-run"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(path.join(trusted, "large.bin"))).resolves.toBeDefined();
  });

  it("serializes staging creation against the total quota", async () => {
    await writeFile(path.join(trusted, "source.bin"), Buffer.alloc(700_000));
    const quota = { perRunBytes: 1_048_576, totalBytes: 1_300_000 };

    const attempts = await Promise.allSettled([
      manager.createStagingWorkspace("quota-a", trusted, quota),
      manager.createStagingWorkspace("quota-b", trusted, quota),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled"))
      .toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.any(StagingQuotaExceededError),
    });
  });

  it.each([
    [".env", true],
    [".env.local", true],
    ["AGENTS.md", true],
    [".codex/session.json", true],
    [".git", true],
    ["packages/nested/.git/config", true],
    [".staging/nested", true],
    [".github/workflows/release.yml", true],
    ["infra/main.tf", true],
    ["deploy/app.yaml", true],
    ["src/.env", false],
    ["deployment/app.yaml", false],
  ])("classifies protected path %s as %s", (candidate, expected) => {
    expect(isProtectedRunVaultPath(candidate)).toBe(expected);
  });

  it.each([
    "package.json",
    "apps/web/package-lock.json",
    "pnpm-lock.yaml",
    "pyproject.toml",
    "requirements-dev.txt",
    "go.mod",
  ])("classifies dependency file %s", (candidate) => {
    expect(isDependencyFile(candidate)).toBe(true);
  });

  it("detects newly introduced binary files", async () => {
    const staging = await stage();
    await writeFile(path.join(staging.path, "artifact.dat"), Buffer.from([0, 1, 2, 3]));

    const inspection = await manager.inspectChanges(
      staging.trustedSnapshot,
      staging.path,
    );
    expect(inspection.changes).toEqual([
      expect.objectContaining({ path: "artifact.dat", binary: true, kind: "added" }),
    ]);
  });

  it("inspects reserved metadata created after staging", async () => {
    const staging = await stage();
    await mkdir(path.join(staging.path, ".codex"));
    await writeFile(path.join(staging.path, ".codex", "session.json"), "agent state\n");

    const inspection = await manager.inspectChanges(
      staging.trustedSnapshot,
      staging.path,
    );

    expect(inspection.changes).toEqual([
      expect.objectContaining({
        path: ".codex/session.json",
        kind: "added",
        protected: true,
      }),
    ]);
  });

  it("detects even empty Agent-created Git metadata and blocks promotion", async () => {
    const staging = await stage();
    await mkdir(path.join(staging.path, ".git"));

    const inspection = await manager.inspectChanges(
      staging.trustedSnapshot,
      staging.path,
    );

    expect(inspection.changes).toEqual([
      expect.objectContaining({
        path: ".git",
        kind: "added",
        protected: true,
      }),
    ]);
    await expect(
      manager.beginPromotion(
        staging.id,
        trusted,
        staging.trustedSnapshot.fingerprint,
      ),
    ).rejects.toThrow("Agent-created Git metadata cannot be promoted");
  });

  it("detects even empty Agent-created dependency metadata and blocks promotion", async () => {
    const staging = await stage();
    await mkdir(path.join(staging.path, "node_modules"));

    const inspection = await manager.inspectChanges(
      staging.trustedSnapshot,
      staging.path,
    );

    expect(inspection.changes).toEqual([
      expect.objectContaining({
        path: "node_modules",
        kind: "added",
        protected: true,
        dependencyFile: true,
      }),
    ]);
    await expect(
      manager.beginPromotion(
        staging.id,
        trusted,
        staging.trustedSnapshot.fingerprint,
      ),
    ).rejects.toThrow("Agent-created dependency metadata cannot be promoted");
  });

  it("excludes Agent-created dependency metadata from revision staging", async () => {
    const parent = await stage("dependency-parent");
    await mkdir(path.join(parent.path, "node_modules"));
    const parentInspection = await manager.inspectChanges(
      parent.trustedSnapshot,
      parent.path,
    );

    const child = await manager.createRevisionStagingWorkspace(
      "dependency-child",
      parent.id,
      trusted,
      parentInspection.stagingFingerprint,
      parent.trustedSnapshot.fingerprint,
    );

    await expect(lstat(path.join(child.path, "node_modules"))).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("retains Agent-created Git metadata in revision staging until removed", async () => {
    const parent = await stage("parent-run");
    await mkdir(path.join(parent.path, "nested", ".git"), { recursive: true });
    const parentInspection = await manager.inspectChanges(
      parent.trustedSnapshot,
      parent.path,
    );

    const child = await manager.createRevisionStagingWorkspace(
      "child-run",
      parent.id,
      trusted,
      parentInspection.stagingFingerprint,
      parent.trustedSnapshot.fingerprint,
    );

    await expect(lstat(path.join(child.path, "nested", ".git"))).resolves
      .toBeDefined();
    const childInspection = await manager.inspectChanges(
      child.trustedSnapshot,
      child.path,
    );
    expect(childInspection.changes).toContainEqual(
      expect.objectContaining({ path: "nested/.git", protected: true }),
    );
  });

  it("quarantines removal of a parent that contains preserved nested Git metadata", async () => {
    await mkdir(path.join(trusted, "nested"));
    await writeFile(path.join(trusted, "nested", "source.ts"), "source\n");
    await writeFile(path.join(trusted, "nested", ".git"), "nested metadata\n");
    const staging = await stage();
    await rm(path.join(staging.path, "nested"), { recursive: true });

    const inspection = await manager.inspectChanges(
      staging.trustedSnapshot,
      staging.path,
    );

    expect(inspection.changes).toContainEqual(
      expect.objectContaining({
        path: "nested/.git",
        kind: "deleted",
        protected: true,
      }),
    );
    await expect(
      manager.beginPromotion(
        staging.id,
        trusted,
        staging.trustedSnapshot.fingerprint,
      ),
    ).rejects.toThrow("parent was removed");
    await expect(readFile(path.join(trusted, "nested", ".git"), "utf8"))
      .resolves.toBe("nested metadata\n");
  });

  it("detects a new internal symbolic link without following it", async () => {
    await writeFile(path.join(trusted, "target.txt"), "target\n");
    const staging = await stage();
    await symlink("target.txt", path.join(staging.path, "link.txt"));

    const inspection = await manager.inspectChanges(
      staging.trustedSnapshot,
      staging.path,
    );
    expect(inspection.changes).toEqual([
      expect.objectContaining({
        path: "link.txt",
        kind: "added",
        symbolicLink: true,
      }),
    ]);
  });

  it("rejects an existing symbolic link that escapes the trusted workspace", async () => {
    await symlink("../outside.txt", path.join(trusted, "escape"));

    await expect(stage()).rejects.toBeInstanceOf(UnsafeWorkspaceEntryError);
    await expect(lstat(manager.stagingPath("run-1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses stable fingerprints and changes them for content or mode changes", async () => {
    const filePath = path.join(trusted, "tool.sh");
    await writeFile(filePath, "echo one\n");
    const first = await manager.snapshotWorkspace(trusted);
    const second = await manager.snapshotWorkspace(trusted);
    expect(second.fingerprint).toBe(first.fingerprint);

    await writeFile(filePath, "echo two\n");
    const contentChanged = await manager.snapshotWorkspace(trusted);
    expect(contentChanged.fingerprint).not.toBe(first.fingerprint);

    await chmod(filePath, 0o755);
    const modeChanged = await manager.snapshotWorkspace(trusted);
    expect(modeChanged.fingerprint).not.toBe(contentChanged.fingerprint);
  });

  it("rejects staging IDs and workspace paths outside managed roots", async () => {
    expect(() => manager.stagingPath("../escape")).toThrow("Invalid staging workspace ID");
    await expect(manager.snapshotWorkspace(path.dirname(root))).rejects.toThrow(
      "outside the managed workspace root",
    );
  });

  it("removes only the requested staging workspace", async () => {
    const first = await stage("run-1");
    const second = await stage("run-2");

    await manager.discardStagingWorkspace("run-1");

    await expect(lstat(first.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(second.path)).resolves.toBeDefined();
  });

  it("installs a staged workspace and can roll the promotion back", async () => {
    await writeFile(path.join(trusted, "state.txt"), "trusted\n");
    const staging = await stage();
    await writeFile(path.join(staging.path, "state.txt"), "staged\n");

    const promotion = await manager.beginPromotion(
      staging.id,
      trusted,
      staging.trustedSnapshot.fingerprint,
    );
    expect(await readFile(path.join(trusted, "state.txt"), "utf8")).toBe("staged\n");
    await expect(readFile(manager.promotionMarkerPath(staging.id), "utf8"))
      .resolves.toContain('"phase":"metadata_installed"');

    await manager.rollbackPromotion(promotion);
    expect(await readFile(path.join(trusted, "state.txt"), "utf8")).toBe("trusted\n");
    expect(await readFile(path.join(staging.path, "state.txt"), "utf8")).toBe("staged\n");
    await expect(lstat(manager.promotionMarkerPath(staging.id))).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("preserves root and nested trusted Git metadata through promotion rollback", async () => {
    await mkdir(path.join(trusted, ".git"));
    await writeFile(path.join(trusted, ".git", "config"), "root metadata\n");
    await mkdir(path.join(trusted, "nested"));
    await writeFile(path.join(trusted, "nested", "source.ts"), "trusted\n");
    await writeFile(
      path.join(trusted, "nested", ".git"),
      "gitdir: ../.git/modules/nested\n",
    );
    const staging = await stage();
    await writeFile(path.join(staging.path, "nested", "source.ts"), "staged\n");

    const promotion = await manager.beginPromotion(
      staging.id,
      trusted,
      staging.trustedSnapshot.fingerprint,
    );

    await expect(readFile(path.join(trusted, ".git", "config"), "utf8"))
      .resolves.toBe("root metadata\n");
    await expect(readFile(path.join(trusted, "nested", ".git"), "utf8"))
      .resolves.toContain("gitdir:");
    await manager.rollbackPromotion(promotion);
    await expect(readFile(path.join(trusted, ".git", "config"), "utf8"))
      .resolves.toBe("root metadata\n");
    await expect(readFile(path.join(trusted, "nested", ".git"), "utf8"))
      .resolves.toContain("gitdir:");
    await expect(lstat(path.join(staging.path, ".git"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(path.join(staging.path, "nested", ".git"))).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("preserves a Git worktree metadata file through committed promotion", async () => {
    await writeFile(
      path.join(trusted, ".git"),
      "gitdir: /srv/repository/.git/worktrees/agent-1\n",
    );
    await writeFile(path.join(trusted, "state.txt"), "trusted\n");
    const staging = await stage("run-worktree-file");
    await writeFile(path.join(staging.path, "state.txt"), "staged\n");

    const promotion = await manager.beginPromotion(
      staging.id,
      trusted,
      staging.trustedSnapshot.fingerprint,
    );
    await manager.finalizePromotion(promotion);

    await expect(readFile(path.join(trusted, ".git"), "utf8")).resolves.toBe(
      "gitdir: /srv/repository/.git/worktrees/agent-1\n",
    );
    await expect(readFile(path.join(trusted, "state.txt"), "utf8")).resolves
      .toBe("staged\n");
  });

  it("preserves root and nested trusted dependency metadata through promotion", async () => {
    await mkdir(path.join(trusted, "node_modules"));
    await writeFile(path.join(trusted, "node_modules", "root.js"), "root\n");
    await mkdir(path.join(trusted, "packages", "app", "node_modules"), {
      recursive: true,
    });
    await writeFile(
      path.join(trusted, "packages", "app", "node_modules", "nested.js"),
      "nested\n",
    );
    await writeFile(path.join(trusted, "state.txt"), "trusted\n");
    const staging = await stage("run-dependency-preservation");
    await writeFile(path.join(staging.path, "state.txt"), "staged\n");

    const promotion = await manager.beginPromotion(
      staging.id,
      trusted,
      staging.trustedSnapshot.fingerprint,
    );
    await manager.finalizePromotion(promotion);

    await expect(
      readFile(path.join(trusted, "node_modules", "root.js"), "utf8"),
    ).resolves.toBe("root\n");
    await expect(
      readFile(
        path.join(trusted, "packages", "app", "node_modules", "nested.js"),
        "utf8",
      ),
    ).resolves.toBe("nested\n");
    await expect(readFile(path.join(trusted, "state.txt"), "utf8")).resolves
      .toBe("staged\n");
  });

  it("finishes a committed promotion interrupted before Git metadata transfer", async () => {
    await mkdir(path.join(trusted, ".git"));
    await writeFile(path.join(trusted, ".git", "config"), "preserved\n");
    await writeFile(path.join(trusted, "state.txt"), "trusted\n");
    const staging = await stage("run-git-recovery");
    await writeFile(path.join(staging.path, "state.txt"), "staged\n");
    const backup = path.join(root, ".staging", `${staging.id}.backup`);
    await rename(trusted, backup);
    await rename(staging.path, trusted);
    await writeFile(
      manager.promotionMarkerPath(staging.id),
      JSON.stringify({
        version: 2,
        runId: staging.id,
        agentId: "agent-1",
        phase: "installed",
        gitMetadataPaths: [".git"],
      }) + "\n",
    );

    const restarted = new RunVaultWorkspaceManager(root);
    await restarted.reconcileTransactions(
      databaseForRun(staging.id, "promoted"),
    );

    await expect(readFile(path.join(trusted, "state.txt"), "utf8")).resolves
      .toBe("staged\n");
    await expect(readFile(path.join(trusted, ".git", "config"), "utf8"))
      .resolves.toBe("preserved\n");
    await expect(lstat(backup)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back an interrupted partial Git metadata transfer", async () => {
    await mkdir(path.join(trusted, ".git"));
    await writeFile(path.join(trusted, ".git", "config"), "root metadata\n");
    await mkdir(path.join(trusted, "nested"));
    await writeFile(path.join(trusted, "nested", "source.ts"), "trusted\n");
    await writeFile(path.join(trusted, "nested", ".git"), "nested metadata\n");
    const staging = await stage("run-git-rollback");
    await writeFile(path.join(staging.path, "nested", "source.ts"), "staged\n");
    const backup = path.join(root, ".staging", `${staging.id}.backup`);
    await rename(trusted, backup);
    await rename(staging.path, trusted);
    await rename(path.join(backup, ".git"), path.join(trusted, ".git"));
    await writeFile(
      manager.promotionMarkerPath(staging.id),
      JSON.stringify({
        version: 2,
        runId: staging.id,
        agentId: "agent-1",
        phase: "installed",
        gitMetadataPaths: [".git", "nested/.git"],
      }) + "\n",
    );

    const restarted = new RunVaultWorkspaceManager(root);
    await restarted.reconcileTransactions(
      databaseForRun(staging.id, "quarantined"),
    );

    await expect(readFile(path.join(trusted, ".git", "config"), "utf8"))
      .resolves.toBe("root metadata\n");
    await expect(readFile(path.join(trusted, "nested", ".git"), "utf8"))
      .resolves.toBe("nested metadata\n");
    await expect(readFile(path.join(staging.path, "nested", "source.ts"), "utf8"))
      .resolves.toBe("staged\n");
    await expect(lstat(path.join(staging.path, ".git"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reconciles legacy version-one promotion markers", async () => {
    await mkdir(path.join(trusted, ".git"));
    await writeFile(path.join(trusted, ".git", "config"), "legacy metadata\n");
    await writeFile(path.join(trusted, "state.txt"), "trusted\n");
    const staging = await stage("run-legacy-marker");
    await writeFile(path.join(staging.path, "state.txt"), "staged\n");
    await mkdir(path.join(staging.path, ".git"));
    await writeFile(path.join(staging.path, ".git", "config"), "legacy metadata\n");
    const backup = path.join(root, ".staging", `${staging.id}.backup`);
    await rename(trusted, backup);
    await rename(staging.path, trusted);
    await writeFile(
      manager.promotionMarkerPath(staging.id),
      JSON.stringify({
        version: 1,
        runId: staging.id,
        agentId: "agent-1",
        phase: "installed",
      }) + "\n",
    );

    const restarted = new RunVaultWorkspaceManager(root);
    await restarted.reconcileTransactions(
      databaseForRun(staging.id, "promoted"),
    );

    await expect(readFile(path.join(trusted, ".git", "config"), "utf8"))
      .resolves.toBe("legacy metadata\n");
    await expect(readFile(path.join(trusted, "state.txt"), "utf8")).resolves
      .toBe("staged\n");
  });

  it("rejects unsafe Git metadata paths in promotion markers", async () => {
    const staging = await stage("run-invalid-marker");
    await writeFile(
      manager.promotionMarkerPath(staging.id),
      JSON.stringify({
        version: 2,
        runId: staging.id,
        agentId: "agent-1",
        phase: "prepared",
        gitMetadataPaths: ["../.git"],
      }) + "\n",
    );

    await expect(
      manager.reconcileTransactions(databaseForRun(staging.id, "quarantined")),
    ).rejects.toThrow("Invalid RunVault promotion marker");
  });

  it("rolls back an installed promotion when the database did not commit it", async () => {
    await writeFile(path.join(trusted, "state.txt"), "trusted\n");
    const staging = await stage("run-interrupted");
    await writeFile(path.join(staging.path, "state.txt"), "staged\n");
    await manager.beginPromotion(
      staging.id,
      trusted,
      staging.trustedSnapshot.fingerprint,
    );

    const restarted = new RunVaultWorkspaceManager(root);
    await restarted.reconcileTransactions(
      databaseForRun(staging.id, "quarantined"),
    );

    expect(await readFile(path.join(trusted, "state.txt"), "utf8")).toBe(
      "trusted\n",
    );
    expect(await readFile(path.join(staging.path, "state.txt"), "utf8")).toBe(
      "staged\n",
    );
    await expect(lstat(path.join(root, ".staging", `${staging.id}.backup`)))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(restarted.promotionMarkerPath(staging.id))).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("finishes cleanup when the database committed an installed promotion", async () => {
    await writeFile(path.join(trusted, "state.txt"), "trusted\n");
    const staging = await stage("run-committed");
    await writeFile(path.join(staging.path, "state.txt"), "staged\n");
    await manager.beginPromotion(
      staging.id,
      trusted,
      staging.trustedSnapshot.fingerprint,
    );

    const restarted = new RunVaultWorkspaceManager(root);
    await restarted.reconcileTransactions(databaseForRun(staging.id, "promoted"));

    expect(await readFile(path.join(trusted, "state.txt"), "utf8")).toBe(
      "staged\n",
    );
    await expect(lstat(path.join(root, ".staging", `${staging.id}.backup`)))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(restarted.promotionMarkerPath(staging.id))).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("removes orphan staging while preserving persisted quarantine", async () => {
    const retained = await stage("run-retained");
    const orphan = await stage("run-orphan");

    await manager.reconcileTransactions(
      databaseForRun(retained.id, "quarantined"),
    );

    await expect(lstat(retained.path)).resolves.toBeDefined();
    await expect(lstat(orphan.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses promotion after the trusted workspace changes", async () => {
    await writeFile(path.join(trusted, "state.txt"), "trusted\n");
    const staging = await stage();
    await writeFile(path.join(trusted, "state.txt"), "external edit\n");

    await expect(
      manager.beginPromotion(
        staging.id,
        trusted,
        staging.trustedSnapshot.fingerprint,
      ),
    ).rejects.toThrow("Trusted workspace changed before promotion");
    expect(await readFile(path.join(trusted, "state.txt"), "utf8")).toBe(
      "external edit\n",
    );
  });
});

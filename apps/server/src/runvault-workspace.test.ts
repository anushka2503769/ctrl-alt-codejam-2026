import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isDependencyFile,
  isProtectedRunVaultPath,
  RunVaultWorkspaceManager,
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

describe("RunVaultWorkspaceManager", () => {
  it("copies a trusted workspace without exposing reserved metadata", async () => {
    await mkdir(path.join(trusted, "src"));
    await writeFile(path.join(trusted, "src", "index.ts"), "export const one = 1;\n");
    await mkdir(path.join(trusted, "node_modules"));
    await writeFile(path.join(trusted, "node_modules", "fixture.js"), "module.exports = 1;\n");
    await mkdir(path.join(trusted, ".codex"));
    await writeFile(path.join(trusted, ".codex", "session.json"), "secret metadata");

    const staging = await stage();

    await expect(readFile(path.join(staging.path, "src", "index.ts"), "utf8"))
      .resolves.toBe("export const one = 1;\n");
    await expect(readFile(path.join(staging.path, "node_modules", "fixture.js"), "utf8"))
      .resolves.toContain("module.exports");
    await expect(lstat(path.join(staging.path, ".codex"))).rejects.toMatchObject({
      code: "ENOENT",
    });
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

  it.each([
    [".env", true],
    [".env.local", true],
    ["AGENTS.md", true],
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

    await manager.rollbackPromotion(promotion);
    expect(await readFile(path.join(trusted, "state.txt"), "utf8")).toBe("trusted\n");
    expect(await readFile(path.join(staging.path, "state.txt"), "utf8")).toBe("staged\n");
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

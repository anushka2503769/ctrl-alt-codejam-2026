import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("loads existing version-one runs with an empty RunVault decision", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 1,
        agents: [],
        messages: [],
        runs: [
          {
            id: "run-1",
            agentId: "agent-1",
            status: "completed",
            prompt: "legacy run",
            output: "done",
            error: null,
            usage: null,
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:01.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const store = new JsonStore(databasePath);
    await store.initialize();

    expect(store.snapshot().runs[0]?.runVault).toBeNull();
  });

  it("adds lifecycle evidence defaults to older RunVault decisions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 1,
        agents: [],
        messages: [],
        runs: [
          {
            id: "run-1",
            agentId: "agent-1",
            status: "completed",
            prompt: "legacy quarantined run",
            output: "done",
            error: null,
            usage: null,
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:01.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
            runVault: {
              outcome: "quarantined",
              reason: "protected_path",
              stagingWorkspaceId: "run-1",
              provisionalThreadId: "thread-1",
              changedFiles: {
                addedCount: 1,
                modifiedCount: 0,
                deletedCount: 0,
                protectedPathsTouched: ["deploy/app.yml"],
              },
              verification: {
                status: "passed",
                command: "npm test",
                redactedSummary: "passed",
              },
              trustedWorkspaceChanged: false,
              decidedAt: "2026-01-01T00:00:01.000Z",
            },
          },
        ],
      }),
      "utf8",
    );

    const store = new JsonStore(databasePath);
    await store.initialize();

    expect(store.snapshot().runs[0]?.runVault).toMatchObject({
      resolution: "policy",
      trustedWorkspaceFingerprint: null,
      stagingWorkspaceFingerprint: null,
      findings: [],
      changedFiles: { files: [], omittedFileCount: 0 },
    });
  });

  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });
});

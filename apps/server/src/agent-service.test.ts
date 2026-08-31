import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import {
  DependencyCacheUnavailableError,
  DependencyManager,
  type DependencyResolution,
} from "./dependency-manager.js";
import { RunCancelledError, RunTimedOutError } from "./errors.js";
import { RunVaultVerifier } from "./runvault-verifier.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import {
  RunVaultWorkspaceManager,
  type RunVaultPromotion,
} from "./runvault-workspace.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class BlockingFinalizeWorkspaceManager extends RunVaultWorkspaceManager {
  private signalFinalizeStarted!: () => void;
  private allowFinalizeToContinue!: () => void;
  readonly finalizeStarted: Promise<void>;
  private readonly finalizeAllowed: Promise<void>;

  constructor(workspaceRoot: string) {
    super(workspaceRoot);
    this.finalizeStarted = new Promise((resolve) => {
      this.signalFinalizeStarted = resolve;
    });
    this.finalizeAllowed = new Promise((resolve) => {
      this.allowFinalizeToContinue = resolve;
    });
  }

  allowFinalize(): void {
    this.allowFinalizeToContinue();
  }

  override async finalizePromotion(promotion: RunVaultPromotion): Promise<void> {
    this.signalFinalizeStarted();
    await this.finalizeAllowed;
    await super.finalizePromotion(promotion);
  }
}

class BlockingBeginPromotionWorkspaceManager extends RunVaultWorkspaceManager {
  private signalBeginStarted!: () => void;
  private allowBeginToContinue!: () => void;
  readonly beginStarted: Promise<void>;
  private readonly beginAllowed: Promise<void>;

  constructor(workspaceRoot: string) {
    super(workspaceRoot);
    this.beginStarted = new Promise((resolve) => {
      this.signalBeginStarted = resolve;
    });
    this.beginAllowed = new Promise((resolve) => {
      this.allowBeginToContinue = resolve;
    });
  }

  allowBegin(): void {
    this.allowBeginToContinue();
  }

  override async beginPromotion(
    id: string,
    trustedWorkspacePath: string,
    expectedTrustedFingerprint: string,
  ): Promise<RunVaultPromotion> {
    this.signalBeginStarted();
    await this.beginAllowed;
    return super.beginPromotion(
      id,
      trustedWorkspacePath,
      expectedTrustedFingerprint,
    );
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeServiceHarness(
  runner: AgentRunner = new FakeRunner(),
  createRunVaultWorkspaces: (workspaceRoot: string) => RunVaultWorkspaceManager =
    (workspaceRoot) => new RunVaultWorkspaceManager(workspaceRoot),
  verifier?: RunVaultVerifier,
  dependencies?: DependencyManager,
  environment: NodeJS.ProcessEnv = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const workspaceRoot = path.join(root, "workspaces");
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: workspaceRoot,
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    VERIFICATION_PROVIDER: "host",
    ...environment,
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(workspaceRoot);
  const runVaultWorkspaces = createRunVaultWorkspaces(workspaceRoot);
  const service = new AgentService(
    config,
    store,
    workspaces,
    runner,
    runVaultWorkspaces,
    verifier,
    dependencies,
  );
  await service.initialize();
  return { config, root, runVaultWorkspaces, service, store };
}

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  return (await makeServiceHarness(runner)).service;
}

async function trustedFingerprint(workspacePath: string): Promise<string> {
  const manager = new RunVaultWorkspaceManager(path.dirname(workspacePath));
  return (await manager.snapshotWorkspace(workspacePath)).fingerprint;
}

function fakeDependencyManager(
  resolve: (workspacePath: string) => Promise<DependencyResolution>,
  prepare = async () => ({
    status: "prepared" as const,
    cacheKey: "a".repeat(64),
  }),
): DependencyManager {
  return {
    initialize: async () => undefined,
    resolve,
    prepare,
  } as unknown as DependencyManager;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
    expect(service.getRun(run.id).runVault).toMatchObject({
      outcome: "promoted",
      reason: "verified_safe",
    });
  });

  it("passes the same managed dependency cache to Agent and verification", async () => {
    const cachePath = `/host/dependencies/${"a".repeat(64)}/node_modules`;
    const requests: RunnerRequest[] = [];
    const verificationOptions: Array<{ dependencyCachePath: string | null }> = [];
    const runner: AgentRunner = {
      run: async (request) => {
        requests.push(request);
        return { output: "done", threadId: "dependency-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const verifier = new RunVaultVerifier({
      runner: {
        run: async (_workspacePath, options) => {
          verificationOptions.push(options);
          return {
            status: "passed",
            command: "npm test",
            redactedSummary: "passed",
            exitCode: 0,
            timedOut: false,
          };
        },
      },
    });
    const dependencies = fakeDependencyManager(async () => ({
      status: "available",
      cacheKey: "a".repeat(64),
      mountPath: cachePath,
      message: "available",
    }));
    const harness = await makeServiceHarness(
      runner,
      undefined,
      verifier,
      dependencies,
    );
    const agent = await harness.service.createAgent({ name: "Cache user" });
    await writeFile(
      path.join(agent.workspacePath, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    await writeFile(
      path.join(agent.workspacePath, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3 }),
    );

    const { run } = await harness.service.sendMessage(agent.id, "use dependencies");
    await expect.poll(() => harness.service.getRun(run.id).status).toBe("completed");

    expect(requests[0]?.dependencyCachePath).toBe(cachePath);
    expect(verificationOptions[0]?.dependencyCachePath).toBe(cachePath);
  });

  it("fails before Agent execution when a required cache is missing", async () => {
    const run = vi.fn(async () => ({
      output: "should not run",
      threadId: "unexpected-thread",
      usage: null,
    }));
    const dependencies = fakeDependencyManager(async () => ({
      status: "missing",
      cacheKey: "b".repeat(64),
      mountPath: null,
      message: "No matching managed dependency cache is prepared.",
    }));
    const harness = await makeServiceHarness(
      { run, cancel: async () => false, isAvailable: async () => true },
      undefined,
      undefined,
      dependencies,
    );
    const agent = await harness.service.createAgent({ name: "Missing cache" });
    const result = await harness.service.sendMessage(agent.id, "run");
    await expect.poll(() => harness.service.getRun(result.run.id).status).toBe("failed");

    expect(run).not.toHaveBeenCalled();
    expect(harness.service.getRun(result.run.id).error).toContain(
      "Prepare dependencies explicitly",
    );
  });

  it("prepares dependencies explicitly and releases the Agent reservation", async () => {
    const prepare = vi.fn(async () => ({
      status: "prepared" as const,
      cacheKey: "d".repeat(64),
    }));
    const dependencies = fakeDependencyManager(
      async () => ({
        status: "missing",
        cacheKey: "d".repeat(64),
        mountPath: null,
        message: "missing",
      }),
      prepare,
    );
    const harness = await makeServiceHarness(
      undefined,
      undefined,
      undefined,
      dependencies,
    );
    const agent = await harness.service.createAgent({ name: "Preparer" });

    await expect(
      harness.service.prepareDependencies(agent.id, true),
    ).resolves.toEqual({ status: "prepared", cacheKey: "d".repeat(64) });
    expect(prepare).toHaveBeenCalledWith(agent.workspacePath, true);
    expect(harness.service.getAgent(agent.id).status).toBe("ready");
  });

  it("returns a client error when dependency preparation cannot describe manifests", async () => {
    const dependencies = fakeDependencyManager(
      async () => ({
        status: "missing",
        cacheKey: null,
        mountPath: null,
        message: "missing",
      }),
      async () => {
        throw new DependencyCacheUnavailableError("package.json could not be parsed");
      },
    );
    const harness = await makeServiceHarness(
      undefined,
      undefined,
      undefined,
      dependencies,
    );
    const agent = await harness.service.createAgent({ name: "Bad manifest" });

    await expect(harness.service.prepareDependencies(agent.id, true)).rejects
      .toMatchObject({ statusCode: 409 });
    expect(harness.service.getAgent(agent.id).status).toBe("ready");
  });

  it("never verifies with stale dependencies after a lockfile change", async () => {
    let resolutionCall = 0;
    const dependencies = fakeDependencyManager(async () => {
      resolutionCall += 1;
      return resolutionCall === 1
        ? {
            status: "available" as const,
            cacheKey: "a".repeat(64),
            mountPath: `/cache/${"a".repeat(64)}/node_modules`,
            message: "available",
          }
        : {
            status: "missing" as const,
            cacheKey: "b".repeat(64),
            mountPath: null,
            message: "No matching managed dependency cache is prepared.",
          };
    });
    const verify = vi.fn(async () => ({
      status: "passed" as const,
      command: "npm test",
      redactedSummary: "passed",
      exitCode: 0,
      timedOut: false,
    }));
    const runner: AgentRunner = {
      run: async (request) => {
        await writeFile(
          path.join(request.workspacePath, "package-lock.json"),
          JSON.stringify({ lockfileVersion: 3, changed: true }),
        );
        return { output: "updated lock", threadId: "lock-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const harness = await makeServiceHarness(
      runner,
      undefined,
      new RunVaultVerifier({ runner: { run: verify } }),
      dependencies,
    );
    const agent = await harness.service.createAgent({ name: "Lock updater" });
    await writeFile(
      path.join(agent.workspacePath, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    await writeFile(
      path.join(agent.workspacePath, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3 }),
    );

    const { run } = await harness.service.sendMessage(agent.id, "update lock");
    await expect.poll(() => harness.service.getRun(run.id).status).toBe("completed");

    expect(verify).not.toHaveBeenCalled();
    expect(harness.service.getRun(run.id).runVault).toMatchObject({
      outcome: "quarantined",
      reason: "dependency_change",
      verification: {
        status: "unavailable",
        redactedSummary: expect.stringContaining("stale dependencies"),
      },
    });
  });

  it("preserves trusted Git metadata across an automatically promoted Run", async () => {
    const service = await makeService({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "source.ts"), "promoted\n");
        return {
          output: "Updated source",
          threadId: "git-preserving-thread",
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Repository builder" });
    await mkdir(path.join(agent.workspacePath, ".git"));
    await writeFile(
      path.join(agent.workspacePath, ".git", "config"),
      "[core]\nrepositoryformatversion = 0\n",
    );

    const { run } = await service.sendMessage(agent.id, "update source");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(service.getRun(run.id).runVault?.outcome).toBe("promoted");
    await expect(
      readFile(path.join(agent.workspacePath, ".git", "config"), "utf8"),
    ).resolves.toContain("repositoryformatversion");
    await expect(
      readFile(path.join(agent.workspacePath, "source.ts"), "utf8"),
    ).resolves.toBe("promoted\n");
  });

  it("includes verifier-created source changes in final inspection", async () => {
    const verifier = new RunVaultVerifier({
      runner: {
        run: async (workspacePath) => {
          await writeFile(
            path.join(workspacePath, "verification-generated.ts"),
            "export const verified = true;\n",
          );
          return {
            status: "passed",
            command: "npm test",
            redactedSummary: "Tests passed.",
            exitCode: 0,
            timedOut: false,
          };
        },
      },
    });
    const harness = await makeServiceHarness(
      new FakeRunner(),
      (workspaceRoot) => new RunVaultWorkspaceManager(workspaceRoot),
      verifier,
    );
    const agent = await harness.service.createAgent({ name: "Verifier writer" });
    await writeFile(
      path.join(agent.workspacePath, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );

    const { run } = await harness.service.sendMessage(agent.id, "verify source");
    await expect.poll(() => harness.service.getRun(run.id).status).toBe("completed");

    expect(harness.service.getRun(run.id).runVault).toMatchObject({
      outcome: "promoted",
      changedFiles: {
        addedCount: 1,
        files: [{ path: "verification-generated.ts", kind: "added" }],
      },
    });
    await expect(
      readFile(path.join(agent.workspacePath, "verification-generated.ts"), "utf8"),
    ).resolves.toBe("export const verified = true;\n");
  });

  it("forks only from the last promoted thread after a discarded Run", async () => {
    const baseThreadIds: Array<string | null> = [];
    let call = 0;
    const service = await makeService({
      run: async (request) => {
        baseThreadIds.push(request.threadId);
        call += 1;
        if (call === 2) {
          await writeFile(path.join(request.workspacePath, "discarded.ts"), "discarded\n");
        }
        return {
          output: `Result ${call}`,
          threadId: `provisional-thread-${call}`,
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Threaded builder" });

    const first = await service.sendMessage(agent.id, "first safe run");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    expect(service.getAgent(agent.id).codexThreadId).toBe("provisional-thread-1");

    await writeFile(
      path.join(agent.workspacePath, "package.json"),
      JSON.stringify({ scripts: { test: `node -e "process.exit(1)"` } }),
    );
    const second = await service.sendMessage(agent.id, "discard this run");
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");
    expect(service.getRun(second.run.id).runVault).toMatchObject({
      outcome: "discarded",
      provisionalThreadId: "provisional-thread-2",
    });
    expect(service.getAgent(agent.id).codexThreadId).toBe("provisional-thread-1");

    await writeFile(
      path.join(agent.workspacePath, "package.json"),
      JSON.stringify({ scripts: { test: `node -e "process.exit(0)"` } }),
    );
    const third = await service.sendMessage(agent.id, "next safe run");
    await expect.poll(() => service.getRun(third.run.id).status).toBe("completed");

    expect(baseThreadIds).toEqual([
      null,
      "provisional-thread-1",
      "provisional-thread-1",
    ]);
    expect(service.getAgent(agent.id).codexThreadId).toBe("provisional-thread-3");
    expect(service.getMessages(agent.id).map((message) => message.content)).not
      .toContain("Result 2");
    await expect(lstat(path.join(agent.workspacePath, "discarded.ts"))).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("fails closed if a runner returns the committed thread as provisional", async () => {
    let call = 0;
    const service = await makeService({
      run: async (request) => {
        call += 1;
        if (call === 2) {
          await writeFile(path.join(request.workspacePath, "leaked.ts"), "unsafe\n");
        }
        return {
          output: `Result ${call}`,
          threadId: request.threadId ?? "committed-thread",
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Strict thread builder" });
    const first = await service.sendMessage(agent.id, "establish thread");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");

    const second = await service.sendMessage(agent.id, "invalid continuation");
    await expect.poll(() => service.getRun(second.run.id).status).toBe("failed");

    expect(service.getRun(second.run.id).runVault).toMatchObject({
      outcome: "discarded",
      reason: "run_failed",
    });
    expect(service.getRun(second.run.id).error).toContain(
      "distinct provisional thread",
    );
    expect(service.getAgent(agent.id).codexThreadId).toBe("committed-thread");
    await expect(lstat(path.join(agent.workspacePath, "leaked.ts"))).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("runs the Agent in staging and promotes a safe source change", async () => {
    let runnerWorkspace = "";
    const service = await makeService({
      run: async (request) => {
        runnerWorkspace = request.workspacePath;
        await mkdir(path.join(request.workspacePath, "src"));
        await writeFile(
          path.join(request.workspacePath, "src", "safe.ts"),
          "export const safe = true;\n",
        );
        return { output: "Added safe source", threadId: "safe-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Safe builder" });

    const { run } = await service.sendMessage(agent.id, "add safe source");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(runnerWorkspace).not.toBe(agent.workspacePath);
    expect(runnerWorkspace).toContain(path.join(".staging", run.id));
    expect(await readFile(path.join(agent.workspacePath, "src", "safe.ts"), "utf8"))
      .toBe("export const safe = true;\n");
    expect(service.getRun(run.id).runVault).toMatchObject({
      outcome: "promoted",
      reason: "verified_safe",
      changedFiles: { addedCount: 1 },
    });
    expect(service.getAgent(agent.id).codexThreadId).toBe("safe-thread");
  });

  it("promotes a safe change only after configured tests pass", async () => {
    const service = await makeService({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "source.ts"), "updated\n");
        return { output: "Updated source", threadId: "tested-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Tested builder" });
    await writeFile(
      path.join(agent.workspacePath, "package.json"),
      JSON.stringify({ scripts: { test: `node -e "console.log('tests pass')"` } }),
    );
    await writeFile(path.join(agent.workspacePath, "source.ts"), "original\n");

    const { run } = await service.sendMessage(agent.id, "update source");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(service.getRun(run.id).runVault).toMatchObject({
      outcome: "promoted",
      verification: { status: "passed", command: "npm test" },
    });
    expect(await readFile(path.join(agent.workspacePath, "source.ts"), "utf8"))
      .toBe("updated\n");
  });

  it("publishes completion only after promotion cleanup finishes", async () => {
    let runVaultWorkspaces!: BlockingFinalizeWorkspaceManager;
    const harness = await makeServiceHarness(
      {
        run: async (request) => {
          await writeFile(path.join(request.workspacePath, "source.ts"), "updated\n");
          return {
            output: "Updated source",
            threadId: "finalized-thread",
            usage: null,
          };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      (workspaceRoot) => {
        runVaultWorkspaces = new BlockingFinalizeWorkspaceManager(workspaceRoot);
        return runVaultWorkspaces;
      },
    );
    const agent = await harness.service.createAgent({ name: "Atomic builder" });
    await writeFile(path.join(agent.workspacePath, "source.ts"), "original\n");

    const { run } = await harness.service.sendMessage(agent.id, "update atomically");
    await runVaultWorkspaces.finalizeStarted;

    try {
      expect(harness.service.getRun(run.id)).toMatchObject({
        status: "running",
        runVault: { outcome: "promoted" },
      });
      expect(harness.service.getAgent(agent.id).status).toBe("busy");
      await expect(
        lstat(runVaultWorkspaces.promotionMarkerPath(run.id)),
      ).resolves.toBeDefined();
    } finally {
      runVaultWorkspaces.allowFinalize();
      await expect
        .poll(() => harness.service.getRun(run.id).status)
        .toBe("completed");
    }

    expect(harness.service.getAgent(agent.id).status).toBe("ready");
    await expect(
      lstat(runVaultWorkspaces.promotionMarkerPath(run.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("promotes a safe documentation-only change", async () => {
    const service = await makeService({
      run: async (request) => {
        await writeFile(
          path.join(request.workspacePath, "README.md"),
          "# Generated documentation\n",
        );
        return { output: "Added documentation", threadId: "docs-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Documentation builder" });

    const { run } = await service.sendMessage(agent.id, "document this workspace");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(service.getRun(run.id).runVault).toMatchObject({
      outcome: "promoted",
      reason: "verified_safe",
      verification: { status: "skipped" },
    });
    expect(await readFile(path.join(agent.workspacePath, "README.md"), "utf8"))
      .toBe("# Generated documentation\n");
  });

  it("quarantines a secret-like file without persisting its contents", async () => {
    const secret = "RUNVAULT_TEST_SECRET=never-expose-this-value\n";
    const service = await makeService({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, ".env"), secret);
        return { output: "Prepared local config", threadId: "secret-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Secret-aware builder" });
    const before = await trustedFingerprint(agent.workspacePath);

    const { run } = await service.sendMessage(agent.id, "prepare local secrets");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const completed = service.getRun(run.id);
    expect(completed.runVault).toMatchObject({
      outcome: "quarantined",
      reason: "protected_path",
      changedFiles: { protectedPathsTouched: [".env"] },
    });
    expect(JSON.stringify(completed.runVault)).not.toContain("never-expose-this-value");
    expect(await trustedFingerprint(agent.workspacePath)).toBe(before);
    await expect(lstat(path.join(agent.workspacePath, ".env"))).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("quarantines a Run that exceeds the changed-file limit", async () => {
    const service = await makeService({
      run: async (request) => {
        await Promise.all(
          Array.from({ length: 21 }, (_, index) =>
            writeFile(
              path.join(request.workspacePath, `generated-${index}.ts`),
              `export const generated${index} = true;\n`,
            ),
          ),
        );
        return { output: "Generated files", threadId: "large-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Bounded builder" });
    const before = await trustedFingerprint(agent.workspacePath);

    const { run } = await service.sendMessage(agent.id, "generate many files");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(service.getRun(run.id).runVault).toMatchObject({
      outcome: "quarantined",
      reason: "change_limit_exceeded",
      changedFiles: { addedCount: 21 },
    });
    expect(await trustedFingerprint(agent.workspacePath)).toBe(before);
    await expect(lstat(path.join(agent.workspacePath, "generated-0.ts"))).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("quarantines dependency metadata without changing trusted files", async () => {
    const service = await makeService({
      run: async (request) => {
        await writeFile(
          path.join(request.workspacePath, "package-lock.json"),
          JSON.stringify({ lockfileVersion: 3 }),
        );
        return {
          output: "Prepared dependency metadata",
          threadId: "dependency-thread",
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Dependency builder" });
    const before = await trustedFingerprint(agent.workspacePath);

    const { run } = await service.sendMessage(agent.id, "update dependencies");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(service.getRun(run.id).runVault).toMatchObject({
      outcome: "quarantined",
      reason: "dependency_change",
      changedFiles: { addedCount: 1 },
    });
    expect(await trustedFingerprint(agent.workspacePath)).toBe(before);
    await expect(lstat(path.join(agent.workspacePath, "package-lock.json"))).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("quarantines protected changes and leaves trusted files unchanged", async () => {
    const service = await makeService({
      run: async (request) => {
        await mkdir(path.join(request.workspacePath, "deploy"));
        await writeFile(path.join(request.workspacePath, "deploy", "app.yml"), "risk\n");
        return { output: "Changed deployment", threadId: "risky-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Protected builder" });

    const { run } = await service.sendMessage(agent.id, "change deployment");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const decision = service.getRun(run.id).runVault;
    expect(decision).toMatchObject({
      outcome: "quarantined",
      reason: "protected_path",
      changedFiles: { protectedPathsTouched: ["deploy/app.yml"] },
    });
    await expect(lstat(path.join(agent.workspacePath, "deploy"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      lstat(path.join(path.dirname(agent.workspacePath), ".staging", run.id)),
    ).resolves.toBeDefined();
    expect(service.getAgent(agent.id).codexThreadId).toBeNull();
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual(["user"]);
  });

  it("revalidates retained review state and serves only safe recorded diffs", async () => {
    const service = await makeService({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "package-lock.json"), "staged\n");
        await writeFile(path.join(request.workspacePath, "large.txt"), "x".repeat(70_000));
        await writeFile(
          path.join(request.workspacePath, "binary.dat"),
          Buffer.from([0, 1, 2, 3]),
        );
        await mkdir(path.join(request.workspacePath, "deploy"));
        await writeFile(
          path.join(request.workspacePath, "deploy", "secret.txt"),
          "PROTECTED-CONTENT\n",
        );
        return { output: "Prepared review", threadId: "review-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Review builder" });
    await writeFile(path.join(agent.workspacePath, "package-lock.json"), "trusted\n");
    const { run } = await service.sendMessage(agent.id, "prepare review");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    await expect(service.getRunVaultReview(run.id)).resolves.toMatchObject({
      availability: "available",
      stagingFingerprintVerified: true,
      trustedFingerprintVerified: true,
    });
    await expect(
      service.getRunVaultDiff(run.id, "package-lock.json"),
    ).resolves.toMatchObject({
      status: "available",
      diff: expect.stringContaining("-trusted"),
    });
    const protectedDiff = await service.getRunVaultDiff(
      run.id,
      "deploy/secret.txt",
    );
    expect(protectedDiff).toEqual({
      path: "deploy/secret.txt",
      status: "protected",
      diff: null,
      truncated: false,
    });
    expect(JSON.stringify(protectedDiff)).not.toContain("PROTECTED-CONTENT");
    await expect(service.getRunVaultDiff(run.id, "large.txt")).resolves.toMatchObject({
      status: "too_large",
      diff: null,
    });
    await expect(service.getRunVaultDiff(run.id, "binary.dat")).resolves.toMatchObject({
      status: "binary",
      diff: null,
    });
    await expect(
      service.getRunVaultDiff(run.id, "../deploy/secret.txt"),
    ).rejects.toMatchObject({ statusCode: 400 });

    const stagingPath = path.join(
      path.dirname(agent.workspacePath),
      ".staging",
      run.id,
    );
    await writeFile(path.join(stagingPath, "package-lock.json"), "tampered\n");
    await expect(service.getRunVaultReview(run.id)).resolves.toMatchObject({
      availability: "staging_tampered",
      stagingFingerprintVerified: false,
    });
    await expect(
      service.getRunVaultDiff(run.id, "package-lock.json"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("approves quarantined work exactly once and commits its thread", async () => {
    const service = await makeService({
      run: async (request) => {
        await mkdir(path.join(request.workspacePath, "deploy"));
        await writeFile(path.join(request.workspacePath, "deploy", "app.yml"), "approved\n");
        return {
          output: "Prepared deployment",
          threadId: "approved-thread",
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Approval builder" });
    const { run } = await service.sendMessage(agent.id, "prepare deployment");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const approved = await service.approveRun(run.id);
    const repeated = await service.approveRun(run.id);

    expect(approved.runVault).toMatchObject({
      outcome: "promoted",
      reason: "protected_path",
      resolution: "human_approved",
    });
    expect(repeated).toEqual(approved);
    expect(await readFile(path.join(agent.workspacePath, "deploy", "app.yml"), "utf8"))
      .toBe("approved\n");
    expect(service.getAgent(agent.id).codexThreadId).toBe("approved-thread");
    expect(
      service.getMessages(agent.id).filter((message) => message.role === "assistant"),
    ).toHaveLength(1);
    await expect(service.discardRun(run.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("never approves Agent-created Git metadata", async () => {
    const service = await makeService({
      run: async (request) => {
        await mkdir(path.join(request.workspacePath, ".git"));
        return {
          output: "Created repository metadata",
          threadId: "git-metadata-thread",
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Metadata builder" });
    const { run } = await service.sendMessage(agent.id, "initialize git");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(service.getRun(run.id).runVault).toMatchObject({
      outcome: "quarantined",
      reason: "protected_path",
      changedFiles: {
        files: [{ path: ".git", kind: "added", protected: true }],
      },
    });
    await expect(service.approveRun(run.id)).rejects.toMatchObject({
      statusCode: 409,
      message:
        "Agent-created Git or dependency metadata cannot be approved; request a revision that removes it",
    });
    await expect(lstat(path.join(agent.workspacePath, ".git"))).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("creates an independently inspected child revision from retained work", async () => {
    let call = 0;
    const seenBaseThreads: Array<string | null> = [];
    const service = await makeService({
      run: async (request) => {
        call += 1;
        seenBaseThreads.push(request.threadId);
        if (call === 1) {
          await mkdir(path.join(request.workspacePath, "deploy"));
          await writeFile(path.join(request.workspacePath, "deploy", "app.yml"), "risk\n");
          return { output: "Prepared risky work", threadId: "parent-thread", usage: null };
        }
        await expect(
          readFile(path.join(request.workspacePath, "deploy", "app.yml"), "utf8"),
        ).resolves.toBe("risk\n");
        const { rm } = await import("node:fs/promises");
        await rm(path.join(request.workspacePath, "deploy"), { recursive: true });
        await mkdir(path.join(request.workspacePath, "src"));
        await writeFile(path.join(request.workspacePath, "src", "safe.ts"), "export {};\n");
        return { output: "Revised safely", threadId: "child-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Revision builder" });
    const { run: parent } = await service.sendMessage(agent.id, "prepare deployment");
    await expect.poll(() => service.getRun(parent.id).status).toBe("completed");

    const { run: child } = await service.requestRevision(
      parent.id,
      "Remove the deployment change and use safe source code",
    );
    await expect.poll(() => service.getRun(child.id).status).toBe("completed");

    expect(seenBaseThreads).toEqual([null, "parent-thread"]);
    expect(service.getRun(child.id)).toMatchObject({
      parentRunId: parent.id,
      revisionNumber: 1,
      runVault: { outcome: "promoted", reason: "verified_safe" },
    });
    expect(service.getRun(parent.id)).toMatchObject({
      supersededByRunId: child.id,
      runVault: { outcome: "quarantined", reason: "protected_path" },
    });
    expect(service.getAgent(agent.id).codexThreadId).toBe("child-thread");
    await expect(
      readFile(path.join(agent.workspacePath, "src", "safe.ts"), "utf8"),
    ).resolves.toBe("export {};\n");
    await expect(lstat(path.join(agent.workspacePath, "deploy"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      lstat(path.join(path.dirname(agent.workspacePath), ".staging", parent.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps parent evidence and staging when a revision fails", async () => {
    let call = 0;
    const service = await makeService({
      run: async (request) => {
        call += 1;
        if (call === 1) {
          await mkdir(path.join(request.workspacePath, "deploy"));
          await writeFile(path.join(request.workspacePath, "deploy", "app.yml"), "risk\n");
          return { output: "Parent proposal", threadId: "parent-failure-thread", usage: null };
        }
        throw new Error("revision failed");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Failed revision" });
    const { run: parent } = await service.sendMessage(agent.id, "prepare risk");
    await expect.poll(() => service.getRun(parent.id).status).toBe("completed");
    const originalDecision = structuredClone(service.getRun(parent.id).runVault);

    const { run: child } = await service.requestRevision(parent.id, "fix it");
    await expect.poll(() => service.getRun(child.id).status).toBe("failed");

    expect(service.getRun(parent.id).runVault).toEqual(originalDecision);
    expect(service.getRun(parent.id).supersededByRunId).toBe(child.id);
    expect(service.getAgent(agent.id).codexThreadId).toBeNull();
    await expect(
      lstat(path.join(path.dirname(agent.workspacePath), ".staging", parent.id)),
    ).resolves.toBeDefined();
    await expect(lstat(path.join(agent.workspacePath, "deploy"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("discards quarantined work idempotently without committing its thread", async () => {
    const service = await makeService({
      run: async (request) => {
        await mkdir(path.join(request.workspacePath, "deploy"));
        await writeFile(path.join(request.workspacePath, "deploy", "app.yml"), "discard\n");
        return {
          output: "Prepared risky deployment",
          threadId: "discarded-thread",
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Discard builder" });
    const { run } = await service.sendMessage(agent.id, "prepare risky deployment");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const discarded = await service.discardRun(run.id);
    const repeated = await service.discardRun(run.id);

    expect(discarded.runVault).toMatchObject({
      outcome: "discarded",
      reason: "protected_path",
      resolution: "human_discarded",
    });
    expect(repeated).toEqual(discarded);
    expect(service.getAgent(agent.id).codexThreadId).toBeNull();
    await expect(lstat(path.join(agent.workspacePath, "deploy"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      lstat(path.join(path.dirname(agent.workspacePath), ".staging", run.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(service.approveRun(run.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("removes retained quarantined staging when its Agent is deleted", async () => {
    const service = await makeService({
      run: async (request) => {
        await mkdir(path.join(request.workspacePath, "deploy"));
        await writeFile(path.join(request.workspacePath, "deploy", "app.yml"), "retained\n");
        return { output: "Prepared deployment", threadId: "deleted-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Deleted quarantine" });
    const { run } = await service.sendMessage(agent.id, "prepare deployment");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const stagingPath = path.join(path.dirname(agent.workspacePath), ".staging", run.id);
    await expect(lstat(stagingPath)).resolves.toBeDefined();

    await service.deleteAgent(agent.id);

    await expect(lstat(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses approval after the trusted workspace changes", async () => {
    const service = await makeService({
      run: async (request) => {
        await mkdir(path.join(request.workspacePath, "deploy"));
        await writeFile(path.join(request.workspacePath, "deploy", "app.yml"), "staged\n");
        return { output: "Prepared deployment", threadId: "stale-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Stale approval builder" });
    const { run } = await service.sendMessage(agent.id, "prepare deployment");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    await writeFile(path.join(agent.workspacePath, "external.txt"), "keep me\n");

    await expect(service.approveRun(run.id)).rejects.toMatchObject({ statusCode: 409 });

    expect(service.getRun(run.id).runVault).toMatchObject({
      outcome: "quarantined",
      reason: "trusted_workspace_changed",
      trustedWorkspaceChanged: true,
    });
    expect(await readFile(path.join(agent.workspacePath, "external.txt"), "utf8"))
      .toBe("keep me\n");
    await expect(lstat(path.join(agent.workspacePath, "deploy"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(service.getAgent(agent.id).status).toBe("ready");
  });

  it("refuses approval if quarantined staging files were modified", async () => {
    const service = await makeService({
      run: async (request) => {
        await mkdir(path.join(request.workspacePath, "deploy"));
        await writeFile(path.join(request.workspacePath, "deploy", "app.yml"), "inspected\n");
        return { output: "Prepared deployment", threadId: "tampered-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Tamper-aware builder" });
    const { run } = await service.sendMessage(agent.id, "prepare deployment");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const stagingPath = path.join(path.dirname(agent.workspacePath), ".staging", run.id);
    await writeFile(path.join(stagingPath, "uninspected.txt"), "tampered\n");

    await expect(service.approveRun(run.id)).rejects.toMatchObject({ statusCode: 409 });

    expect(service.getRun(run.id).runVault?.outcome).toBe("quarantined");
    await expect(lstat(path.join(agent.workspacePath, "deploy"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(service.getAgent(agent.id).status).toBe("ready");
  });

  it("rejects lifecycle actions for an automatically promoted Run", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Already safe" });
    const { run } = await service.sendMessage(agent.id, "safe run");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    await expect(service.approveRun(run.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.discardRun(run.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("discards staged work when verification fails", async () => {
    const service = await makeService({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "source.ts"), "broken\n");
        return { output: "Changed source", threadId: "failed-test-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Broken builder" });
    await writeFile(
      path.join(agent.workspacePath, "package.json"),
      JSON.stringify({ scripts: { test: `node -e "process.exit(1)"` } }),
    );
    await writeFile(path.join(agent.workspacePath, "source.ts"), "trusted\n");

    const { run } = await service.sendMessage(agent.id, "break source");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(service.getRun(run.id).runVault).toMatchObject({
      outcome: "discarded",
      reason: "verification_failed",
      verification: { status: "failed" },
    });
    expect(await readFile(path.join(agent.workspacePath, "source.ts"), "utf8"))
      .toBe("trusted\n");
    await expect(
      lstat(path.join(path.dirname(agent.workspacePath), ".staging", run.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(service.getAgent(agent.id).codexThreadId).toBeNull();
  });

  it("discards partial files after runner failure", async () => {
    const service = await makeService({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "partial.txt"), "partial\n");
        throw new Error("runner exploded");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Failing builder" });

    const { run } = await service.sendMessage(agent.id, "fail midway");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    expect(service.getRun(run.id).runVault).toMatchObject({
      outcome: "discarded",
      reason: "run_failed",
      changedFiles: { addedCount: 1 },
    });
    await expect(lstat(path.join(agent.workspacePath, "partial.txt"))).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("records a typed runner timeout and discards partial files", async () => {
    const service = await makeService({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "partial.txt"), "partial\n");
        throw new RunTimedOutError("runner timed out");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Timed builder" });

    const { run } = await service.sendMessage(agent.id, "take too long");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    expect(service.getRun(run.id).runVault).toMatchObject({
      outcome: "discarded",
      reason: "timed_out",
    });
    await expect(lstat(path.join(agent.workspacePath, "partial.txt"))).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("cancels an active staged Run without changing trusted files", async () => {
    let rejectRun!: (error: Error) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const service = await makeService({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "partial.txt"), "partial\n");
        signalStarted();
        return new Promise<RunnerResult>((_resolve, reject) => {
          rejectRun = reject;
        });
      },
      cancel: async () => {
        rejectRun(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Cancelled builder" });
    const { run } = await service.sendMessage(agent.id, "wait forever");
    await started;

    await service.stopAgent(agent.id);

    expect(service.getRun(run.id)).toMatchObject({
      status: "cancelled",
      runVault: { outcome: "discarded", reason: "cancelled" },
    });
    await expect(lstat(path.join(agent.workspacePath, "partial.txt"))).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("discards interrupted staging and records recovery after restart", async () => {
    const harness = await makeServiceHarness();
    const agent = await harness.service.createAgent({ name: "Restarted builder" });
    await writeFile(path.join(agent.workspacePath, "trusted.txt"), "trusted\n");
    const staging = await harness.runVaultWorkspaces.createStagingWorkspace(
      "run-restart",
      agent.workspacePath,
    );
    await writeFile(path.join(staging.path, "partial.txt"), "partial\n");
    const timestamp = "2026-01-01T00:00:00.000Z";
    await harness.store.mutate((database) => {
      const storedAgent = database.agents.find((candidate) => candidate.id === agent.id);
      if (!storedAgent) throw new Error("fixture Agent missing");
      storedAgent.status = "busy";
      database.runs.push({
        id: staging.id,
        agentId: agent.id,
        status: "running",
        prompt: "interrupted work",
        output: null,
        error: null,
        usage: null,
        runVault: null,
        startedAt: timestamp,
        completedAt: null,
        createdAt: timestamp,
      });
    });

    const restarted = new AgentService(
      harness.config,
      new JsonStore(path.join(harness.root, "data", "db.json")),
      new WorkspaceManager(path.join(harness.root, "workspaces")),
      new FakeRunner(),
      new RunVaultWorkspaceManager(path.join(harness.root, "workspaces")),
    );
    await restarted.initialize();

    expect(restarted.getRun(staging.id)).toMatchObject({
      status: "cancelled",
      error: "Server restarted while this run was active",
      runVault: {
        outcome: "discarded",
        reason: "cancelled",
        resolution: "policy",
        stagingWorkspaceId: staging.id,
        verification: { status: "skipped" },
      },
    });
    expect(restarted.getAgent(agent.id).status).toBe("ready");
    expect(await readFile(path.join(agent.workspacePath, "trusted.txt"), "utf8"))
      .toBe("trusted\n");
    await expect(lstat(staging.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finishes a committed promotion before publishing restart recovery", async () => {
    const harness = await makeServiceHarness();
    const agent = await harness.service.createAgent({ name: "Committed builder" });
    await writeFile(path.join(agent.workspacePath, "source.ts"), "original\n");
    const staging = await harness.runVaultWorkspaces.createStagingWorkspace(
      "run-committed",
      agent.workspacePath,
    );
    await writeFile(path.join(staging.path, "source.ts"), "promoted\n");
    const inspection = await harness.runVaultWorkspaces.inspectChanges(
      staging.trustedSnapshot,
      staging.path,
    );
    const promotion = await harness.runVaultWorkspaces.beginPromotion(
      staging.id,
      agent.workspacePath,
      staging.trustedSnapshot.fingerprint,
    );
    const timestamp = "2026-01-01T00:00:00.000Z";
    await harness.store.mutate((database) => {
      const storedAgent = database.agents.find((candidate) => candidate.id === agent.id);
      if (!storedAgent) throw new Error("fixture Agent missing");
      storedAgent.status = "busy";
      storedAgent.codexThreadId = "committed-thread";
      database.runs.push({
        id: staging.id,
        agentId: agent.id,
        status: "running",
        prompt: "committed work",
        output: "Committed output",
        error: null,
        usage: null,
        runVault: {
          outcome: "promoted",
          reason: "verified_safe",
          resolution: "policy",
          stagingWorkspaceId: staging.id,
          provisionalThreadId: "committed-thread",
          trustedWorkspaceFingerprint: staging.trustedSnapshot.fingerprint,
          stagingWorkspaceFingerprint: inspection.stagingFingerprint,
          changedFiles: {
            addedCount: 0,
            modifiedCount: 1,
            deletedCount: 0,
            protectedPathsTouched: [],
          },
          verification: {
            status: "skipped",
            command: null,
            redactedSummary: "No test command detected.",
          },
          trustedWorkspaceChanged: false,
          decidedAt: timestamp,
        },
        startedAt: timestamp,
        completedAt: null,
        createdAt: timestamp,
      });
    });

    const restarted = new AgentService(
      harness.config,
      new JsonStore(path.join(harness.root, "data", "db.json")),
      new WorkspaceManager(path.join(harness.root, "workspaces")),
      new FakeRunner(),
      new RunVaultWorkspaceManager(path.join(harness.root, "workspaces")),
    );
    await restarted.initialize();

    expect(restarted.getRun(staging.id)).toMatchObject({
      status: "completed",
      error: null,
      runVault: { outcome: "promoted" },
    });
    expect(restarted.getAgent(agent.id)).toMatchObject({
      status: "ready",
      codexThreadId: "committed-thread",
    });
    expect(await readFile(path.join(agent.workspacePath, "source.ts"), "utf8"))
      .toBe("promoted\n");
    await expect(lstat(promotion.backupWorkspacePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(promotion.markerPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("quarantines when trusted files change while a Run is active", async () => {
    let finish!: (result: RunnerResult) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const service = await makeService({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "source.ts"), "staged\n");
        signalStarted();
        return new Promise<RunnerResult>((resolve) => {
          finish = resolve;
        });
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Concurrent editor" });
    const { run } = await service.sendMessage(agent.id, "edit source");
    await started;
    await writeFile(path.join(agent.workspacePath, "external.txt"), "external\n");
    finish({ output: "Edited source", threadId: "provisional", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(service.getRun(run.id).runVault).toMatchObject({
      outcome: "quarantined",
      reason: "trusted_workspace_changed",
      trustedWorkspaceChanged: true,
    });
    expect(await readFile(path.join(agent.workspacePath, "external.txt"), "utf8"))
      .toBe("external\n");
    await expect(lstat(path.join(agent.workspacePath, "source.ts"))).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("quarantines a new symbolic link without executing verification", async () => {
    const service = await makeService({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "target.txt"), "target\n");
        await symlink("target.txt", path.join(request.workspacePath, "link.txt"));
        return { output: "Added link", threadId: "link-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Link builder" });
    await writeFile(
      path.join(agent.workspacePath, "package.json"),
      JSON.stringify({
        scripts: {
          test: `node -e "require('fs').writeFileSync('verification-marker', 'ran')"`,
        },
      }),
    );

    const { run } = await service.sendMessage(agent.id, "add link");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(service.getRun(run.id).runVault).toMatchObject({
      outcome: "quarantined",
      reason: "unsafe_link",
      verification: { status: "skipped" },
    });
    const stagingPath = path.join(path.dirname(agent.workspacePath), ".staging", run.id);
    await expect(lstat(path.join(stagingPath, "verification-marker"))).rejects
      .toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(agent.workspacePath, "link.txt"))).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("captures an immutable strict policy snapshot for each Run", async () => {
    let runnerStarted!: () => void;
    let finishRunner!: () => void;
    const started = new Promise<void>((resolve) => {
      runnerStarted = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      finishRunner = resolve;
    });
    const runner: AgentRunner = {
      run: async (request) => {
        runnerStarted();
        await finish;
        await writeFile(path.join(request.workspacePath, "safe.ts"), "safe\n");
        return { output: "safe change", threadId: "strict-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const harness = await makeServiceHarness(
      runner,
      undefined,
      undefined,
      undefined,
      { RUNVAULT_POLICY_PROFILE: "strict" },
    );
    const agent = await harness.service.createAgent({ name: "Strict policy" });
    const { run } = await harness.service.sendMessage(agent.id, "change safely");
    await started;

    harness.config.runVaultPolicy.profile = "standard";
    harness.config.runVaultPolicy.verificationMode = "allow-skipped";
    finishRunner();
    await expect.poll(() => harness.service.getRun(run.id).status).toBe("completed");

    expect(harness.service.getRun(run.id).runVault).toMatchObject({
      outcome: "quarantined",
      reason: "verification_required",
      verification: { status: "skipped" },
      policy: {
        profile: "strict",
        verificationMode: "require-verification",
        capturedAt: run.createdAt,
      },
      retainedAt: expect.any(String),
      expiresAt: expect.any(String),
    });
    harness.service.shutdown();
  });

  it("discards staging growth that exceeds the per-Run quota", async () => {
    const run = vi.fn(async (request: RunnerRequest) => {
      await writeFile(
        path.join(request.workspacePath, "oversized.bin"),
        Buffer.alloc(1_048_577),
      );
      return { output: "large output", threadId: "quota-thread", usage: null };
    });
    const harness = await makeServiceHarness(
      { run, cancel: async () => false, isAvailable: async () => true },
      undefined,
      undefined,
      undefined,
      {
        RUNVAULT_MAX_CHANGED_BYTES: "1048576",
        RUNVAULT_STAGING_PER_RUN_BYTES: "1048576",
        RUNVAULT_STAGING_TOTAL_BYTES: "2097152",
        RUNVAULT_QUOTA_POLL_MS: "100",
      },
    );
    const agent = await harness.service.createAgent({ name: "Quota test" });
    const { run: created } = await harness.service.sendMessage(agent.id, "grow");
    await expect.poll(() => harness.service.getRun(created.id).status).toBe("failed");

    expect(run).toHaveBeenCalledOnce();
    expect(harness.service.getRun(created.id).runVault).toMatchObject({
      outcome: "discarded",
      reason: "staging_quota_exceeded",
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "staging_quota_exceeded" }),
      ]),
      policy: { stagingPerRunBytes: 1_048_576 },
    });
    await expect(lstat(path.join(agent.workspacePath, "oversized.bin"))).rejects
      .toMatchObject({ code: "ENOENT" });
    await expect(lstat(harness.runVaultWorkspaces.stagingPath(created.id))).rejects
      .toMatchObject({ code: "ENOENT" });
    harness.service.shutdown();
  });

  it("expires quarantine idempotently without advancing its thread", async () => {
    const runner: AgentRunner = {
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, ".env"), "SECRET=value\n");
        return { output: "changed env", threadId: "expired-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const harness = await makeServiceHarness(
      runner,
      undefined,
      undefined,
      undefined,
      { RUNVAULT_QUARANTINE_RETENTION_MS: "60000" },
    );
    const agent = await harness.service.createAgent({ name: "Expiry test" });
    const { run } = await harness.service.sendMessage(agent.id, "change env");
    await expect.poll(() => harness.service.getRun(run.id).status).toBe("completed");
    const quarantined = harness.service.getRun(run.id).runVault!;
    expect(quarantined).toMatchObject({
      outcome: "quarantined",
      retainedAt: expect.any(String),
      expiresAt: expect.any(String),
    });

    const expiry = Date.parse(quarantined.expiresAt!);
    await expect(harness.service.sweepExpiredQuarantines(expiry + 1)).resolves.toBe(1);
    await expect(harness.service.sweepExpiredQuarantines(expiry + 2)).resolves.toBe(0);

    const expired = harness.service.getRun(run.id);
    expect(expired.runVault).toMatchObject({
      outcome: "discarded",
      reason: "retention_expired",
      resolution: "expired",
      provisionalThreadId: "expired-thread",
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "retention_expired" }),
      ]),
    });
    expect(JSON.stringify(expired.runVault)).not.toContain("SECRET=value");
    expect(harness.service.getAgent(agent.id).codexThreadId).toBeNull();
    await expect(lstat(harness.runVaultWorkspaces.stagingPath(run.id))).rejects
      .toMatchObject({ code: "ENOENT" });
    await expect(harness.service.approveRun(run.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(harness.service.requestRevision(run.id, "try again")).rejects
      .toMatchObject({ statusCode: 409 });
    harness.service.shutdown();
  });

  it("does not expire a quarantine while approval owns the Agent reservation", async () => {
    let runVaultWorkspaces!: BlockingBeginPromotionWorkspaceManager;
    const runner: AgentRunner = {
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, ".env"), "protected\n");
        return { output: "review me", threadId: "approved-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const harness = await makeServiceHarness(
      runner,
      (workspaceRoot) => {
        runVaultWorkspaces = new BlockingBeginPromotionWorkspaceManager(
          workspaceRoot,
        );
        return runVaultWorkspaces;
      },
      undefined,
      undefined,
      { RUNVAULT_QUARANTINE_RETENTION_MS: "60000" },
    );
    const agent = await harness.service.createAgent({ name: "Approval race" });
    const { run } = await harness.service.sendMessage(agent.id, "change env");
    await expect.poll(() => harness.service.getRun(run.id).status).toBe("completed");
    const expiresAt = Date.parse(harness.service.getRun(run.id).runVault!.expiresAt!);

    const approval = harness.service.approveRun(run.id);
    await runVaultWorkspaces.beginStarted;
    await expect(harness.service.sweepExpiredQuarantines(expiresAt + 1))
      .resolves.toBe(0);
    expect(harness.service.getRun(run.id).runVault?.outcome).toBe("quarantined");

    runVaultWorkspaces.allowBegin();
    await expect(approval).resolves.toMatchObject({
      runVault: { outcome: "promoted", resolution: "human_approved" },
    });
    await expect(harness.service.sweepExpiredQuarantines(expiresAt + 2))
      .resolves.toBe(0);
    expect(harness.service.getAgent(agent.id).codexThreadId).toBe("approved-thread");
    harness.service.shutdown();
  });
});

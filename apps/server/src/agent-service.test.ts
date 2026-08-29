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
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { RunCancelledError, RunTimedOutError } from "./errors.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
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

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
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
});

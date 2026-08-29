import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import {
  HttpError,
  RunCancelledError,
  RunTimedOutError,
} from "./errors.js";
import {
  evaluateRunVaultPolicy,
  type RunVaultExecutionStatus,
} from "./runvault-policy.js";
import { RunVaultVerifier } from "./runvault-verifier.js";
import {
  RunVaultWorkspaceManager,
  TrustedWorkspaceChangedError,
  type RunVaultPromotion,
  type StagingWorkspace,
} from "./runvault-workspace.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  RunVaultDecision,
  RunVaultFileChange,
  RunVaultVerification,
  RunnerResult,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

const skippedVerification = (summary: string): RunVaultVerification => ({
  status: "skipped",
  command: null,
  redactedSummary: summary,
});

function verificationEvidence(
  verification: RunVaultVerification,
): RunVaultVerification {
  return {
    status: verification.status,
    command: verification.command,
    redactedSummary: verification.redactedSummary,
  };
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<unknown>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly verificationControllers = new Map<string, AbortController>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly runVaultWorkspaces = new RunVaultWorkspaceManager(
      config.workspaceRoot,
    ),
    private readonly verifier = new RunVaultVerifier(),
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.runVaultWorkspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const retainedStagingIds = this.store
      .snapshot()
      .runs.filter(
        (run) =>
          run.agentId === id && run.runVault?.outcome === "quarantined",
      )
      .flatMap((run) =>
        run.runVault?.stagingWorkspaceId
          ? [run.runVault.stagingWorkspaceId]
          : [],
      );
    await Promise.all(
      retainedStagingIds.map((stagingId) =>
        this.runVaultWorkspaces.discardStagingWorkspace(stagingId),
      ),
    );
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async approveRun(runId: string): Promise<AgentRun> {
    const reservation = await this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === runId);
      if (!run) throw new HttpError(404, "Run not found");
      if (
        run.runVault?.outcome === "promoted" &&
        run.runVault.resolution === "human_approved"
      ) {
        return { completed: structuredClone(run) } as const;
      }
      if (
        run.runVault?.outcome === "discarded" &&
        run.runVault.resolution === "human_discarded"
      ) {
        throw new HttpError(409, "This quarantined Run was already discarded");
      }
      if (run.runVault?.outcome !== "quarantined") {
        throw new HttpError(409, "Only a quarantined Run can be approved");
      }
      const agent = database.agents.find((item) => item.id === run.agentId);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (agent.status === "busy") {
        throw new HttpError(409, "Wait for the active Agent operation to finish");
      }
      const decision = run.runVault;
      if (
        !decision.stagingWorkspaceId ||
        !decision.provisionalThreadId ||
        !decision.trustedWorkspaceFingerprint ||
        !decision.stagingWorkspaceFingerprint ||
        !run.output
      ) {
        throw new HttpError(
          409,
          "This quarantined Run is missing promotion evidence and cannot be approved",
        );
      }
      const previousStatus = agent.status;
      agent.status = "busy";
      agent.updatedAt = now();
      return {
        run: structuredClone(run),
        agent: structuredClone(agent),
        previousStatus,
      } as const;
    });
    if ("completed" in reservation) return reservation.completed;

    const operation = this.promoteQuarantinedRun(
      reservation.run,
      reservation.agent,
      reservation.previousStatus,
    );
    this.activeExecutions.set(reservation.agent.id, operation);
    try {
      return await operation;
    } finally {
      if (this.activeExecutions.get(reservation.agent.id) === operation) {
        this.activeExecutions.delete(reservation.agent.id);
      }
    }
  }

  async discardRun(runId: string): Promise<AgentRun> {
    const updated = await this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === runId);
      if (!run) throw new HttpError(404, "Run not found");
      if (
        run.runVault?.outcome === "discarded" &&
        run.runVault.resolution === "human_discarded"
      ) {
        return structuredClone(run);
      }
      if (
        run.runVault?.outcome === "promoted" &&
        run.runVault.resolution === "human_approved"
      ) {
        throw new HttpError(409, "This quarantined Run was already approved");
      }
      if (run.runVault?.outcome !== "quarantined") {
        throw new HttpError(409, "Only a quarantined Run can be discarded");
      }
      const agent = database.agents.find((item) => item.id === run.agentId);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (agent.status === "busy") {
        throw new HttpError(409, "Wait for the active Agent operation to finish");
      }
      run.runVault.outcome = "discarded";
      run.runVault.resolution = "human_discarded";
      run.runVault.decidedAt = now();
      return structuredClone(run);
    });
    const stagingId = updated.runVault?.stagingWorkspaceId;
    if (stagingId) {
      await this.runVaultWorkspaces
        .discardStagingWorkspace(stagingId)
        .catch(() => undefined);
    }
    return updated;
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      runVault: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    let staging: StagingWorkspace | null = null;
    let runnerResult: RunnerResult | null = null;
    let verification = skippedVerification(
      "Verification was not run because Agent execution did not complete.",
    );
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      staging = await this.runVaultWorkspaces.createStagingWorkspace(
        run.id,
        agentAtStart.workspacePath,
      );
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      runnerResult = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: staging.path,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
      });
      if (runnerResult.threadId === agentAtStart.codexThreadId) {
        throw new Error("Codex did not create a distinct provisional thread");
      }
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }

      const beforeVerification = await this.runVaultWorkspaces.inspectChanges(
        staging.trustedSnapshot,
        staging.path,
      );
      if (beforeVerification.changes.some((change) => change.symbolicLink)) {
        verification = skippedVerification(
          "Verification was skipped because the staged workspace introduced a symbolic link.",
        );
      } else {
        const controller = new AbortController();
        this.verificationControllers.set(agentAtStart.id, controller);
        try {
          verification = verificationEvidence(
            await this.verifier.verify(staging.path, controller.signal),
          );
        } finally {
          if (this.verificationControllers.get(agentAtStart.id) === controller) {
            this.verificationControllers.delete(agentAtStart.id);
          }
        }
      }
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }

      const inspection = await this.runVaultWorkspaces.inspectChanges(
        staging.trustedSnapshot,
        staging.path,
      );
      const currentTrusted = await this.runVaultWorkspaces.snapshotWorkspace(
        agentAtStart.workspacePath,
      );
      let policy = evaluateRunVaultPolicy({
        executionStatus: "succeeded",
        verificationStatus: verification.status,
        changes: inspection.changes,
        trustedWorkspaceChanged:
          currentTrusted.fingerprint !== staging.trustedSnapshot.fingerprint,
      });
      let decision: RunVaultDecision = {
        outcome: policy.outcome,
        reason: policy.reason,
        resolution: "policy",
        stagingWorkspaceId: staging.id,
        provisionalThreadId: runnerResult.threadId,
        trustedWorkspaceFingerprint: staging.trustedSnapshot.fingerprint,
        stagingWorkspaceFingerprint: inspection.stagingFingerprint,
        changedFiles: policy.changedFiles,
        verification,
        trustedWorkspaceChanged:
          currentTrusted.fingerprint !== staging.trustedSnapshot.fingerprint,
        decidedAt: now(),
      };

      if (policy.outcome === "promoted") {
        if (this.cancellationRequests.has(agentAtStart.id)) {
          throw new RunCancelledError();
        }
        let promotion;
        try {
          promotion = await this.runVaultWorkspaces.beginPromotion(
            staging.id,
            agentAtStart.workspacePath,
            staging.trustedSnapshot.fingerprint,
          );
        } catch (error) {
          if (!(error instanceof TrustedWorkspaceChangedError)) throw error;
          policy = evaluateRunVaultPolicy({
            executionStatus: "succeeded",
            verificationStatus: verification.status,
            changes: inspection.changes,
            trustedWorkspaceChanged: true,
          });
          decision = {
            ...decision,
            outcome: policy.outcome,
            reason: policy.reason,
            changedFiles: policy.changedFiles,
            trustedWorkspaceChanged: true,
            decidedAt: now(),
          };
        }

        if (promotion) {
          try {
            if (this.cancellationRequests.has(agentAtStart.id)) {
              throw new RunCancelledError();
            }
            await this.persistCompletedRun(
              agentAtStart,
              run,
              runnerResult,
              decision,
              true,
            );
          } catch (error) {
            await this.runVaultWorkspaces.rollbackPromotion(promotion);
            throw error;
          }
          await this.runVaultWorkspaces.finalizePromotion(promotion).catch(
            () => undefined,
          );
          return;
        }
      }

      await this.persistCompletedRun(
        agentAtStart,
        run,
        runnerResult,
        decision,
        false,
      );
      if (decision.outcome === "discarded") {
        await this.runVaultWorkspaces
          .discardStagingWorkspace(staging.id)
          .catch(() => undefined);
      }
    } catch (error) {
      const completedAt = now();
      const cancelled =
        error instanceof RunCancelledError ||
        this.cancellationRequests.has(agentAtStart.id);
      const timedOut = error instanceof RunTimedOutError;
      const message = error instanceof Error ? error.message : String(error);
      let changes: RunVaultFileChange[] = [];
      let stagingWorkspaceFingerprint: string | null = null;
      let trustedWorkspaceChanged = false;
      if (staging) {
        try {
          const inspection = await this.runVaultWorkspaces.inspectChanges(
            staging.trustedSnapshot,
            staging.path,
          );
          changes = inspection.changes;
          stagingWorkspaceFingerprint = inspection.stagingFingerprint;
        } catch {
          changes = [];
        }
        try {
          trustedWorkspaceChanged =
            (
              await this.runVaultWorkspaces.snapshotWorkspace(
                agentAtStart.workspacePath,
              )
            ).fingerprint !== staging.trustedSnapshot.fingerprint;
        } catch {
          trustedWorkspaceChanged = false;
        }
      }
      const executionStatus: RunVaultExecutionStatus = cancelled
        ? "cancelled"
        : timedOut
          ? "timed_out"
          : "failed";
      const policy = evaluateRunVaultPolicy({
        executionStatus,
        verificationStatus: verification.status,
        changes,
        trustedWorkspaceChanged,
      });
      const decision: RunVaultDecision = {
        outcome: policy.outcome,
        reason: policy.reason,
        resolution: "policy",
        stagingWorkspaceId: staging?.id ?? null,
        provisionalThreadId: runnerResult?.threadId ?? null,
        trustedWorkspaceFingerprint:
          staging?.trustedSnapshot.fingerprint ?? null,
        stagingWorkspaceFingerprint,
        changedFiles: policy.changedFiles,
        verification,
        trustedWorkspaceChanged,
        decidedAt: completedAt,
      };
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.output = runnerResult?.output ?? null;
          storedRun.usage = runnerResult?.usage ?? null;
          storedRun.error = message;
          storedRun.runVault = decision;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
      if (staging) {
        await this.runVaultWorkspaces
          .discardStagingWorkspace(staging.id)
          .catch(() => undefined);
      }
    }
  }

  private async persistCompletedRun(
    agentAtStart: Agent,
    run: AgentRun,
    result: RunnerResult,
    decision: RunVaultDecision,
    promoted: boolean,
  ): Promise<void> {
    const completedAt = now();
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      const agent = database.agents.find((item) => item.id === agentAtStart.id);
      if (!storedRun || !agent) return;
      storedRun.status = "completed";
      storedRun.output = result.output;
      storedRun.usage = result.usage;
      storedRun.runVault = decision;
      storedRun.completedAt = completedAt;
      if (promoted) {
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.codexThreadId = result.threadId;
      }
      agent.status = "ready";
      agent.lastError = null;
      agent.updatedAt = completedAt;
    });
  }

  private async promoteQuarantinedRun(
    runAtStart: AgentRun,
    agentAtStart: Agent,
    previousStatus: Agent["status"],
  ): Promise<AgentRun> {
    const decision = runAtStart.runVault;
    if (
      !decision ||
      !decision.stagingWorkspaceId ||
      !decision.provisionalThreadId ||
      !decision.trustedWorkspaceFingerprint ||
      !decision.stagingWorkspaceFingerprint ||
      !runAtStart.output
    ) {
      await this.releaseDecisionReservation(agentAtStart.id, previousStatus);
      throw new HttpError(409, "Quarantined Run evidence is incomplete");
    }

    let promotion: RunVaultPromotion | null = null;
    try {
      let stagedSnapshot;
      try {
        stagedSnapshot = await this.runVaultWorkspaces.snapshotWorkspace(
          this.runVaultWorkspaces.stagingPath(decision.stagingWorkspaceId),
        );
      } catch {
        throw new HttpError(
          409,
          "Quarantined staging workspace is unavailable or unreadable",
        );
      }
      if (stagedSnapshot.fingerprint !== decision.stagingWorkspaceFingerprint) {
        throw new HttpError(
          409,
          "Quarantined staging files changed after inspection; discard this Run",
        );
      }
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      promotion = await this.runVaultWorkspaces.beginPromotion(
        decision.stagingWorkspaceId,
        agentAtStart.workspacePath,
        decision.trustedWorkspaceFingerprint,
      );
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }

      const completedAt = now();
      const updated = await this.store.mutate((database) => {
        const run = database.runs.find((item) => item.id === runAtStart.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!run || !agent) throw new HttpError(404, "Run or Agent not found");
        if (run.runVault?.outcome !== "quarantined") {
          throw new HttpError(409, "RunVault decision changed during approval");
        }
        run.runVault.outcome = "promoted";
        run.runVault.resolution = "human_approved";
        run.runVault.decidedAt = completedAt;
        agent.codexThreadId = decision.provisionalThreadId;
        agent.status = previousStatus === "stopped" ? "stopped" : "ready";
        agent.lastError = null;
        agent.updatedAt = completedAt;
        if (
          !database.messages.some(
            (message) => message.runId === run.id && message.role === "assistant",
          )
        ) {
          database.messages.push({
            id: randomUUID(),
            agentId: agent.id,
            runId: run.id,
            role: "assistant",
            content: runAtStart.output as string,
            createdAt: completedAt,
          });
        }
        return structuredClone(run);
      });
      await this.runVaultWorkspaces.finalizePromotion(promotion).catch(
        () => undefined,
      );
      return updated;
    } catch (error) {
      if (promotion) {
        try {
          await this.runVaultWorkspaces.rollbackPromotion(promotion);
        } catch (rollbackError) {
          throw new Error("RunVault could not roll back a failed approval", {
            cause: rollbackError,
          });
        }
      }
      const trustedChanged = error instanceof TrustedWorkspaceChangedError;
      await this.store.mutate((database) => {
        const run = database.runs.find((item) => item.id === runAtStart.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (trustedChanged && run?.runVault?.outcome === "quarantined") {
          run.runVault.reason = "trusted_workspace_changed";
          run.runVault.trustedWorkspaceChanged = true;
          run.runVault.decidedAt = now();
        }
        if (agent?.status === "busy") {
          agent.status = previousStatus === "stopped" ? "stopped" : "ready";
          agent.updatedAt = now();
        }
      });
      if (trustedChanged) {
        throw new HttpError(
          409,
          "Trusted workspace changed after quarantine; approval was not applied",
        );
      }
      if (error instanceof RunCancelledError) {
        throw new HttpError(409, "Run approval was cancelled");
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new HttpError(409, "Trusted workspace is unavailable");
      }
      throw error;
    }
  }

  private async releaseDecisionReservation(
    agentId: string,
    previousStatus: Agent["status"],
  ): Promise<void> {
    await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === agentId);
      if (agent?.status === "busy") {
        agent.status = previousStatus === "stopped" ? "stopped" : "ready";
        agent.updatedAt = now();
      }
    });
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      this.verificationControllers.get(agentId)?.abort();
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}

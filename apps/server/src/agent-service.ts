import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import {
  DependencyCacheUnavailableError,
  DependencyManager,
  DependencyPreparationError,
  type DependencyResolution,
} from "./dependency-manager.js";
import { createDependencyManager } from "./dependency-factory.js";
import {
  HttpError,
  RunCancelledError,
  RunTimedOutError,
} from "./errors.js";
import {
  MAX_FINDINGS,
  evaluateRunVaultPolicy,
  type RunVaultExecutionStatus,
} from "./runvault-policy.js";
import {
  filterRunVaultHistory,
  type RunVaultHistoryFilters,
} from "./runvault-history.js";
import {
  appendRunVaultEvent,
  emitRunVaultMetric,
  emptyRunVaultMetrics,
} from "./runvault-observability.js";
import {
  buildBoundedTextDiff,
  validateReviewPath,
} from "./runvault-review.js";
import { RunVaultVerifier } from "./runvault-verifier.js";
import { createVerifier } from "./verifier-factory.js";
import {
  RunVaultWorkspaceManager,
  StagingQuotaExceededError,
  type StagingQuota,
  TrustedWorkspaceChangedError,
  UnsafeWorkspaceEntryError,
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
  RunVaultReview,
  RunVaultDiagnostics,
  RunVaultEvidenceExport,
  RunVaultHistoryEntry,
  RunVaultLifecycleEvent,
  RunVaultLifecycleEventType,
  RunVaultRunMetrics,
  RunVaultTextDiff,
  RunVaultVerification,
  RunVaultPolicySnapshot,
  RunnerResult,
  RunnerRequest,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();
const elapsedMs = (startedAt: number) =>
  Math.max(0, Math.round((performance.now() - startedAt) * 1_000) / 1_000);

interface RevisionExecutionContext {
  parentRunId: string;
  sourceStagingId: string;
  sourceStagingFingerprint: string;
  trustedWorkspaceFingerprint: string;
  baseThreadId: string;
}

const skippedVerification = (summary: string): RunVaultVerification => ({
  status: "skipped",
  command: null,
  redactedSummary: summary,
});

const unavailableVerification = (summary: string): RunVaultVerification => ({
  status: "unavailable",
  command: null,
  redactedSummary: summary,
});

function retentionForOutcome(
  outcome: RunVaultDecision["outcome"],
  decidedAt: string,
  policy: RunVaultPolicySnapshot,
): { retainedAt: string | null; expiresAt: string | null } {
  if (outcome !== "quarantined") {
    return { retainedAt: null, expiresAt: null };
  }
  return {
    retainedAt: decidedAt,
    expiresAt: new Date(
      Date.parse(decidedAt) + policy.quarantineRetentionMs,
    ).toISOString(),
  };
}

function verificationEvidence(
  verification: RunVaultVerification,
): RunVaultVerification {
  return {
    status: verification.status,
    command: verification.command,
    redactedSummary: verification.redactedSummary,
  };
}

function dependencyMountForRun(resolution: DependencyResolution): string | null {
  if (resolution.status === "available") return resolution.mountPath;
  if (
    resolution.status === "disabled" ||
    resolution.status === "not_applicable"
  ) {
    return null;
  }
  throw new DependencyCacheUnavailableError(
    `${resolution.message} Prepare dependencies explicitly before starting the Run.`,
  );
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<unknown>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly verificationControllers = new Map<string, AbortController>();
  private retentionTimer: NodeJS.Timeout | null = null;
  private retentionSweepPromise: Promise<number> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly runVaultWorkspaces = new RunVaultWorkspaceManager(
      config.workspaceRoot,
    ),
    private readonly verifier = createVerifier(config),
    private readonly dependencies = createDependencyManager(config),
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.runVaultWorkspaces.initialize();
    await this.dependencies.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          if (run.runVault?.outcome === "promoted") {
            continue;
          }
          const completedAt = now();
          const policy = this.policySnapshot(completedAt);
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.runVault = {
            outcome: "discarded",
            reason: "cancelled",
            resolution: "policy",
            stagingWorkspaceId: run.runVault?.stagingWorkspaceId ?? run.id,
            provisionalThreadId: run.runVault?.provisionalThreadId ?? null,
            trustedWorkspaceFingerprint:
              run.runVault?.trustedWorkspaceFingerprint ?? null,
            stagingWorkspaceFingerprint:
              run.runVault?.stagingWorkspaceFingerprint ?? null,
            changedFiles: run.runVault?.changedFiles ?? {
              addedCount: 0,
              modifiedCount: 0,
              deletedCount: 0,
              protectedPathsTouched: [],
              files: [],
              omittedFileCount: 0,
              changedBytes: 0,
            },
            findings: run.runVault?.findings ?? [],
            verification: skippedVerification(
              "Verification was interrupted when the server restarted.",
            ),
            trustedWorkspaceChanged:
              run.runVault?.trustedWorkspaceChanged ?? false,
            policy: run.runVault?.policy ?? policy,
            retainedAt: null,
            expiresAt: null,
            decidedAt: completedAt,
          };
          run.completedAt = completedAt;
          run.runVaultMetrics.outcome = "discarded";
          run.runVaultMetrics.verificationStatus = "skipped";
          run.runVaultMetrics.cleanupStatus = "completed";
          appendRunVaultEvent(run, "decided", completedAt, {
            outcome: "discarded",
            resolution: "policy",
          });
          appendRunVaultEvent(run, "discarded", completedAt, {
            outcome: "discarded",
            resolution: "policy",
          });
          appendRunVaultEvent(run, "reconciled", completedAt, {
            reconciliationAction: "interrupted_run",
          });
        }
      }
      for (const agent of database.agents) {
        const hasCommittedPromotion = database.runs.some(
          (run) =>
            run.agentId === agent.id &&
            (run.status === "queued" || run.status === "running") &&
            run.runVault?.outcome === "promoted",
        );
        if (agent.status === "busy" && !hasCommittedPromotion) {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
    const reconciliation = await this.runVaultWorkspaces.reconcileTransactions(
      this.store.snapshot(),
    );
    await this.store.mutate((database) => {
      const recoveredAt = now();
      for (const run of database.runs) {
        if (
          (run.status === "queued" || run.status === "running") &&
          run.runVault?.outcome === "promoted"
        ) {
          run.status = "completed";
          run.error = null;
          run.completedAt = run.completedAt ?? recoveredAt;
        }
      }
      for (const agent of database.agents) {
        const hasActiveRun = database.runs.some(
          (run) =>
            run.agentId === agent.id &&
            (run.status === "queued" || run.status === "running"),
        );
        if (agent.status === "busy" && !hasActiveRun) {
          agent.status = "ready";
          agent.updatedAt = recoveredAt;
        }
      }
      for (const record of reconciliation.records) {
        const run = database.runs.find((item) => item.id === record.runId);
        if (run) {
          appendRunVaultEvent(run, "reconciled", reconciliation.at, {
            reconciliationAction: record.action,
          });
        }
      }
    });
    await this.sweepExpiredQuarantines();
  }

  shutdown(): void {
    if (this.retentionTimer) clearTimeout(this.retentionTimer);
    this.retentionTimer = null;
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

  async prepareDependencies(
    id: string,
    confirmNetworkAccess: boolean,
  ): Promise<{ status: "prepared" | "already_available"; cacheKey: string }> {
    const reservation = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (agent.status === "busy") {
        throw new HttpError(409, "Wait for the active Agent operation to finish");
      }
      const previousStatus = agent.status;
      agent.status = "busy";
      agent.lastError = null;
      agent.updatedAt = now();
      return { agent: structuredClone(agent), previousStatus };
    });
    const operation = this.dependencies.prepare(
      reservation.agent.workspacePath,
      confirmNetworkAccess,
    );
    this.activeExecutions.set(id, operation);
    try {
      return await operation;
    } catch (error) {
      if (
        error instanceof DependencyPreparationError ||
        error instanceof DependencyCacheUnavailableError
      ) {
        throw new HttpError(409, error.message);
      }
      throw error;
    } finally {
      if (this.activeExecutions.get(id) === operation) {
        this.activeExecutions.delete(id);
      }
      await this.store.mutate((database) => {
        const agent = database.agents.find((item) => item.id === id);
        if (agent?.status === "busy") {
          agent.status = reservation.previousStatus;
          agent.updatedAt = now();
        }
      });
    }
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

  getRunVaultHistory(filters: RunVaultHistoryFilters): RunVaultHistoryEntry[] {
    return filterRunVaultHistory(this.store.snapshot(), filters);
  }

  getRunVaultEvidence(runId: string): RunVaultEvidenceExport {
    const run = this.getRun(runId);
    if (!run.runVault) {
      throw new HttpError(409, "RunVault evidence is not available for this Run");
    }
    const decision = structuredClone(run.runVault);
    const { verification, ...decisionWithoutVerification } = decision;
    return {
      version: 1,
      exportedAt: now(),
      run: {
        id: run.id,
        agentId: run.agentId,
        parentRunId: run.parentRunId,
        supersededByRunId: run.supersededByRunId,
        revisionNumber: run.revisionNumber,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        createdAt: run.createdAt,
      },
      decision: {
        ...decisionWithoutVerification,
        verification: {
          status: verification.status,
          command: verification.command,
        },
      },
      lifecycleEvents: structuredClone(run.runVaultEvents),
      metrics: structuredClone(run.runVaultMetrics),
    };
  }

  async runVaultDiagnostics(): Promise<RunVaultDiagnostics> {
    await this.sweepExpiredQuarantines();
    const database = this.store.snapshot();
    const [staging, dependencies, verifierAvailable] = await Promise.all([
      this.runVaultWorkspaces.diagnostics(database),
      this.dependencies.diagnostics(),
      this.verifier.isAvailable(),
    ]);
    const decided = database.runs.filter((run) => run.runVault !== null);
    const stagingDurations = database.runs.flatMap((run) =>
      run.runVaultMetrics.stagingDurationMs === null
        ? []
        : [run.runVaultMetrics.stagingDurationMs],
    );
    const verificationDurations = database.runs.flatMap((run) =>
      run.runVaultMetrics.verificationDurationMs === null
        ? []
        : [run.runVaultMetrics.verificationDurationMs],
    );
    const average = (values: number[]) =>
      values.length === 0
        ? null
        : Math.round(
            (values.reduce((total, value) => total + value, 0) / values.length) *
              1_000,
          ) / 1_000;
    return {
      generatedAt: now(),
      verifierAvailable,
      staging,
      dependencies,
      metrics: {
        totalRuns: database.runs.length,
        decidedRuns: decided.length,
        outcomes: {
          promoted: decided.filter((run) => run.runVault?.outcome === "promoted")
            .length,
          quarantined: decided.filter(
            (run) => run.runVault?.outcome === "quarantined",
          ).length,
          discarded: decided.filter((run) => run.runVault?.outcome === "discarded")
            .length,
        },
        verification: {
          passed: decided.filter(
            (run) => run.runVault?.verification.status === "passed",
          ).length,
          failed: decided.filter(
            (run) => run.runVault?.verification.status === "failed",
          ).length,
          skipped: decided.filter(
            (run) => run.runVault?.verification.status === "skipped",
          ).length,
          unavailable: decided.filter(
            (run) => run.runVault?.verification.status === "unavailable",
          ).length,
        },
        cleanupFailures: database.runs.filter(
          (run) => run.runVaultMetrics.cleanupStatus === "failed",
        ).length,
        averageStagingDurationMs: average(stagingDurations),
        averageVerificationDurationMs: average(verificationDurations),
        totalStagedBytes: database.runs.reduce(
          (total, run) => total + (run.runVaultMetrics.stagingCopiedBytes ?? 0),
          0,
        ),
        totalChangedBytes: database.runs.reduce(
          (total, run) => total + run.runVaultMetrics.changedBytes,
          0,
        ),
      },
      storageModel: "single-process-json",
      tamperProof: false,
    };
  }

  async getRunVaultReview(runId: string): Promise<RunVaultReview> {
    await this.sweepExpiredQuarantines();
    const run = this.getRun(runId);
    const decision = run.runVault;
    if (!decision) throw new HttpError(404, "RunVault decision not found");
    if (
      decision.outcome !== "quarantined" ||
      !decision.stagingWorkspaceId ||
      !decision.stagingWorkspaceFingerprint ||
      !decision.trustedWorkspaceFingerprint
    ) {
      return {
        runId,
        availability: "not_retained",
        message: "Staged files are no longer retained; persisted evidence remains available.",
        stagingFingerprintVerified: false,
        trustedFingerprintVerified: false,
      };
    }

    let stagedFingerprint: string;
    try {
      stagedFingerprint = (
        await this.runVaultWorkspaces.snapshotWorkspace(
          this.runVaultWorkspaces.stagingPath(decision.stagingWorkspaceId),
        )
      ).fingerprint;
    } catch {
      return {
        runId,
        availability: "missing",
        message: "Retained staging is missing or unreadable. Review actions are unavailable.",
        stagingFingerprintVerified: false,
        trustedFingerprintVerified: false,
      };
    }
    if (stagedFingerprint !== decision.stagingWorkspaceFingerprint) {
      return {
        runId,
        availability: "staging_tampered",
        message: "Retained staging changed after inspection. Contents and actions are unavailable.",
        stagingFingerprintVerified: false,
        trustedFingerprintVerified: false,
      };
    }

    const agent = this.getAgent(run.agentId);
    let trustedFingerprint: string;
    try {
      trustedFingerprint = (
        await this.runVaultWorkspaces.snapshotWorkspace(agent.workspacePath)
      ).fingerprint;
    } catch {
      return {
        runId,
        availability: "trusted_changed",
        message: "The trusted workspace is unavailable for comparison.",
        stagingFingerprintVerified: true,
        trustedFingerprintVerified: false,
      };
    }
    if (trustedFingerprint !== decision.trustedWorkspaceFingerprint) {
      return {
        runId,
        availability: "trusted_changed",
        message: "The trusted workspace changed after this Run. Diffs and approval are unavailable.",
        stagingFingerprintVerified: true,
        trustedFingerprintVerified: false,
      };
    }
    return {
      runId,
      availability: "available",
      message: "Retained staging and trusted workspace fingerprints are verified.",
      stagingFingerprintVerified: true,
      trustedFingerprintVerified: true,
    };
  }

  async getRunVaultDiff(
    runId: string,
    requestedPath: string,
  ): Promise<RunVaultTextDiff> {
    await this.sweepExpiredQuarantines();
    let relativePath: string;
    try {
      relativePath = validateReviewPath(requestedPath);
    } catch {
      throw new HttpError(400, "Invalid review path");
    }
    const run = this.getRun(runId);
    const decision = run.runVault;
    if (!decision) throw new HttpError(404, "RunVault decision not found");
    const change = decision.changedFiles.files.find(
      (file) => file.path === relativePath,
    );
    if (!change) throw new HttpError(404, "File is not in the recorded manifest");
    const review = await this.getRunVaultReview(runId);
    if (review.availability !== "available" || !decision.stagingWorkspaceId) {
      throw new HttpError(409, review.message);
    }
    if (change.protected) {
      return { path: relativePath, status: "protected", diff: null, truncated: false };
    }
    if (change.symbolicLink) {
      return { path: relativePath, status: "symbolic_link", diff: null, truncated: false };
    }
    if (change.binary) {
      return { path: relativePath, status: "binary", diff: null, truncated: false };
    }
    const agent = this.getAgent(run.agentId);
    const [before, after] = await Promise.all([
      this.runVaultWorkspaces.readReviewFile(agent.workspacePath, relativePath),
      this.runVaultWorkspaces.readReviewFile(
        this.runVaultWorkspaces.stagingPath(decision.stagingWorkspaceId),
        relativePath,
      ),
    ]);
    const blocked = [before.status, after.status].find((status) =>
      ["binary", "symbolic_link", "too_large"].includes(status),
    );
    if (blocked) {
      return {
        path: relativePath,
        status: blocked as "binary" | "symbolic_link" | "too_large",
        diff: null,
        truncated: false,
      };
    }
    if (before.status === "missing" && after.status === "missing") {
      return { path: relativePath, status: "unavailable", diff: null, truncated: false };
    }
    const rendered = buildBoundedTextDiff(
      before.status === "available" ? before.text : "",
      after.status === "available" ? after.text : "",
    );
    return {
      path: relativePath,
      status: "available",
      diff: rendered.diff,
      truncated: rendered.truncated,
    };
  }

  async approveRun(runId: string): Promise<AgentRun> {
    await this.sweepExpiredQuarantines();
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
      this.scheduleRetentionSweep();
    }
  }

  async discardRun(runId: string): Promise<AgentRun> {
    await this.sweepExpiredQuarantines();
    const result = await this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === runId);
      if (!run) throw new HttpError(404, "Run not found");
      if (
        run.runVault?.outcome === "discarded" &&
        run.runVault.resolution === "human_discarded"
      ) {
        return { run: structuredClone(run), changed: false };
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
      const discardedAt = now();
      run.runVault.outcome = "discarded";
      run.runVault.resolution = "human_discarded";
      run.runVault.decidedAt = discardedAt;
      run.runVaultMetrics.outcome = "discarded";
      appendRunVaultEvent(run, "discarded", discardedAt, {
        outcome: "discarded",
        resolution: "human_discarded",
      });
      return { run: structuredClone(run), changed: true };
    });
    const stagingId = result.run.runVault?.stagingWorkspaceId;
    if (result.changed && stagingId) {
      const metrics = structuredClone(result.run.runVaultMetrics);
      await this.cleanupStaging(stagingId, metrics);
      await this.store.mutate((database) => {
        const run = database.runs.find((item) => item.id === runId);
        if (run) run.runVaultMetrics = metrics;
      });
      this.emitPersistedMetric(runId, "staging_cleanup");
    }
    this.scheduleRetentionSweep();
    return this.getRun(runId);
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    await this.sweepExpiredQuarantines();
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
      parentRunId: null,
      supersededByRunId: null,
      revisionNumber: 0,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      runVault: null,
      runVaultEvents: [],
      runVaultMetrics: emptyRunVaultMetrics(),
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

  async requestRevision(
    parentRunId: string,
    instructions: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    await this.sweepExpiredQuarantines();
    if (!isArkConfigured(this.config)) {
      throw new HttpError(503, "Ark is not configured");
    }
    const reservation = await this.store.mutate((database) => {
      const parent = database.runs.find((run) => run.id === parentRunId);
      if (!parent) throw new HttpError(404, "Run not found");
      const decision = parent.runVault;
      if (
        decision?.outcome !== "quarantined" ||
        !decision.stagingWorkspaceId ||
        !decision.stagingWorkspaceFingerprint ||
        !decision.trustedWorkspaceFingerprint ||
        !decision.provisionalThreadId
      ) {
        throw new HttpError(409, "Only an intact quarantined Run can be revised");
      }
      const agent = database.agents.find((item) => item.id === parent.agentId);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (agent.status === "busy") {
        throw new HttpError(409, "Wait for the active Agent operation to finish");
      }
      const agentAtStart = structuredClone(agent);
      agent.status = "busy";
      agent.lastError = null;
      agent.updatedAt = now();
      return { parent: structuredClone(parent), agentAtStart };
    });

    try {
      const review = await this.getRunVaultReview(parentRunId);
      if (review.availability !== "available") {
        throw new HttpError(409, review.message);
      }
      const parentDecision = reservation.parent.runVault!;
      const timestamp = now();
      const runId = randomUUID();
      const run: AgentRun = {
        id: runId,
        agentId: reservation.parent.agentId,
        parentRunId,
        supersededByRunId: null,
        revisionNumber: reservation.parent.revisionNumber + 1,
        status: "queued",
        prompt: instructions,
        output: null,
        error: null,
        usage: null,
        runVault: null,
        runVaultEvents: [],
        runVaultMetrics: emptyRunVaultMetrics(),
        startedAt: null,
        completedAt: null,
        createdAt: timestamp,
      };
      const message: Message = {
        id: randomUUID(),
        agentId: run.agentId,
        runId,
        role: "user",
        content: instructions,
        createdAt: timestamp,
      };
      await this.store.mutate((database) => {
        const parent = database.runs.find((item) => item.id === parentRunId);
        const agent = database.agents.find((item) => item.id === run.agentId);
        if (parent?.runVault?.outcome !== "quarantined" || !agent) {
          throw new HttpError(409, "Parent Run changed during revision creation");
        }
        parent.supersededByRunId = runId;
        appendRunVaultEvent(parent, "revision_requested", timestamp, {
          relatedRunId: runId,
        });
        appendRunVaultEvent(run, "revision_requested", timestamp, {
          relatedRunId: parentRunId,
        });
        database.runs.push(run);
        database.messages.push(message);
      });
      const context: RevisionExecutionContext = {
        parentRunId,
        sourceStagingId: parentDecision.stagingWorkspaceId!,
        sourceStagingFingerprint: parentDecision.stagingWorkspaceFingerprint!,
        trustedWorkspaceFingerprint: parentDecision.trustedWorkspaceFingerprint!,
        baseThreadId: parentDecision.provisionalThreadId!,
      };
      const execution = this.executeRun(reservation.agentAtStart, run, context);
      this.activeExecutions.set(run.agentId, execution);
      void execution.finally(() => {
        if (this.activeExecutions.get(run.agentId) === execution) {
          this.activeExecutions.delete(run.agentId);
        }
      }).catch(() => undefined);
      return { run, message };
    } catch (error) {
      await this.releaseDecisionReservation(
        reservation.agentAtStart.id,
        reservation.agentAtStart.status,
      );
      throw error;
    }
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      dependencyMode: this.config.dependencyMode,
      runVaultPolicy: this.config.runVaultPolicy,
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

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    revision?: RevisionExecutionContext,
  ): Promise<void> {
    const policySnapshot = this.policySnapshot(run.createdAt);
    const metrics = emptyRunVaultMetrics();
    const stagingQuota = {
      perRunBytes: policySnapshot.stagingPerRunBytes,
      totalBytes: policySnapshot.stagingTotalBytes,
    };
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    let staging: StagingWorkspace | null = null;
    let runnerResult: RunnerResult | null = null;
    let promotionCommitted = false;
    let verification = skippedVerification(
      "Verification was not run because Agent execution did not complete.",
    );
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const stagingStartedAt = performance.now();
      staging = revision
        ? await this.runVaultWorkspaces.createRevisionStagingWorkspace(
            run.id,
            revision.sourceStagingId,
            agentAtStart.workspacePath,
            revision.sourceStagingFingerprint,
            revision.trustedWorkspaceFingerprint,
            stagingQuota,
          )
        : await this.runVaultWorkspaces.createStagingWorkspace(
            run.id,
            agentAtStart.workspacePath,
            stagingQuota,
          );
      metrics.stagingDurationMs = elapsedMs(stagingStartedAt);
      metrics.stagingCopiedEntries = staging.metrics.copiedEntryCount;
      metrics.stagingCopiedBytes = staging.metrics.estimatedCopiedBytes;
      await this.recordRunProgress(
        run.id,
        "staged",
        now(),
        {},
        {
          stagingDurationMs: metrics.stagingDurationMs,
          stagingCopiedEntries: metrics.stagingCopiedEntries,
          stagingCopiedBytes: metrics.stagingCopiedBytes,
        },
      );
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const initialDependencies = await this.dependencies.resolve(staging.path);
      const initialDependencyMount = dependencyMountForRun(initialDependencies);
      const agentStartedAt = performance.now();
      try {
        runnerResult = await this.runWithStagingQuota({
          agentId: agentAtStart.id,
          workspacePath: staging.path,
          prompt: run.prompt,
          threadId: revision?.baseThreadId ?? agentAtStart.codexThreadId,
          dependencyCachePath: initialDependencyMount,
        }, staging.path, stagingQuota);
      } finally {
        metrics.agentDurationMs = elapsedMs(agentStartedAt);
      }
      if (runnerResult.threadId === (revision?.baseThreadId ?? agentAtStart.codexThreadId)) {
        throw new Error("Codex did not create a distinct provisional thread");
      }
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }

      const firstInspectionStartedAt = performance.now();
      const beforeVerification = await this.runVaultWorkspaces.inspectChanges(
        staging.trustedSnapshot,
        staging.path,
        policySnapshot.protectedPatterns,
      );
      metrics.inspectionDurationMs = elapsedMs(firstInspectionStartedAt);
      await this.recordRunProgress(
        run.id,
        "inspected",
        now(),
        {},
        { inspectionDurationMs: metrics.inspectionDurationMs },
      );
      const dependencyFilesChanged = beforeVerification.changes.some(
        (change) => change.dependencyFile,
      );
      const verificationStartedAt = performance.now();
      let verificationDependencyMount: string | null = null;
      let dependencyVerificationBlocked = false;
      let verificationDependencies: DependencyResolution | null = null;
      try {
        verificationDependencies = await this.dependencies.resolve(staging.path);
      } catch (error) {
        if (
          !dependencyFilesChanged ||
          !(error instanceof DependencyCacheUnavailableError)
        ) {
          throw error;
        }
        dependencyVerificationBlocked = true;
        verification = unavailableVerification(
          `${error.message} Verification cannot use stale dependencies after dependency files changed.`,
        );
      }
      if (verificationDependencies?.status === "available") {
        verificationDependencyMount = verificationDependencies.mountPath;
      } else if (
        verificationDependencies &&
        verificationDependencies.status !== "disabled"
      ) {
        if (dependencyFilesChanged) {
          dependencyVerificationBlocked = true;
          verification = unavailableVerification(
            `${verificationDependencies.message} Verification cannot use stale dependencies after dependency files changed.`,
          );
        } else if (verificationDependencies.status !== "not_applicable") {
          throw new DependencyCacheUnavailableError(
            `${verificationDependencies.message} Managed dependencies became unavailable before verification.`,
          );
        }
      }
      if (beforeVerification.changes.some((change) => change.symbolicLink)) {
        verification = skippedVerification(
          "Verification was skipped because the staged workspace introduced a symbolic link.",
        );
      } else if (!dependencyVerificationBlocked) {
        const controller = new AbortController();
        this.verificationControllers.set(agentAtStart.id, controller);
        try {
          verification = verificationEvidence(
            await this.verifier.verify(
              staging.path,
              controller.signal,
              verificationDependencyMount,
            ),
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
      metrics.verificationDurationMs = elapsedMs(verificationStartedAt);
      metrics.verificationStatus = verification.status;
      await this.recordRunProgress(
        run.id,
        "verified",
        now(),
        { verificationStatus: verification.status },
        {
          verificationDurationMs: metrics.verificationDurationMs,
          verificationStatus: metrics.verificationStatus,
        },
      );

      const finalInspectionStartedAt = performance.now();
      const inspection = await this.runVaultWorkspaces.inspectChanges(
        staging.trustedSnapshot,
        staging.path,
        policySnapshot.protectedPatterns,
      );
      metrics.inspectionDurationMs =
        (metrics.inspectionDurationMs ?? 0) +
        elapsedMs(finalInspectionStartedAt);
      await this.runVaultWorkspaces.assertStagingWithinQuota(
        staging.path,
        stagingQuota,
      );
      const currentTrusted = await this.runVaultWorkspaces.snapshotWorkspace(
        agentAtStart.workspacePath,
      );
      const decisionStartedAt = performance.now();
      let policy = evaluateRunVaultPolicy({
        executionStatus: "succeeded",
        verificationStatus: verification.status,
        changes: inspection.changes,
        changedBytes: inspection.changedBytes,
        policy: policySnapshot,
        trustedWorkspaceChanged:
          currentTrusted.fingerprint !== staging.trustedSnapshot.fingerprint,
      });
      metrics.decisionDurationMs = elapsedMs(decisionStartedAt);
      metrics.changedFileCount = inspection.changes.length;
      metrics.changedBytes = inspection.changedBytes;
      metrics.outcome = policy.outcome;
      metrics.verificationStatus = verification.status;
      const initialDecidedAt = now();
      let decision: RunVaultDecision = {
        outcome: policy.outcome,
        reason: policy.reason,
        resolution: "policy",
        stagingWorkspaceId: staging.id,
        provisionalThreadId: runnerResult.threadId,
        trustedWorkspaceFingerprint: staging.trustedSnapshot.fingerprint,
        stagingWorkspaceFingerprint: inspection.stagingFingerprint,
        changedFiles: policy.changedFiles,
        findings: policy.findings,
        verification,
        trustedWorkspaceChanged:
          currentTrusted.fingerprint !== staging.trustedSnapshot.fingerprint,
        policy: policySnapshot,
        ...retentionForOutcome(policy.outcome, initialDecidedAt, policySnapshot),
        decidedAt: initialDecidedAt,
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
            changedBytes: inspection.changedBytes,
            policy: policySnapshot,
            trustedWorkspaceChanged: true,
          });
          const changedAt = now();
          decision = {
            ...decision,
            outcome: policy.outcome,
            reason: policy.reason,
            changedFiles: policy.changedFiles,
            findings: policy.findings,
            trustedWorkspaceChanged: true,
            ...retentionForOutcome(policy.outcome, changedAt, policySnapshot),
            decidedAt: changedAt,
          };
          metrics.outcome = policy.outcome;
        }

        if (promotion) {
          try {
            if (this.cancellationRequests.has(agentAtStart.id)) {
              throw new RunCancelledError();
            }
            await this.persistPromotionCommitment(
              agentAtStart,
              run,
              runnerResult,
              decision,
              metrics,
            );
            promotionCommitted = true;
          } catch (error) {
            await this.runVaultWorkspaces.rollbackPromotion(promotion);
            throw error;
          }
          const cleanupStartedAt = performance.now();
          try {
            await this.runVaultWorkspaces.finalizePromotion(promotion);
            metrics.cleanupStatus = "completed";
          } catch {
            metrics.cleanupStatus = "failed";
          }
          metrics.cleanupDurationMs = elapsedMs(cleanupStartedAt);
          if (revision) {
            await this.cleanupStaging(revision.sourceStagingId, metrics);
          }
          await this.publishCommittedPromotion(agentAtStart.id, run.id, metrics);
          this.emitPersistedMetric(run.id, "run_decision");
          return;
        }
      }

      if (decision.outcome === "discarded") {
        await this.cleanupStaging(staging.id, metrics);
      } else if (revision && decision.outcome === "quarantined") {
        await this.cleanupStaging(revision.sourceStagingId, metrics);
        metrics.cleanupStatus = "retained";
      } else if (decision.outcome === "quarantined") {
        metrics.cleanupStatus = "retained";
      }
      await this.persistCompletedRun(
        agentAtStart,
        run,
        runnerResult,
        decision,
        metrics,
      );
      this.emitPersistedMetric(run.id, "run_decision");
      this.scheduleRetentionSweep();
    } catch (error) {
      if (promotionCommitted) {
        await this.publishCommittedPromotion(agentAtStart.id, run.id).catch(
          () => undefined,
        );
        return;
      }
      const completedAt = now();
      const cancelled =
        error instanceof RunCancelledError ||
        this.cancellationRequests.has(agentAtStart.id);
      const timedOut = error instanceof RunTimedOutError;
      const quotaExceeded = error instanceof StagingQuotaExceededError;
      const message = error instanceof Error ? error.message : String(error);
      let changes: RunVaultFileChange[] = [];
      let stagingWorkspaceFingerprint: string | null = null;
      let trustedWorkspaceChanged = false;
      let changedBytes = 0;
      if (staging) {
        try {
          const inspection = await this.runVaultWorkspaces.inspectChanges(
            staging.trustedSnapshot,
            staging.path,
            policySnapshot.protectedPatterns,
          );
          changes = inspection.changes;
          changedBytes = inspection.changedBytes;
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
          : quotaExceeded
            ? "quota_exceeded"
            : "failed";
      const failedDecisionStartedAt = performance.now();
      const policy = evaluateRunVaultPolicy({
        executionStatus,
        verificationStatus: verification.status,
        changes,
        changedBytes,
        policy: policySnapshot,
        trustedWorkspaceChanged,
      });
      metrics.decisionDurationMs = elapsedMs(failedDecisionStartedAt);
      const retention = retentionForOutcome(
        policy.outcome,
        completedAt,
        policySnapshot,
      );
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
        findings: policy.findings,
        verification,
        trustedWorkspaceChanged,
        policy: policySnapshot,
        ...retention,
        decidedAt: completedAt,
      };
      metrics.changedFileCount = changes.length;
      metrics.changedBytes = changedBytes;
      metrics.outcome = policy.outcome;
      metrics.verificationStatus = verification.status;
      if (staging) {
        await this.cleanupStaging(staging.id, metrics);
      }
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.output = runnerResult?.output ?? null;
          storedRun.usage = runnerResult?.usage ?? null;
          storedRun.error = message;
          storedRun.runVault = decision;
          storedRun.runVaultMetrics = structuredClone(metrics);
          appendRunVaultEvent(storedRun, "decided", completedAt, {
            outcome: decision.outcome,
            resolution: decision.resolution,
          });
          appendRunVaultEvent(storedRun, "discarded", completedAt, {
            outcome: decision.outcome,
            resolution: decision.resolution,
          });
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
      this.emitPersistedMetric(run.id, "run_decision");
    }
  }

  private async persistCompletedRun(
    agentAtStart: Agent,
    run: AgentRun,
    result: RunnerResult,
    decision: RunVaultDecision,
    metrics: RunVaultRunMetrics,
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
      storedRun.runVaultMetrics = structuredClone(metrics);
      appendRunVaultEvent(storedRun, "decided", decision.decidedAt, {
        outcome: decision.outcome,
        resolution: decision.resolution,
      });
      if (decision.outcome === "discarded") {
        appendRunVaultEvent(storedRun, "discarded", decision.decidedAt, {
          outcome: decision.outcome,
          resolution: decision.resolution,
        });
      }
      storedRun.completedAt = completedAt;
      agent.status = "ready";
      agent.lastError = null;
      agent.updatedAt = completedAt;
    });
  }

  private async persistPromotionCommitment(
    agentAtStart: Agent,
    run: AgentRun,
    result: RunnerResult,
    decision: RunVaultDecision,
    metrics: RunVaultRunMetrics,
  ): Promise<void> {
    const committedAt = now();
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      const agent = database.agents.find((item) => item.id === agentAtStart.id);
      if (!storedRun || !agent) {
        throw new Error("Run or Agent disappeared while promotion was committed");
      }
      storedRun.output = result.output;
      storedRun.usage = result.usage;
      storedRun.runVault = decision;
      storedRun.runVaultMetrics = structuredClone(metrics);
      appendRunVaultEvent(storedRun, "decided", decision.decidedAt, {
        outcome: decision.outcome,
        resolution: decision.resolution,
      });
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
          content: result.output,
          createdAt: committedAt,
        });
      }
      agent.codexThreadId = result.threadId;
      agent.lastError = null;
      agent.updatedAt = committedAt;
    });
  }

  private async publishCommittedPromotion(
    agentId: string,
    runId: string,
    metrics?: RunVaultRunMetrics,
  ): Promise<void> {
    const completedAt = now();
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      const agent = database.agents.find((item) => item.id === agentId);
      if (!storedRun || !agent) {
        throw new Error("Run or Agent disappeared while promotion was finalized");
      }
      if (storedRun.runVault?.outcome !== "promoted") {
        throw new Error("RunVault promotion commitment is missing");
      }
      storedRun.status = "completed";
      storedRun.error = null;
      storedRun.completedAt = completedAt;
      if (metrics) storedRun.runVaultMetrics = structuredClone(metrics);
      appendRunVaultEvent(storedRun, "promoted", completedAt, {
        outcome: "promoted",
        resolution: storedRun.runVault.resolution,
      });
      if (agent.status !== "stopped") {
        agent.status = "ready";
      }
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
      await this.store.mutate((database) => {
        const run = database.runs.find((item) => item.id === runAtStart.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!run || !agent) throw new HttpError(404, "Run or Agent not found");
        if (run.runVault?.outcome !== "quarantined") {
          throw new HttpError(409, "RunVault decision changed during approval");
        }
        run.runVault.outcome = "promoted";
        run.runVault.resolution = "human_approved";
        run.runVault.decidedAt = completedAt;
        run.runVaultMetrics.outcome = "promoted";
        appendRunVaultEvent(run, "approved", completedAt, {
          outcome: "promoted",
          resolution: "human_approved",
        });
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
      });
      const metrics = structuredClone(runAtStart.runVaultMetrics);
      metrics.outcome = "promoted";
      const cleanupStartedAt = performance.now();
      try {
        await this.runVaultWorkspaces.finalizePromotion(promotion);
        metrics.cleanupStatus = "completed";
      } catch {
        metrics.cleanupStatus = "failed";
      }
      metrics.cleanupDurationMs = elapsedMs(cleanupStartedAt);
      await this.store.mutate((database) => {
        const run = database.runs.find((item) => item.id === runAtStart.id);
        if (!run || run.runVault?.outcome !== "promoted") return;
        run.runVaultMetrics = metrics;
        appendRunVaultEvent(run, "promoted", now(), {
          outcome: "promoted",
          resolution: "human_approved",
        });
      });
      this.emitPersistedMetric(runAtStart.id, "staging_cleanup");
      return this.getRun(runAtStart.id);
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
      if (error instanceof UnsafeWorkspaceEntryError) {
        throw new HttpError(
          409,
          "Agent-created Git or dependency metadata cannot be approved; request a revision that removes it",
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

  async sweepExpiredQuarantines(referenceTime = Date.now()): Promise<number> {
    if (this.retentionSweepPromise) return this.retentionSweepPromise;
    const operation = this.performRetentionSweep(referenceTime).finally(() => {
      if (this.retentionSweepPromise === operation) {
        this.retentionSweepPromise = null;
      }
      this.scheduleRetentionSweep();
    });
    this.retentionSweepPromise = operation;
    return operation;
  }

  private async performRetentionSweep(referenceTime: number): Promise<number> {
    const expired = await this.store.mutate((database) => {
      const expiredAt = new Date(referenceTime).toISOString();
      const cleanups = new Map<string, string>();
      const newlyExpiredRunIds: string[] = [];
      let newlyExpired = 0;
      for (const run of database.runs) {
        const decision = run.runVault;
        if (
          decision?.outcome === "discarded" &&
          decision.resolution === "expired" &&
          decision.stagingWorkspaceId
        ) {
          cleanups.set(run.id, decision.stagingWorkspaceId);
          continue;
        }
        if (
          decision?.outcome !== "quarantined" ||
          !decision.expiresAt ||
          Date.parse(decision.expiresAt) > referenceTime
        ) {
          continue;
        }
        const agent = database.agents.find((item) => item.id === run.agentId);
        if (agent?.status === "busy") continue;
        if (decision.stagingWorkspaceId) {
          cleanups.set(run.id, decision.stagingWorkspaceId);
        }
        newlyExpired += 1;
        newlyExpiredRunIds.push(run.id);
        decision.outcome = "discarded";
        decision.reason = "retention_expired";
        decision.resolution = "expired";
        decision.decidedAt = expiredAt;
        run.runVaultMetrics.outcome = "discarded";
        appendRunVaultEvent(run, "expired", expiredAt, {
          outcome: "discarded",
          resolution: "expired",
        });
        appendRunVaultEvent(run, "discarded", expiredAt, {
          outcome: "discarded",
          resolution: "expired",
        });
        if (
          !decision.findings.some(
            (finding) => finding.code === "retention_expired",
          ) &&
          decision.findings.length < MAX_FINDINGS
        ) {
          decision.findings.push({
            code: "retention_expired",
            severity: "blocking",
            title: "Quarantine retention expired",
            explanation:
              "The retained staging workspace reached its configured expiry time.",
            paths: [],
            omittedPathCount: 0,
          });
        }
      }
      return {
        newlyExpired,
        newlyExpiredRunIds,
        cleanups: [...cleanups].map(([runId, stagingId]) => ({ runId, stagingId })),
      };
    });
    const cleanupResults = await Promise.all(
      expired.cleanups.map(async ({ runId, stagingId }) => {
        const metrics = structuredClone(this.getRun(runId).runVaultMetrics);
        await this.cleanupStaging(stagingId, metrics);
        return { runId, metrics };
      }),
    );
    if (cleanupResults.length > 0) {
      await this.store.mutate((database) => {
        for (const result of cleanupResults) {
          const run = database.runs.find((item) => item.id === result.runId);
          if (run?.runVault?.resolution === "expired") {
            run.runVaultMetrics = result.metrics;
          }
        }
      });
    }
    for (const runId of expired.newlyExpiredRunIds) {
      this.emitPersistedMetric(runId, "staging_cleanup");
    }
    return expired.newlyExpired;
  }

  private scheduleRetentionSweep(): void {
    if (this.retentionTimer) clearTimeout(this.retentionTimer);
    this.retentionTimer = null;
    const expiries = this.store
      .snapshot()
      .runs.flatMap((run) =>
        run.runVault?.outcome === "quarantined" && run.runVault.expiresAt
          ? [Date.parse(run.runVault.expiresAt)]
          : [],
      )
      .filter(Number.isFinite);
    if (expiries.length === 0) return;
    const delay = Math.min(
      60_000,
      Math.max(100, Math.min(...expiries) - Date.now()),
    );
    this.retentionTimer = setTimeout(() => {
      void this.sweepExpiredQuarantines().catch(() => undefined);
    }, delay);
    this.retentionTimer.unref();
  }

  private policySnapshot(capturedAt: string): RunVaultPolicySnapshot {
    return {
      ...structuredClone(this.config.runVaultPolicy),
      capturedAt,
    };
  }

  private async recordRunProgress(
    runId: string,
    type: RunVaultLifecycleEventType,
    at: string,
    details: Omit<RunVaultLifecycleEvent, "type" | "at"> = {},
    metrics: Partial<RunVaultRunMetrics> = {},
  ): Promise<void> {
    await this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === runId);
      if (!run) return;
      appendRunVaultEvent(run, type, at, details);
      Object.assign(run.runVaultMetrics, metrics);
    });
  }

  private async cleanupStaging(
    stagingId: string,
    metrics: RunVaultRunMetrics,
  ): Promise<void> {
    const startedAt = performance.now();
    try {
      await this.runVaultWorkspaces.discardStagingWorkspace(stagingId);
      metrics.cleanupStatus = "completed";
    } catch {
      metrics.cleanupStatus = "failed";
    } finally {
      metrics.cleanupDurationMs =
        (metrics.cleanupDurationMs ?? 0) + elapsedMs(startedAt);
    }
  }

  private emitPersistedMetric(
    runId: string,
    name: "run_decision" | "staging_cleanup",
  ): void {
    const run = this.getRun(runId);
    emitRunVaultMetric(name, run, now());
  }

  private async runWithStagingQuota(
    request: RunnerRequest,
    stagingPath: string,
    quota: StagingQuota,
  ): Promise<RunnerResult> {
    let quotaError: StagingQuotaExceededError | null = null;
    let monitorError: unknown = null;
    let activeCheck: Promise<void> = Promise.resolve();
    const check = async (): Promise<void> => {
      if (quotaError || monitorError) return;
      try {
        await this.runVaultWorkspaces.assertStagingWithinQuota(
          stagingPath,
          quota,
        );
      } catch (error) {
        if (error instanceof StagingQuotaExceededError) {
          quotaError = error;
        } else {
          monitorError = error;
        }
        await this.runner.cancel(request.agentId).catch(() => false);
      }
    };
    const timer = setInterval(() => {
      activeCheck = activeCheck.then(check);
    }, this.config.runVaultQuotaPollMs);
    timer.unref();
    try {
      let result: RunnerResult;
      try {
        result = await this.runner.run(request);
      } catch (error) {
        await activeCheck;
        if (quotaError) throw quotaError;
        if (monitorError) throw monitorError;
        throw error;
      }
      await activeCheck;
      await check();
      if (quotaError) throw quotaError;
      if (monitorError) throw monitorError;
      return result;
    } finally {
      clearInterval(timer);
      await activeCheck;
    }
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
        await execution.catch(() => undefined);
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}

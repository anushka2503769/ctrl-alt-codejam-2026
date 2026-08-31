import { channel } from "node:diagnostics_channel";
import type {
  AgentRun,
  RunVaultLifecycleEvent,
  RunVaultLifecycleEventType,
  RunVaultRunMetrics,
} from "./types.js";

export const MAX_RUNVAULT_LIFECYCLE_EVENTS = 100;

export interface RunVaultMetricEvent {
  name: "run_decision" | "staging_cleanup";
  at: string;
  runId: string;
  agentId: string;
  outcome: RunVaultRunMetrics["outcome"];
  verificationStatus: RunVaultRunMetrics["verificationStatus"];
  cleanupStatus: RunVaultRunMetrics["cleanupStatus"];
  stagingDurationMs: number | null;
  verificationDurationMs: number | null;
  cleanupDurationMs: number | null;
  stagedBytes: number | null;
  changedBytes: number;
}

export const runVaultMetricsChannel = channel("runvault.metrics");

export function emptyRunVaultMetrics(): RunVaultRunMetrics {
  return {
    stagingDurationMs: null,
    stagingCopiedEntries: null,
    stagingCopiedBytes: null,
    agentDurationMs: null,
    inspectionDurationMs: null,
    verificationDurationMs: null,
    decisionDurationMs: null,
    cleanupDurationMs: null,
    cleanupStatus: "not_required",
    changedFileCount: 0,
    changedBytes: 0,
    outcome: null,
    verificationStatus: null,
  };
}

export function appendRunVaultEvent(
  run: Pick<AgentRun, "runVaultEvents">,
  type: RunVaultLifecycleEventType,
  at: string,
  details: Omit<RunVaultLifecycleEvent, "type" | "at"> = {},
): void {
  const event: RunVaultLifecycleEvent = { type, at, ...details };
  run.runVaultEvents.push(event);
  if (run.runVaultEvents.length > MAX_RUNVAULT_LIFECYCLE_EVENTS) {
    run.runVaultEvents.splice(
      0,
      run.runVaultEvents.length - MAX_RUNVAULT_LIFECYCLE_EVENTS,
    );
  }
}

export function emitRunVaultMetric(
  name: RunVaultMetricEvent["name"],
  run: Pick<AgentRun, "id" | "agentId" | "runVaultMetrics">,
  at: string,
): void {
  const metrics = run.runVaultMetrics;
  runVaultMetricsChannel.publish({
    name,
    at,
    runId: run.id,
    agentId: run.agentId,
    outcome: metrics.outcome,
    verificationStatus: metrics.verificationStatus,
    cleanupStatus: metrics.cleanupStatus,
    stagingDurationMs: metrics.stagingDurationMs,
    verificationDurationMs: metrics.verificationDurationMs,
    cleanupDurationMs: metrics.cleanupDurationMs,
    stagedBytes: metrics.stagingCopiedBytes,
    changedBytes: metrics.changedBytes,
  } satisfies RunVaultMetricEvent);
}

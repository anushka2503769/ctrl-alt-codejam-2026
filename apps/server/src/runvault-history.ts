import type {
  AgentRun,
  Database,
  RunVaultFindingCode,
  RunVaultHistoryEntry,
  RunVaultOutcome,
  RunVaultVerificationStatus,
} from "./types.js";

export interface RunVaultHistoryFilters {
  agentId?: string | undefined;
  outcome?: RunVaultOutcome | undefined;
  finding?: RunVaultFindingCode | undefined;
  verification?: RunVaultVerificationStatus | undefined;
  lineage?: "root" | "revision" | undefined;
  lineageRunId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
}

function lineageFamily(runs: AgentRun[], requestedId: string): Set<string> {
  const family = new Set<string>([requestedId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const run of runs) {
      if (
        family.has(run.id) ||
        (run.parentRunId && family.has(run.parentRunId)) ||
        (run.supersededByRunId && family.has(run.supersededByRunId))
      ) {
        for (const candidate of [run.id, run.parentRunId, run.supersededByRunId]) {
          if (candidate && !family.has(candidate)) {
            family.add(candidate);
            changed = true;
          }
        }
      }
    }
  }
  return family;
}

function historyEntry(database: Database, run: AgentRun): RunVaultHistoryEntry {
  const decision = run.runVault;
  return {
    id: run.id,
    agentId: run.agentId,
    agentName:
      database.agents.find((agent) => agent.id === run.agentId)?.name ?? null,
    parentRunId: run.parentRunId,
    supersededByRunId: run.supersededByRunId,
    revisionNumber: run.revisionNumber,
    status: run.status,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    outcome: decision?.outcome ?? null,
    reason: decision?.reason ?? null,
    resolution: decision?.resolution ?? null,
    verificationStatus: decision?.verification.status ?? null,
    findingCodes: [...new Set(decision?.findings.map((item) => item.code) ?? [])],
    changedFileCount: decision
      ? decision.changedFiles.addedCount +
        decision.changedFiles.modifiedCount +
        decision.changedFiles.deletedCount
      : 0,
    changedBytes: decision?.changedFiles.changedBytes ?? 0,
    retainedAt: decision?.retainedAt ?? null,
    expiresAt: decision?.expiresAt ?? null,
  };
}

export function filterRunVaultHistory(
  database: Database,
  filters: RunVaultHistoryFilters,
): RunVaultHistoryEntry[] {
  const family = filters.lineageRunId
    ? lineageFamily(database.runs, filters.lineageRunId)
    : null;
  const from = filters.from ? Date.parse(filters.from) : null;
  const to = filters.to ? Date.parse(filters.to) : null;
  const limit = Math.min(200, Math.max(1, filters.limit ?? 100));

  return database.runs
    .filter((run) => {
      const decision = run.runVault;
      const createdAt = Date.parse(run.createdAt);
      return (
        (!filters.agentId || run.agentId === filters.agentId) &&
        (!filters.outcome || decision?.outcome === filters.outcome) &&
        (!filters.finding ||
          decision?.findings.some((finding) => finding.code === filters.finding)) &&
        (!filters.verification ||
          decision?.verification.status === filters.verification) &&
        (!filters.lineage ||
          (filters.lineage === "root"
            ? run.parentRunId === null
            : run.parentRunId !== null)) &&
        (!family || family.has(run.id)) &&
        (from === null || createdAt >= from) &&
        (to === null || createdAt <= to)
      );
    })
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id),
    )
    .slice(0, limit)
    .map((run) => historyEntry(database, run));
}

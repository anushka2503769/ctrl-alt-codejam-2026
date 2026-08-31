import { useEffect, useState } from "react";
import { api } from "./api";
import {
  findingCopy,
  reasonCopy,
  verificationCopy,
  workspaceOutcomeCopy,
} from "./runvault-copy";
import type {
  Agent,
  RunVaultDiagnostics,
  RunVaultFindingCode,
  RunVaultHistoryEntry,
  RunVaultOutcome,
  RunVaultVerificationStatus,
} from "./types";

interface RunVaultHistoryProps {
  agents: Agent[];
  onOpenRun: (run: RunVaultHistoryEntry) => void;
}

interface HistoryForm {
  agentId: string;
  outcome: "" | RunVaultOutcome;
  finding: "" | RunVaultFindingCode;
  verification: "" | RunVaultVerificationStatus;
  lineage: "" | "root" | "revision";
  lineageRunId: string;
  from: string;
  to: string;
}

const initialFilters: HistoryForm = {
  agentId: "",
  outcome: "",
  finding: "",
  verification: "",
  lineage: "",
  lineageRunId: "",
  from: "",
  to: "",
};

const findingCodes = Object.keys(findingCopy) as RunVaultFindingCode[];

function bytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

function dateBoundary(value: string, end: boolean): string | undefined {
  if (!value) return undefined;
  return new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}`)
    .toISOString();
}

export function RunVaultHistory({ agents, onOpenRun }: RunVaultHistoryProps) {
  const [filters, setFilters] = useState<HistoryForm>(initialFilters);
  const [runs, setRuns] = useState<RunVaultHistoryEntry[]>([]);
  const [diagnostics, setDiagnostics] = useState<RunVaultDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (next: HistoryForm) => {
    setLoading(true);
    setError(null);
    try {
      const [history, health] = await Promise.all([
        api.runVaultHistory({
          agentId: next.agentId || undefined,
          outcome: next.outcome || undefined,
          finding: next.finding || undefined,
          verification: next.verification || undefined,
          lineage: next.lineage || undefined,
          lineageRunId: next.lineageRunId.trim() || undefined,
          from: dateBoundary(next.from, false),
          to: dateBoundary(next.to, true),
          limit: 200,
        }),
        api.runVaultDiagnostics(),
      ]);
      setRuns(history.runs);
      setDiagnostics(health.diagnostics);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(initialFilters);
  }, []);

  const exportEvidence = async (runId: string) => {
    try {
      const { evidence } = await api.runVaultEvidence(runId);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(evidence, null, 2) + "\n"], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `runvault-evidence-${runId}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <section className="history-page" aria-labelledby="history-title">
      <header className="history-header">
        <div>
          <span className="eyebrow">Operations</span>
          <h1 id="history-title">RunVault history</h1>
          <p>Search bounded decision evidence across Agents and revision lineages.</p>
        </div>
        <button className="button button-ghost" onClick={() => void load(filters)}>
          Refresh
        </button>
      </header>

      {diagnostics && (
        <div className="diagnostic-grid" aria-label="RunVault diagnostics">
          <article>
            <span>Verifier Runtime</span>
            <strong>{diagnostics.verifierAvailable ? "Available" : "Unavailable"}</strong>
          </article>
          <article>
            <span>Retained staging</span>
            <strong>{diagnostics.staging.retainedRunCount} Runs · {bytes(diagnostics.staging.retainedBytes)}</strong>
          </article>
          <article>
            <span>Dependency caches</span>
            <strong>{diagnostics.dependencies.validCacheCount} valid · {bytes(diagnostics.dependencies.totalBytes)}</strong>
          </article>
          <article>
            <span>Cleanup health</span>
            <strong>{diagnostics.metrics.cleanupFailures} failures · {diagnostics.staging.orphanCount} orphans</strong>
          </article>
        </div>
      )}

      <form
        className="history-filters"
        onSubmit={(event) => {
          event.preventDefault();
          void load(filters);
        }}
      >
        <label>
          Agent
          <select value={filters.agentId} onChange={(event) => setFilters({ ...filters, agentId: event.target.value })}>
            <option value="">All Agents</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
        <label>
          Outcome
          <select value={filters.outcome} onChange={(event) => setFilters({ ...filters, outcome: event.target.value as HistoryForm["outcome"] })}>
            <option value="">All outcomes</option>
            <option value="promoted">Applied</option>
            <option value="quarantined">Needs review</option>
            <option value="discarded">Not applied</option>
          </select>
        </label>
        <label>
          Finding
          <select value={filters.finding} onChange={(event) => setFilters({ ...filters, finding: event.target.value as HistoryForm["finding"] })}>
            <option value="">All findings</option>
            {findingCodes.map((code) => <option key={code} value={code}>{findingCopy[code].title}</option>)}
          </select>
        </label>
        <label>
          Verification
          <select value={filters.verification} onChange={(event) => setFilters({ ...filters, verification: event.target.value as HistoryForm["verification"] })}>
            <option value="">All verification</option>
            <option value="passed">Passed</option>
            <option value="failed">Failed</option>
            <option value="skipped">Skipped</option>
            <option value="unavailable">Unavailable</option>
          </select>
        </label>
        <label>
          Lineage
          <select value={filters.lineage} onChange={(event) => setFilters({ ...filters, lineage: event.target.value as HistoryForm["lineage"] })}>
            <option value="">Roots and revisions</option>
            <option value="root">Root Runs</option>
            <option value="revision">Revision Runs</option>
          </select>
        </label>
        <label>
          Lineage Run ID
          <input value={filters.lineageRunId} onChange={(event) => setFilters({ ...filters, lineageRunId: event.target.value })} placeholder="UUID family filter" />
        </label>
        <label>
          From
          <input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} />
        </label>
        <label>
          To
          <input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} />
        </label>
        <div className="history-filter-actions">
          <button className="button button-primary">Apply filters</button>
          <button type="button" className="button button-ghost" onClick={() => { setFilters(initialFilters); void load(initialFilters); }}>
            Reset
          </button>
        </div>
      </form>

      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="history-results" aria-live="polite">
        <div className="history-result-heading">
          <strong>{loading ? "Loading Runs…" : `${runs.length} Runs`}</strong>
          <span>Exports exclude prompts, outputs, errors, and verification output.</span>
        </div>
        {!loading && runs.length === 0 && <div className="review-empty">No Runs match these filters.</div>}
        {runs.map((run) => (
          <article className="history-row" key={run.id}>
            <div>
              <span className="eyebrow">{run.agentName ?? "Deleted Agent"} · {new Date(run.createdAt).toLocaleString()}</span>
              <strong>{run.outcome ? workspaceOutcomeCopy[run.outcome].label : run.status}</strong>
              <small>{run.reason ? reasonCopy[run.reason] : "Decision pending"}</small>
            </div>
            <div className="history-row-evidence">
              <span>{run.verificationStatus ? verificationCopy({ status: run.verificationStatus, command: null, redactedSummary: null }).label : "No verification evidence"}</span>
              <span>{run.changedFileCount} files · {bytes(run.changedBytes)}</span>
              <span>{run.parentRunId ? `Revision ${run.revisionNumber}` : "Root Run"}</span>
            </div>
            <div className="history-row-actions">
              <button
                className="button button-ghost"
                disabled={!agents.some((agent) => agent.id === run.agentId)}
                title={run.agentName ? "Open this Run" : "The Agent was deleted"}
                onClick={() => onOpenRun(run)}
              >
                Open Run
              </button>
              {run.outcome && <button className="button button-ghost" onClick={() => void exportEvidence(run.id)}>Export JSON</button>}
            </div>
          </article>
        ))}
      </div>

      <p className="history-disclaimer">
        This is a single-process JSON audit aid for one operator. It is not a tamper-proof or multi-user audit log.
      </p>
    </section>
  );
}

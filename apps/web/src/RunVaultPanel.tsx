import type {
  AgentRun,
} from "./types";
import {
  reasonCopy,
  resolutionCopy,
  verificationCopy,
  workspaceOutcomeCopy,
} from "./runvault-copy";

export type RunVaultAction = "approve" | "discard";

interface RunVaultPanelProps {
  run: AgentRun;
  action: RunVaultAction | null;
  onAction: (action: RunVaultAction) => void;
}

function fileSummary(run: AgentRun): string {
  const changes = run.runVault?.changedFiles;
  if (!changes) return "No change evidence";
  const total = changes.addedCount + changes.modifiedCount + changes.deletedCount;
  if (total === 0) return "No file changes";
  return `${total} file${total === 1 ? "" : "s"} changed`;
}

export function RunVaultPanel({ run, action, onAction }: RunVaultPanelProps) {
  const decision = run.runVault;
  if (!decision) return null;
  const awaitingDecision = decision.outcome === "quarantined";
  const workspaceCopy = workspaceOutcomeCopy[decision.outcome];
  const testsCopy = verificationCopy(decision.verification);

  return (
    <section
      className={`runvault-panel runvault-${decision.outcome}`}
      aria-labelledby={`runvault-title-${run.id}`}
      aria-live="polite"
    >
      <div className="runvault-heading">
        <div className="runvault-identity">
          <span className="runvault-mark" aria-hidden="true">RV</span>
          <div>
            <span className="eyebrow">Transactional workspace</span>
            <h3 id={`runvault-title-${run.id}`}>RunVault decision</h3>
          </div>
        </div>
        <span
          className={`runvault-outcome outcome-${decision.outcome}`}
          aria-label={`Workspace outcome: ${workspaceCopy.label}`}
        >
          <span aria-hidden="true" />
          {workspaceCopy.shortLabel}
        </span>
      </div>

      <div className="runvault-reason">
        <strong>{reasonCopy[decision.reason]}</strong>
        <span>{resolutionCopy[decision.resolution]}</span>
      </div>

      <div className="runvault-status-grid">
        <section aria-label={`Workspace outcome: ${workspaceCopy.label}`}>
          <span className="runvault-status-label">Workspace outcome</span>
          <strong>{workspaceCopy.label}</strong>
          <p>{workspaceCopy.explanation}</p>
        </section>
        <section aria-label={`Verification status: ${testsCopy.label}`}>
          <span className="runvault-status-label">Verification</span>
          <strong className={`evidence-${decision.verification.status}`}>
            {testsCopy.label}
          </strong>
          <p>{testsCopy.explanation}</p>
          {decision.verification.command && (
            <code>{decision.verification.command}</code>
          )}
        </section>
      </div>

      <dl className="runvault-evidence">
        <div>
          <dt>Change summary</dt>
          <dd>
            {fileSummary(run)}
            <span className="change-count-detail">
              {decision.changedFiles.addedCount} added · {decision.changedFiles.modifiedCount} modified · {decision.changedFiles.deletedCount} deleted
            </span>
          </dd>
        </div>
        <div>
          <dt>Trusted baseline during Run</dt>
          <dd className={decision.trustedWorkspaceChanged ? "evidence-warning" : "evidence-passed"}>
            {decision.trustedWorkspaceChanged ? "Changed externally" : "No concurrent change detected"}
          </dd>
        </div>
      </dl>

      {decision.changedFiles.protectedPathsTouched.length > 0 && (
        <div className="protected-paths">
          <span className="protected-paths-label">Protected paths</span>
          <div>
            {decision.changedFiles.protectedPathsTouched.map((protectedPath) => (
              <code key={protectedPath}>{protectedPath}</code>
            ))}
          </div>
          <p>Only path metadata is shown. File contents remain hidden.</p>
        </div>
      )}

      {decision.verification.redactedSummary && (
        <details className="verification-details">
          <summary>Verification summary</summary>
          <p>{decision.verification.redactedSummary}</p>
        </details>
      )}

      {awaitingDecision && (
        <div className="runvault-actions">
          <p>
            This staged workspace is isolated. Choose whether it can replace the
            trusted workspace.
          </p>
          <div>
            <button
              type="button"
              className="button runvault-discard"
              disabled={action !== null}
              onClick={() => onAction("discard")}
            >
              {action === "discard" ? "Discarding…" : "Discard staged work"}
            </button>
            <button
              type="button"
              className="button runvault-approve"
              disabled={action !== null}
              onClick={() => onAction("approve")}
            >
              {action === "approve" ? "Promoting…" : "Approve and promote"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

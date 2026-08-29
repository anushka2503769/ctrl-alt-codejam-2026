import type {
  AgentRun,
  RunVaultOutcome,
  RunVaultReason,
  RunVaultResolution,
} from "./types";

export type RunVaultAction = "approve" | "discard";

interface RunVaultPanelProps {
  run: AgentRun;
  action: RunVaultAction | null;
  onAction: (action: RunVaultAction) => void;
}

const outcomeLabels: Record<RunVaultOutcome, string> = {
  promoted: "Promoted",
  quarantined: "Quarantined",
  discarded: "Discarded",
};

const reasonLabels: Record<RunVaultReason, string> = {
  verified_safe: "Verified changes passed policy",
  protected_path: "Protected workspace path changed",
  change_limit_exceeded: "Change limit exceeded",
  dependency_change: "Dependency configuration changed",
  verification_failed: "Verification did not pass",
  run_failed: "Agent execution failed",
  cancelled: "Run was cancelled",
  timed_out: "Run timed out",
  unsafe_file: "Unsafe file type introduced",
  unsafe_link: "Symbolic link introduced",
  trusted_workspace_changed: "Trusted workspace changed during the Run",
};

const resolutionLabels: Record<RunVaultResolution, string> = {
  policy: "Automatic policy decision",
  human_approved: "Approved by an operator",
  human_discarded: "Discarded by an operator",
};

function fileSummary(run: AgentRun): string {
  const changes = run.runVault?.changedFiles;
  if (!changes) return "No change evidence";
  const total = changes.addedCount + changes.modifiedCount + changes.deletedCount;
  if (total === 0) return "No file changes";
  return `${total} file${total === 1 ? "" : "s"} changed`;
}

function verificationSummary(run: AgentRun): string {
  const verification = run.runVault?.verification;
  if (!verification) return "Not available";
  const command = verification.command ? `${verification.command} · ` : "";
  return `${command}${verification.status}`;
}

export function RunVaultPanel({ run, action, onAction }: RunVaultPanelProps) {
  const decision = run.runVault;
  if (!decision) return null;
  const awaitingDecision = decision.outcome === "quarantined";

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
        <span className={`runvault-outcome outcome-${decision.outcome}`}>
          <span aria-hidden="true" />
          {outcomeLabels[decision.outcome]}
        </span>
      </div>

      <div className="runvault-reason">
        <strong>{reasonLabels[decision.reason]}</strong>
        <span>{resolutionLabels[decision.resolution]}</span>
      </div>

      <dl className="runvault-evidence">
        <div>
          <dt>Verification</dt>
          <dd className={`evidence-${decision.verification.status}`}>
            {verificationSummary(run)}
          </dd>
        </div>
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
          <dt>Trusted workspace</dt>
          <dd className={decision.trustedWorkspaceChanged ? "evidence-warning" : "evidence-passed"}>
            {decision.trustedWorkspaceChanged ? "Changed externally" : "Unchanged"}
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

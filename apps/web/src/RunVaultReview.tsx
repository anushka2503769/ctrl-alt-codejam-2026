import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { RunVaultPanel, type RunVaultAction } from "./RunVaultPanel";
import type {
  AgentRun,
  RunVaultFileChange,
  RunVaultReviewEvidence,
  RunVaultTextDiff,
} from "./types";

interface RunVaultReviewProps {
  run: AgentRun;
  action: RunVaultAction | null;
  onAction: (action: RunVaultAction) => void;
  revising: boolean;
  onRevision: (instructions: string) => void;
}

const blockedDiffCopy: Record<RunVaultTextDiff["status"], string> = {
  available: "",
  protected: "Contents are hidden because this is a protected path.",
  binary: "Binary file contents are not displayed.",
  symbolic_link: "Symbolic-link targets and contents are not displayed.",
  too_large: "This file exceeds the safe review size or line limit.",
  unavailable: "Diff content is unavailable.",
};

function classifications(file: RunVaultFileChange): string[] {
  return [
    file.protected ? "Protected" : null,
    file.dependencyFile ? "Dependency" : null,
    file.executable ? "Executable" : null,
    file.binary ? "Binary" : null,
    file.symbolicLink ? "Symbolic link" : null,
  ].filter((value): value is string => value !== null);
}

export function RunVaultReview({
  run,
  action,
  onAction,
  revising,
  onRevision,
}: RunVaultReviewProps) {
  const decision = run.runVault;
  const [review, setReview] = useState<RunVaultReviewEvidence | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<RunVaultTextDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [revisionInstructions, setRevisionInstructions] = useState("");

  useEffect(() => {
    let active = true;
    setReview(null);
    setReviewError(null);
    setSelectedPath(null);
    setDiff(null);
    void api.runVaultReview(run.id).then(
      ({ review: evidence }) => {
        if (active) setReview(evidence);
      },
      (reason: unknown) => {
        if (active) {
          setReviewError(reason instanceof Error ? reason.message : String(reason));
        }
      },
    );
    return () => { active = false; };
  }, [run.id, decision?.decidedAt]);

  const groupedFiles = useMemo(() => {
    const groups: Record<RunVaultFileChange["kind"], RunVaultFileChange[]> = {
      added: [], modified: [], deleted: [],
    };
    for (const file of decision?.changedFiles.files ?? []) groups[file.kind].push(file);
    return groups;
  }, [decision]);

  if (!decision) return null;

  const selectFile = async (file: RunVaultFileChange) => {
    setSelectedPath(file.path);
    setDiff(null);
    if (file.protected || file.binary || file.symbolicLink) {
      setDiff({
        path: file.path,
        status: file.protected
          ? "protected"
          : file.binary ? "binary" : "symbolic_link",
        diff: null,
        truncated: false,
      });
      return;
    }
    if (review?.availability !== "available") return;
    setDiffLoading(true);
    try {
      const result = await api.runVaultDiff(run.id, file.path);
      setDiff(result.diff);
    } catch (reason) {
      setDiff({
        path: file.path,
        status: "unavailable",
        diff: reason instanceof Error ? reason.message : String(reason),
        truncated: false,
      });
    } finally {
      setDiffLoading(false);
    }
  };

  return (
    <section className="run-review" aria-labelledby={`review-title-${run.id}`}>
      <header className="run-review-header">
        <div>
          <span className="eyebrow">Focused review</span>
          <h3 id={`review-title-${run.id}`}>Run review</h3>
        </div>
        <code>{run.id}</code>
      </header>

      <div className="run-review-prompt">
        <strong>Requested work</strong>
        <p>{run.prompt}</p>
      </div>

      {(run.parentRunId || run.supersededByRunId) && (
        <div className="run-lineage">
          <strong>Run lineage</strong>
          {run.parentRunId && (
            <span>Revision {run.revisionNumber} of <code>{run.parentRunId}</code></span>
          )}
          {run.supersededByRunId && (
            <span>Superseded by <code>{run.supersededByRunId}</code></span>
          )}
        </div>
      )}

      <div className={`review-availability review-${review?.availability ?? "loading"}`} role="status">
        {reviewError
          ? `Review unavailable: ${reviewError}`
          : review?.message ?? "Revalidating retained review evidence…"}
      </div>

      <RunVaultPanel
        run={run}
        action={action}
        onAction={onAction}
        approvalDisabled={
          decision.outcome === "quarantined" &&
          review?.availability !== "available"
        }
      />

      {decision.outcome === "quarantined" && (
        <form
          className="review-revision"
          onSubmit={(event) => {
            event.preventDefault();
            if (revisionInstructions.trim()) onRevision(revisionInstructions.trim());
          }}
        >
          <label htmlFor={`revision-${run.id}`}>Request revisions</label>
          <p>Create a new child Run from this staged proposal and provisional thread.</p>
          <textarea
            id={`revision-${run.id}`}
            value={revisionInstructions}
            onChange={(event) => setRevisionInstructions(event.target.value)}
            placeholder="Describe what the Agent should change before another review…"
            maxLength={50_000}
            rows={3}
            disabled={revising || review?.availability !== "available"}
          />
          <button
            type="submit"
            className="button button-primary"
            disabled={
              revising ||
              review?.availability !== "available" ||
              !revisionInstructions.trim()
            }
          >
            {revising ? "Starting revision…" : "Create revision Run"}
          </button>
        </form>
      )}

      <section className="review-section" aria-labelledby={`findings-${run.id}`}>
        <h4 id={`findings-${run.id}`}>Findings</h4>
        {decision.findings.length === 0 ? (
          <p className="review-empty">No policy findings were recorded.</p>
        ) : (
          <ul className="review-findings">
            {decision.findings.map((finding) => (
              <li key={finding.code}>
                <strong>{finding.title}</strong>
                <span>{finding.explanation}</span>
                {finding.paths.length > 0 && <code>{finding.paths.join(", ")}</code>}
                {finding.omittedPathCount > 0 && <small>+{finding.omittedPathCount} paths omitted</small>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="review-section" aria-labelledby={`files-${run.id}`}>
        <h4 id={`files-${run.id}`}>Changed files</h4>
        {(["added", "modified", "deleted"] as const).map((kind) => (
          <div className="review-file-group" key={kind}>
            <h5>{kind} ({groupedFiles[kind].length})</h5>
            {groupedFiles[kind].map((file) => {
              const labels = classifications(file);
              return (
                <button
                  type="button"
                  key={file.path}
                  className={selectedPath === file.path ? "selected" : ""}
                  onClick={() => void selectFile(file)}
                >
                  <code>{file.path}</code>
                  <span>{labels.length > 0 ? labels.join(" · ") : "Text"}</span>
                </button>
              );
            })}
          </div>
        ))}
        {decision.changedFiles.omittedFileCount > 0 && (
          <p className="review-empty">
            {decision.changedFiles.omittedFileCount} additional files omitted from bounded evidence.
          </p>
        )}
      </section>

      {selectedPath && (
        <section className="review-section review-diff" aria-labelledby={`diff-${run.id}`}>
          <h4 id={`diff-${run.id}`}>Diff: <code>{selectedPath}</code></h4>
          {diffLoading ? <p>Loading bounded diff…</p> : diff?.status === "available" ? (
            <>
              <pre>{diff.diff}</pre>
              {diff.truncated && <p>Diff output was truncated.</p>}
            </>
          ) : (
            <p>{diff ? blockedDiffCopy[diff.status] || diff.diff : review?.message}</p>
          )}
        </section>
      )}
    </section>
  );
}

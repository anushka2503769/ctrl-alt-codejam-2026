import type {
  RunVaultChangeSummary,
  RunVaultFileChange,
  RunVaultOutcome,
  RunVaultReason,
  RunVaultFinding,
  RunVaultPolicySnapshot,
  RunVaultVerificationMode,
  RunVaultVerificationStatus,
} from "./types.js";

export const DEFAULT_MAX_CHANGED_FILES = 20;
export const DEFAULT_MAX_DELETED_FILES = 5;
export const DEFAULT_MAX_CHANGED_BYTES = 25 * 1024 * 1024;
export const MAX_EVIDENCE_FILES = 100;
export const MAX_FINDINGS = 50;
export const MAX_FINDING_PATHS = 50;

export type RunVaultExecutionStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "quota_exceeded";

export interface RunVaultPolicyInput {
  executionStatus: RunVaultExecutionStatus;
  verificationStatus: RunVaultVerificationStatus;
  changes: RunVaultFileChange[];
  trustedWorkspaceChanged?: boolean;
  maxChangedFiles?: number;
  maxDeletedFiles?: number;
  maxChangedBytes?: number;
  changedBytes?: number;
  verificationMode?: RunVaultVerificationMode;
  policy?: RunVaultPolicySnapshot;
}

export interface RunVaultPolicyResult {
  outcome: RunVaultOutcome;
  reason: RunVaultReason;
  changedFiles: RunVaultChangeSummary;
  findings: RunVaultFinding[];
}

function summarizeChanges(
  changes: RunVaultFileChange[],
  changedBytes: number,
): RunVaultChangeSummary {
  const protectedPathsTouched = changes
    .filter((change) => change.protected)
    .map((change) => change.path)
    .sort();

  const ordered = [...changes].sort(
    (a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind),
  );
  return {
    addedCount: changes.filter((change) => change.kind === "added").length,
    modifiedCount: changes.filter((change) => change.kind === "modified").length,
    deletedCount: changes.filter((change) => change.kind === "deleted").length,
    protectedPathsTouched,
    files: ordered.slice(0, MAX_EVIDENCE_FILES),
    omittedFileCount: Math.max(0, ordered.length - MAX_EVIDENCE_FILES),
    changedBytes,
  };
}

function finding(
  code: RunVaultFinding["code"],
  title: string,
  explanation: string,
  paths: string[] = [],
): RunVaultFinding {
  const ordered = [...new Set(paths)].sort();
  return {
    code,
    severity:
      code === "trusted_workspace_changed" ||
      code === "verification_failed" ||
      code === "verification_required" ||
      code === "verification_unavailable" ||
      code === "staging_quota_exceeded" ||
      code.startsWith("execution_")
        ? "blocking"
        : "warning",
    title,
    explanation,
    paths: ordered.slice(0, MAX_FINDING_PATHS),
    omittedPathCount: Math.max(0, ordered.length - MAX_FINDING_PATHS),
  };
}

function collectFindings(
  input: RunVaultPolicyInput,
  summary: RunVaultChangeSummary,
): RunVaultFinding[] {
  const findings: RunVaultFinding[] = [];
  if (input.executionStatus === "cancelled") {
    findings.push(
      finding(
        "execution_cancelled",
        "Execution cancelled",
        "The Agent execution was cancelled.",
      ),
    );
  }
  if (input.executionStatus === "timed_out") {
    findings.push(
      finding(
        "execution_timed_out",
        "Execution timed out",
        "The Agent execution exceeded its time limit.",
      ),
    );
  }
  if (input.executionStatus === "failed") {
    findings.push(
      finding(
        "execution_failed",
        "Execution failed",
        "The Agent execution failed.",
      ),
    );
  }
  if (input.executionStatus === "quota_exceeded") {
    findings.push(
      finding(
        "staging_quota_exceeded",
        "Staging quota exceeded",
        "The Run exceeded its managed staging storage quota.",
      ),
    );
  }
  if (input.verificationStatus === "failed") {
    findings.push(
      finding(
        "verification_failed",
        "Verification failed",
        "Configured verification did not pass.",
      ),
    );
  }
  if (input.verificationStatus === "unavailable") {
    findings.push(
      finding(
        "verification_unavailable",
        "Verification unavailable",
        "Configured verification could not run with matching managed dependencies.",
      ),
    );
  }
  const verificationMode =
    input.policy?.verificationMode ??
    input.verificationMode ??
    "allow-skipped";
  if (
    verificationMode === "require-verification" &&
    input.verificationStatus !== "passed" &&
    input.verificationStatus !== "failed"
  ) {
    findings.push(
      finding(
        "verification_required",
        "Verification required",
        "This policy profile requires configured verification to pass before promotion.",
      ),
    );
  }
  if (input.trustedWorkspaceChanged) {
    findings.push(
      finding(
        "trusted_workspace_changed",
        "Trusted workspace changed",
        "The trusted workspace changed during this Run.",
      ),
    );
  }
  const paths = (predicate: (change: RunVaultFileChange) => boolean) =>
    input.changes.filter(predicate).map((change) => change.path);
  if (input.changes.some((change) => change.symbolicLink)) {
    findings.push(
      finding(
        "unsafe_link",
        "Unsafe symbolic link",
        "A changed symbolic link requires review.",
        paths((change) => change.symbolicLink),
      ),
    );
  }
  if (input.changes.some((change) => change.protected)) {
    findings.push(
      finding(
        "protected_path",
        "Protected path changed",
        "A protected path was changed.",
        paths((change) => change.protected),
      ),
    );
  }
  if (input.changes.some((change) => change.dependencyFile)) {
    findings.push(
      finding(
        "dependency_change",
        "Dependency file changed",
        "A dependency manifest or lockfile was changed.",
        paths((change) => change.dependencyFile),
      ),
    );
  }
  if (input.changes.some((change) => change.executable || change.binary)) {
    findings.push(
      finding(
        "unsafe_file",
        "Unsafe file changed",
        "A changed file is executable or binary.",
        paths((change) => change.executable || change.binary),
      ),
    );
  }
  const maxChangedFiles =
    input.policy?.maxChangedFiles ??
    input.maxChangedFiles ??
    DEFAULT_MAX_CHANGED_FILES;
  const maxDeletedFiles =
    input.policy?.maxDeletedFiles ??
    input.maxDeletedFiles ??
    DEFAULT_MAX_DELETED_FILES;
  const maxChangedBytes =
    input.policy?.maxChangedBytes ??
    input.maxChangedBytes ??
    DEFAULT_MAX_CHANGED_BYTES;
  if (input.changes.length > maxChangedFiles) {
    findings.push(
      finding(
        "change_limit_exceeded",
        "Change limit exceeded",
        `The Run changed more than ${maxChangedFiles} files.`,
      ),
    );
  }
  if (summary.deletedCount > maxDeletedFiles) {
    findings.push(
      finding(
        "deletion_limit_exceeded",
        "Deletion limit exceeded",
        `The Run deleted more than ${maxDeletedFiles} files.`,
      ),
    );
  }
  if (summary.changedBytes > maxChangedBytes) {
    findings.push(
      finding(
        "change_bytes_exceeded",
        "Changed-byte limit exceeded",
        `The Run changed more than ${maxChangedBytes} bytes.`,
      ),
    );
  }
  return findings.slice(0, MAX_FINDINGS);
}

function result(
  outcome: RunVaultOutcome,
  reason: RunVaultReason,
  changedFiles: RunVaultChangeSummary,
  findings: RunVaultFinding[],
): RunVaultPolicyResult {
  return { outcome, reason, changedFiles, findings };
}

/**
 * Applies RunVault's deterministic policy in precedence order. This function is
 * deliberately pure: filesystem inspection and verification execution supply
 * facts, while this evaluator alone chooses the policy outcome.
 */
export function evaluateRunVaultPolicy(
  input: RunVaultPolicyInput,
): RunVaultPolicyResult {
  const summary = summarizeChanges(input.changes, input.changedBytes ?? 0);
  const findings = collectFindings(input, summary);

  if (input.executionStatus === "cancelled") {
    return result("discarded", "cancelled", summary, findings);
  }
  if (input.executionStatus === "timed_out") {
    return result("discarded", "timed_out", summary, findings);
  }
  if (input.executionStatus === "failed") {
    return result("discarded", "run_failed", summary, findings);
  }
  if (input.executionStatus === "quota_exceeded") {
    return result("discarded", "staging_quota_exceeded", summary, findings);
  }
  if (input.verificationStatus === "failed") {
    return result("discarded", "verification_failed", summary, findings);
  }
  const verificationMode =
    input.policy?.verificationMode ??
    input.verificationMode ??
    "allow-skipped";
  if (
    verificationMode === "require-verification" &&
    input.verificationStatus !== "passed"
  ) {
    return result("quarantined", "verification_required", summary, findings);
  }
  if (input.trustedWorkspaceChanged) {
    return result("quarantined", "trusted_workspace_changed", summary, findings);
  }
  if (input.changes.some((change) => change.symbolicLink)) {
    return result("quarantined", "unsafe_link", summary, findings);
  }
  if (input.changes.some((change) => change.protected)) {
    return result("quarantined", "protected_path", summary, findings);
  }
  if (input.changes.some((change) => change.dependencyFile)) {
    return result("quarantined", "dependency_change", summary, findings);
  }
  if (input.changes.some((change) => change.executable || change.binary)) {
    return result("quarantined", "unsafe_file", summary, findings);
  }

  const maxChangedFiles =
    input.policy?.maxChangedFiles ??
    input.maxChangedFiles ??
    DEFAULT_MAX_CHANGED_FILES;
  const maxDeletedFiles =
    input.policy?.maxDeletedFiles ??
    input.maxDeletedFiles ??
    DEFAULT_MAX_DELETED_FILES;
  const maxChangedBytes =
    input.policy?.maxChangedBytes ??
    input.maxChangedBytes ??
    DEFAULT_MAX_CHANGED_BYTES;
  if (
    input.changes.length > maxChangedFiles ||
    summary.deletedCount > maxDeletedFiles
  ) {
    return result("quarantined", "change_limit_exceeded", summary, findings);
  }
  if (summary.changedBytes > maxChangedBytes) {
    return result("quarantined", "change_bytes_exceeded", summary, findings);
  }
  if (input.verificationStatus === "unavailable") {
    return result("quarantined", "verification_unavailable", summary, findings);
  }

  return result("promoted", "verified_safe", summary, findings);
}

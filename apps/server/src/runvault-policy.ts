import type {
  RunVaultChangeSummary,
  RunVaultFileChange,
  RunVaultOutcome,
  RunVaultReason,
  RunVaultVerificationStatus,
} from "./types.js";

export const DEFAULT_MAX_CHANGED_FILES = 20;
export const DEFAULT_MAX_DELETED_FILES = 5;

export type RunVaultExecutionStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface RunVaultPolicyInput {
  executionStatus: RunVaultExecutionStatus;
  verificationStatus: RunVaultVerificationStatus;
  changes: RunVaultFileChange[];
  trustedWorkspaceChanged?: boolean;
  maxChangedFiles?: number;
  maxDeletedFiles?: number;
}

export interface RunVaultPolicyResult {
  outcome: RunVaultOutcome;
  reason: RunVaultReason;
  changedFiles: RunVaultChangeSummary;
}

function summarizeChanges(changes: RunVaultFileChange[]): RunVaultChangeSummary {
  const protectedPathsTouched = changes
    .filter((change) => change.protected)
    .map((change) => change.path)
    .sort();

  return {
    addedCount: changes.filter((change) => change.kind === "added").length,
    modifiedCount: changes.filter((change) => change.kind === "modified").length,
    deletedCount: changes.filter((change) => change.kind === "deleted").length,
    protectedPathsTouched,
  };
}

function result(
  outcome: RunVaultOutcome,
  reason: RunVaultReason,
  changedFiles: RunVaultChangeSummary,
): RunVaultPolicyResult {
  return { outcome, reason, changedFiles };
}

/**
 * Applies RunVault's deterministic policy in precedence order. This function is
 * deliberately pure: filesystem inspection and verification execution supply
 * facts, while this evaluator alone chooses the policy outcome.
 */
export function evaluateRunVaultPolicy(
  input: RunVaultPolicyInput,
): RunVaultPolicyResult {
  const summary = summarizeChanges(input.changes);

  if (input.executionStatus === "cancelled") {
    return result("discarded", "cancelled", summary);
  }
  if (input.executionStatus === "timed_out") {
    return result("discarded", "timed_out", summary);
  }
  if (input.executionStatus === "failed") {
    return result("discarded", "run_failed", summary);
  }
  if (input.verificationStatus === "failed") {
    return result("discarded", "verification_failed", summary);
  }
  if (input.trustedWorkspaceChanged) {
    return result("quarantined", "trusted_workspace_changed", summary);
  }
  if (input.changes.some((change) => change.symbolicLink)) {
    return result("quarantined", "unsafe_link", summary);
  }
  if (input.changes.some((change) => change.protected)) {
    return result("quarantined", "protected_path", summary);
  }
  if (input.changes.some((change) => change.dependencyFile)) {
    return result("quarantined", "dependency_change", summary);
  }
  if (input.changes.some((change) => change.executable || change.binary)) {
    return result("quarantined", "unsafe_file", summary);
  }

  const maxChangedFiles = input.maxChangedFiles ?? DEFAULT_MAX_CHANGED_FILES;
  const maxDeletedFiles = input.maxDeletedFiles ?? DEFAULT_MAX_DELETED_FILES;
  if (
    input.changes.length > maxChangedFiles ||
    summary.deletedCount > maxDeletedFiles
  ) {
    return result("quarantined", "change_limit_exceeded", summary);
  }

  return result("promoted", "verified_safe", summary);
}

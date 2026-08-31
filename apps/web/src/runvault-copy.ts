import type {
  RunVaultFindingCode,
  RunVaultOutcome,
  RunVaultReason,
  RunVaultResolution,
  RunVaultVerification,
} from "./types";

export const workspaceOutcomeCopy: Record<
  RunVaultOutcome,
  { label: string; shortLabel: string; explanation: string }
> = {
  promoted: {
    label: "Applied to trusted workspace",
    shortLabel: "Applied",
    explanation: "The staged workspace replaced the trusted workspace.",
  },
  quarantined: {
    label: "Needs review — trusted workspace unchanged",
    shortLabel: "Needs review",
    explanation: "The staged workspace remains isolated pending a decision.",
  },
  discarded: {
    label: "Not applied — trusted workspace unchanged",
    shortLabel: "Not applied",
    explanation: "The staged workspace did not replace the trusted workspace.",
  },
};

export const reasonCopy: Record<RunVaultReason, string> = {
  verified_safe: "No blocking policy findings",
  protected_path: "Protected workspace path changed",
  change_limit_exceeded: "Change limit exceeded",
  dependency_change: "Dependency configuration changed",
  verification_failed: "Tests failed",
  run_failed: "Agent execution failed",
  cancelled: "Run was cancelled",
  timed_out: "Run timed out",
  unsafe_file: "Unsafe file type introduced",
  unsafe_link: "Symbolic link introduced",
  trusted_workspace_changed: "Trusted workspace changed during the Run",
  verification_required: "Policy requires passing verification",
  verification_unavailable: "Tests were unavailable",
  change_bytes_exceeded: "Changed-byte limit exceeded",
  staging_quota_exceeded: "Staging storage quota exceeded",
  retention_expired: "Quarantine retention expired",
};

export const resolutionCopy: Record<RunVaultResolution, string> = {
  policy: "Automatic policy decision",
  human_approved: "Applied after operator approval",
  human_discarded: "Not applied after operator discard",
  expired: "Not applied after quarantine expiry",
};

export const findingCopy: Record<
  RunVaultFindingCode,
  { title: string; explanation: string }
> = {
  execution_cancelled: {
    title: "Execution cancelled",
    explanation: "The Agent execution was cancelled.",
  },
  execution_timed_out: {
    title: "Execution timed out",
    explanation: "The Agent execution exceeded its time limit.",
  },
  execution_failed: {
    title: "Execution failed",
    explanation: "The Agent execution failed.",
  },
  verification_failed: {
    title: "Tests failed",
    explanation: "The configured test command did not pass.",
  },
  trusted_workspace_changed: {
    title: "Trusted workspace changed",
    explanation: "The trusted workspace changed during this Run.",
  },
  unsafe_link: {
    title: "Unsafe symbolic link",
    explanation: "A changed symbolic link requires review.",
  },
  protected_path: {
    title: "Protected path changed",
    explanation: "A protected path was changed.",
  },
  dependency_change: {
    title: "Dependency file changed",
    explanation: "A dependency manifest or lockfile was changed.",
  },
  unsafe_file: {
    title: "Unsafe file changed",
    explanation: "A changed file is executable or binary.",
  },
  change_limit_exceeded: {
    title: "Change limit exceeded",
    explanation: "The Run exceeded the changed-file limit.",
  },
  deletion_limit_exceeded: {
    title: "Deletion limit exceeded",
    explanation: "The Run exceeded the deletion limit.",
  },
  verification_required: {
    title: "Verification required",
    explanation: "The selected policy requires configured verification to pass.",
  },
  verification_unavailable: {
    title: "Verification unavailable",
    explanation: "Verification could not run with matching managed dependencies.",
  },
  change_bytes_exceeded: {
    title: "Changed-byte limit exceeded",
    explanation: "The Run exceeded the configured changed-byte limit.",
  },
  staging_quota_exceeded: {
    title: "Staging quota exceeded",
    explanation: "The Run exceeded managed staging storage limits.",
  },
  retention_expired: {
    title: "Quarantine retention expired",
    explanation: "The retained staging workspace reached its expiry time.",
  },
};

export function verificationCopy(verification: RunVaultVerification): {
  label: string;
  explanation: string;
} {
  if (verification.status === "passed") {
    return {
      label: "Tests passed",
      explanation: "The configured test command completed successfully.",
    };
  }
  if (verification.status === "failed") {
    return {
      label: "Tests failed",
      explanation: "The configured test command did not pass.",
    };
  }
  if (verification.status === "unavailable") {
    return {
      label: "Tests unavailable",
      explanation:
        verification.redactedSummary ??
        "Verification could not run with the required managed dependencies.",
    };
  }
  const noTestScript = /no (?:package\.json )?test (?:script|command)/i.test(
    verification.redactedSummary ?? "",
  );
  return noTestScript
    ? {
        label: "No tests ran — no test script configured",
        explanation: "RunVault found no configured npm test script.",
      }
    : {
        label: "No tests ran — verification skipped",
        explanation:
          verification.redactedSummary ?? "Verification did not run.",
      };
}

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type RunVaultOutcome = "promoted" | "quarantined" | "discarded";
export type RunVaultReason =
  | "verified_safe"
  | "protected_path"
  | "change_limit_exceeded"
  | "dependency_change"
  | "verification_failed"
  | "run_failed"
  | "cancelled"
  | "timed_out"
  | "unsafe_file"
  | "unsafe_link"
  | "trusted_workspace_changed"
  | "verification_required"
  | "verification_unavailable"
  | "change_bytes_exceeded"
  | "staging_quota_exceeded"
  | "retention_expired";
export type RunVaultResolution =
  | "policy"
  | "human_approved"
  | "human_discarded"
  | "expired";
export type RunVaultVerificationStatus = "passed" | "failed" | "skipped" | "unavailable";
export type RunVaultFindingCode =
  | "execution_cancelled"
  | "execution_timed_out"
  | "execution_failed"
  | "verification_failed"
  | "trusted_workspace_changed"
  | "unsafe_link"
  | "protected_path"
  | "dependency_change"
  | "unsafe_file"
  | "change_limit_exceeded"
  | "deletion_limit_exceeded"
  | "verification_required"
  | "verification_unavailable"
  | "change_bytes_exceeded"
  | "staging_quota_exceeded"
  | "retention_expired";
export type RunVaultChangeKind = "added" | "modified" | "deleted";

export interface RunVaultFileChange {
  path: string;
  kind: RunVaultChangeKind;
  protected: boolean;
  dependencyFile: boolean;
  executable: boolean;
  binary: boolean;
  symbolicLink: boolean;
}

export interface RunVaultFinding {
  code: RunVaultFindingCode;
  severity: "info" | "warning" | "blocking";
  title: string;
  explanation: string;
  paths: string[];
  omittedPathCount: number;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface RunVaultDecision {
  outcome: RunVaultOutcome;
  reason: RunVaultReason;
  resolution: RunVaultResolution;
  stagingWorkspaceId: string | null;
  provisionalThreadId: string | null;
  trustedWorkspaceFingerprint: string | null;
  stagingWorkspaceFingerprint: string | null;
  changedFiles: {
    addedCount: number;
    modifiedCount: number;
    deletedCount: number;
    protectedPathsTouched: string[];
    files: RunVaultFileChange[];
    omittedFileCount: number;
    changedBytes: number;
  };
  findings: RunVaultFinding[];
  verification: RunVaultVerification;
  trustedWorkspaceChanged: boolean;
  policy: {
    version: 1;
    profile: "standard" | "strict";
    capturedAt: string;
    protectedPatterns: string[];
    maxChangedFiles: number;
    maxDeletedFiles: number;
    maxChangedBytes: number;
    verificationMode: "allow-skipped" | "require-verification";
    stagingPerRunBytes: number;
    stagingTotalBytes: number;
    quarantineRetentionMs: number;
    runtime: {
      agentTimeoutMs: number;
      verificationTimeoutMs: number;
      containerCpuLimit: number;
      containerMemoryLimit: string;
      containerPidsLimit: number;
    };
  };
  retainedAt: string | null;
  expiresAt: string | null;
  decidedAt: string;
}

export type RunVaultLifecycleEventType =
  | "staged"
  | "inspected"
  | "verified"
  | "decided"
  | "revision_requested"
  | "approved"
  | "promoted"
  | "discarded"
  | "expired"
  | "reconciled";

export interface RunVaultLifecycleEvent {
  type: RunVaultLifecycleEventType;
  at: string;
  outcome?: RunVaultOutcome;
  verificationStatus?: RunVaultVerificationStatus;
  resolution?: RunVaultResolution;
  relatedRunId?: string;
  reconciliationAction?:
    | "completed_promotion"
    | "restored_quarantine"
    | "discarded_staging"
    | "interrupted_run";
}

export interface RunVaultRunMetrics {
  stagingDurationMs: number | null;
  stagingCopiedEntries: number | null;
  stagingCopiedBytes: number | null;
  agentDurationMs: number | null;
  inspectionDurationMs: number | null;
  verificationDurationMs: number | null;
  decisionDurationMs: number | null;
  cleanupDurationMs: number | null;
  cleanupStatus: "not_required" | "retained" | "completed" | "failed";
  changedFileCount: number;
  changedBytes: number;
  outcome: RunVaultOutcome | null;
  verificationStatus: RunVaultVerificationStatus | null;
}

export interface RunVaultHistoryEntry {
  id: string;
  agentId: string;
  agentName: string | null;
  parentRunId: string | null;
  supersededByRunId: string | null;
  revisionNumber: number;
  status: RunStatus;
  createdAt: string;
  completedAt: string | null;
  outcome: RunVaultOutcome | null;
  reason: RunVaultReason | null;
  resolution: RunVaultResolution | null;
  verificationStatus: RunVaultVerificationStatus | null;
  findingCodes: RunVaultFindingCode[];
  changedFileCount: number;
  changedBytes: number;
  retainedAt: string | null;
  expiresAt: string | null;
}

export interface RunVaultDiagnostics {
  generatedAt: string;
  verifierAvailable: boolean;
  staging: {
    retainedRunCount: number;
    missingRetainedRunCount: number;
    retainedBytes: number;
    totalManagedBytes: number;
    orphanCount: number;
    orphanBytes: number;
    promotionMarkerCount: number;
    backupCount: number;
    lastReconciliationAt: string | null;
    lastReconciledTransactions: number;
    lastRemovedOrphans: number;
    lastRemovedOrphanBytes: number;
  };
  dependencies: {
    mode: "disabled" | "existing-cache" | "isolated-ci";
    validCacheCount: number;
    invalidCacheCount: number;
    partialCacheCount: number;
    totalBytes: number;
    activePreparations: number;
  };
  metrics: {
    totalRuns: number;
    decidedRuns: number;
    outcomes: Record<RunVaultOutcome, number>;
    verification: Record<RunVaultVerificationStatus, number>;
    cleanupFailures: number;
    averageStagingDurationMs: number | null;
    averageVerificationDurationMs: number | null;
    totalStagedBytes: number;
    totalChangedBytes: number;
  };
  storageModel: "single-process-json";
  tamperProof: false;
}

export interface RunVaultEvidenceExport {
  version: 1;
  exportedAt: string;
  run: {
    id: string;
    agentId: string;
    parentRunId: string | null;
    supersededByRunId: string | null;
    revisionNumber: number;
    status: RunStatus;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
  };
  decision: Omit<RunVaultDecision, "verification"> & {
    verification: Pick<RunVaultVerification, "status" | "command">;
  };
  lifecycleEvents: RunVaultLifecycleEvent[];
  metrics: RunVaultRunMetrics;
}

export interface RunVaultVerification {
  status: RunVaultVerificationStatus;
  command: string | null;
  redactedSummary: string | null;
}

export type RunVaultReviewAvailability =
  | "available"
  | "not_retained"
  | "missing"
  | "staging_tampered"
  | "trusted_changed";

export interface RunVaultReviewEvidence {
  runId: string;
  availability: RunVaultReviewAvailability;
  message: string;
  stagingFingerprintVerified: boolean;
  trustedFingerprintVerified: boolean;
}

export interface RunVaultTextDiff {
  path: string;
  status:
    | "available"
    | "protected"
    | "binary"
    | "symbolic_link"
    | "too_large"
    | "unavailable";
  diff: string | null;
  truncated: boolean;
}

export interface AgentRun {
  id: string;
  agentId: string;
  parentRunId: string | null;
  supersededByRunId: string | null;
  revisionNumber: number;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  runVault: RunVaultDecision | null;
  runVaultEvents: RunVaultLifecycleEvent[];
  runVaultMetrics: RunVaultRunMetrics;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  dependencyMode: "disabled" | "existing-cache" | "isolated-ci";
  runVaultPolicy: RunVaultDecision["policy"];
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}

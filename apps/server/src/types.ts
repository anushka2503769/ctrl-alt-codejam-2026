export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

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

export type RunVaultVerificationStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "unavailable";
export type RunVaultChangeKind = "added" | "modified" | "deleted";
export type RunVaultResolution =
  | "policy"
  | "human_approved"
  | "human_discarded"
  | "expired";
export type RunVaultVerificationMode =
  | "allow-skipped"
  | "require-verification";
export type RunVaultPolicyProfileName = "standard" | "strict";

export interface RunVaultPolicySnapshot {
  version: 1;
  profile: RunVaultPolicyProfileName;
  capturedAt: string;
  protectedPatterns: string[];
  maxChangedFiles: number;
  maxDeletedFiles: number;
  maxChangedBytes: number;
  verificationMode: RunVaultVerificationMode;
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
}

export interface RunVaultFileChange {
  path: string;
  kind: RunVaultChangeKind;
  protected: boolean;
  dependencyFile: boolean;
  executable: boolean;
  binary: boolean;
  symbolicLink: boolean;
}

export interface RunVaultChangeSummary {
  addedCount: number;
  modifiedCount: number;
  deletedCount: number;
  protectedPathsTouched: string[];
  files: RunVaultFileChange[];
  omittedFileCount: number;
  changedBytes: number;
}

export type RunVaultFindingCode =
  | "execution_cancelled" | "execution_timed_out" | "execution_failed"
  | "verification_failed" | "trusted_workspace_changed" | "unsafe_link"
  | "protected_path" | "dependency_change" | "unsafe_file"
  | "change_limit_exceeded" | "deletion_limit_exceeded"
  | "verification_required" | "change_bytes_exceeded"
  | "verification_unavailable" | "staging_quota_exceeded"
  | "retention_expired";

export interface RunVaultFinding {
  code: RunVaultFindingCode;
  severity: "info" | "warning" | "blocking";
  title: string;
  explanation: string;
  paths: string[];
  omittedPathCount: number;
}

export interface RunVaultVerification {
  status: RunVaultVerificationStatus;
  command: string | null;
  redactedSummary: string | null;
}

export interface RunVaultDecision {
  outcome: RunVaultOutcome;
  reason: RunVaultReason;
  resolution: RunVaultResolution;
  stagingWorkspaceId: string | null;
  provisionalThreadId: string | null;
  trustedWorkspaceFingerprint: string | null;
  stagingWorkspaceFingerprint: string | null;
  changedFiles: RunVaultChangeSummary;
  findings: RunVaultFinding[];
  verification: RunVaultVerification;
  trustedWorkspaceChanged: boolean;
  policy: RunVaultPolicySnapshot;
  retainedAt: string | null;
  expiresAt: string | null;
  decidedAt: string;
}

export type RunVaultReviewAvailability =
  | "available"
  | "not_retained"
  | "missing"
  | "staging_tampered"
  | "trusted_changed";

export interface RunVaultReview {
  runId: string;
  availability: RunVaultReviewAvailability;
  message: string;
  stagingFingerprintVerified: boolean;
  trustedFingerprintVerified: boolean;
}

export type RunVaultDiffStatus =
  | "available"
  | "protected"
  | "binary"
  | "symbolic_link"
  | "too_large"
  | "unavailable";

export interface RunVaultTextDiff {
  path: string;
  status: RunVaultDiffStatus;
  diff: string | null;
  truncated: boolean;
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
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
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
  usage: RunUsage | null;
  runVault: RunVaultDecision | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  dependencyCachePath?: string | null;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

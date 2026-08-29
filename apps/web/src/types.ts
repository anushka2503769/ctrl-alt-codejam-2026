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
  | "trusted_workspace_changed";
export type RunVaultResolution =
  | "policy"
  | "human_approved"
  | "human_discarded";

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
  };
  verification: {
    status: "passed" | "failed" | "skipped";
    command: string | null;
    redactedSummary: string | null;
  };
  trustedWorkspaceChanged: boolean;
  decidedAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
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
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}

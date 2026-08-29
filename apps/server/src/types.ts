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
  | "trusted_workspace_changed";

export type RunVaultVerificationStatus = "passed" | "failed" | "skipped";
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

export interface RunVaultChangeSummary {
  addedCount: number;
  modifiedCount: number;
  deletedCount: number;
  protectedPathsTouched: string[];
}

export interface RunVaultVerification {
  status: RunVaultVerificationStatus;
  command: string | null;
  redactedSummary: string | null;
}

export interface RunVaultDecision {
  outcome: RunVaultOutcome;
  reason: RunVaultReason;
  stagingWorkspaceId: string | null;
  provisionalThreadId: string | null;
  changedFiles: RunVaultChangeSummary;
  verification: RunVaultVerification;
  trustedWorkspaceChanged: boolean;
  decidedAt: string;
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
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

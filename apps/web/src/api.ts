import type {
  Agent,
  AgentRun,
  Message,
  RunVaultDiagnostics,
  RunVaultEvidenceExport,
  RunVaultFindingCode,
  RunVaultHistoryEntry,
  RunVaultOutcome,
  RunVaultReviewEvidence,
  RunVaultTextDiff,
  RunVaultVerificationStatus,
  SystemInfo,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  runVaultDiagnostics: () =>
    request<{ diagnostics: RunVaultDiagnostics }>("/api/runvault/diagnostics"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  runVaultHistory: (filters: {
    agentId?: string;
    outcome?: RunVaultOutcome;
    finding?: RunVaultFindingCode;
    verification?: RunVaultVerificationStatus;
    lineage?: "root" | "revision";
    lineageRunId?: string;
    from?: string;
    to?: string;
    limit?: number;
  }) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return request<{ runs: RunVaultHistoryEntry[] }>(`/api/runs${suffix}`);
  },
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  runVaultReview: (id: string) =>
    request<{ review: RunVaultReviewEvidence }>(
      "/api/runs/" + id + "/runvault/review",
    ),
  runVaultEvidence: (id: string) =>
    request<{ evidence: RunVaultEvidenceExport }>(
      "/api/runs/" + id + "/runvault/evidence",
    ),
  runVaultDiff: (id: string, path: string) =>
    request<{ diff: RunVaultTextDiff }>(
      "/api/runs/" + id + "/runvault/diff?path=" + encodeURIComponent(path),
    ),
  approveRun: (id: string) =>
    request<{ run: AgentRun }>("/api/runs/" + id + "/approve", {
      method: "POST",
    }),
  discardRun: (id: string) =>
    request<{ run: AgentRun }>("/api/runs/" + id + "/discard", {
      method: "POST",
    }),
  reviseRun: (id: string, instructions: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/runs/" + id + "/revisions",
      {
        method: "POST",
        body: JSON.stringify({ instructions }),
      },
    ),
};

import { describe, expect, it } from "vitest";
import { filterRunVaultHistory } from "./runvault-history.js";
import { emptyRunVaultMetrics } from "./runvault-observability.js";
import type { AgentRun, Database, RunVaultOutcome } from "./types.js";

function run(
  id: string,
  createdAt: string,
  options: {
    parentRunId?: string | null;
    supersededByRunId?: string | null;
    outcome?: RunVaultOutcome;
    finding?: "protected_path" | "dependency_change";
  } = {},
): AgentRun {
  const outcome = options.outcome ?? "quarantined";
  const finding = options.finding ?? "protected_path";
  return {
    id,
    agentId: "agent-1",
    parentRunId: options.parentRunId ?? null,
    supersededByRunId: options.supersededByRunId ?? null,
    revisionNumber: options.parentRunId ? 1 : 0,
    status: "completed",
    prompt: "SECRET prompt must not enter history",
    output: "SECRET output must not enter history",
    error: "SECRET error must not enter history",
    usage: null,
    runVault: {
      outcome,
      reason: finding,
      resolution: "policy",
      stagingWorkspaceId: id,
      provisionalThreadId: "thread-1",
      trustedWorkspaceFingerprint: "trusted",
      stagingWorkspaceFingerprint: "staged",
      changedFiles: {
        addedCount: 1,
        modifiedCount: 0,
        deletedCount: 0,
        protectedPathsTouched: ["deploy/app.yml"],
        files: [{
          path: "deploy/app.yml",
          kind: "added",
          protected: true,
          dependencyFile: false,
          executable: false,
          binary: false,
          symbolicLink: false,
        }],
        omittedFileCount: 0,
        changedBytes: 12,
      },
      findings: [{
        code: finding,
        severity: "warning",
        title: "Review required",
        explanation: "Safe summary",
        paths: ["deploy/app.yml"],
        omittedPathCount: 0,
      }],
      verification: {
        status: "passed",
        command: "npm test",
        redactedSummary: "SECRET verification output",
      },
      trustedWorkspaceChanged: false,
      policy: {
        version: 1,
        profile: "standard",
        capturedAt: createdAt,
        protectedPatterns: ["deploy/**"],
        maxChangedFiles: 20,
        maxDeletedFiles: 5,
        maxChangedBytes: 1_000,
        verificationMode: "allow-skipped",
        stagingPerRunBytes: 2_000,
        stagingTotalBytes: 4_000,
        quarantineRetentionMs: 60_000,
        runtime: {
          agentTimeoutMs: 1_000,
          verificationTimeoutMs: 1_000,
          containerCpuLimit: 1,
          containerMemoryLimit: "1g",
          containerPidsLimit: 64,
        },
      },
      retainedAt: outcome === "quarantined" ? createdAt : null,
      expiresAt: null,
      decidedAt: createdAt,
    },
    runVaultEvents: [],
    runVaultMetrics: {
      ...emptyRunVaultMetrics(),
      changedFileCount: 1,
      changedBytes: 12,
      outcome,
      verificationStatus: "passed",
    },
    startedAt: createdAt,
    completedAt: createdAt,
    createdAt,
  };
}

const rootId = "10000000-0000-4000-8000-000000000001";
const childId = "10000000-0000-4000-8000-000000000002";
const otherId = "10000000-0000-4000-8000-000000000003";

function database(): Database {
  return {
    version: 1,
    agents: [{
      id: "agent-1",
      name: "Builder",
      description: "",
      instructions: "",
      status: "ready",
      workspacePath: "/private/workspace",
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    messages: [],
    runs: [
      run(rootId, "2026-01-01T00:00:00.000Z", { supersededByRunId: childId }),
      run(childId, "2026-01-02T00:00:00.000Z", {
        parentRunId: rootId,
        outcome: "promoted",
      }),
      run(otherId, "2026-01-03T00:00:00.000Z", { finding: "dependency_change" }),
    ],
  };
}

describe("RunVault history", () => {
  it("filters by decision evidence, revision status, and date", () => {
    const results = filterRunVaultHistory(database(), {
      agentId: "agent-1",
      outcome: "promoted",
      finding: "protected_path",
      verification: "passed",
      lineage: "revision",
      from: "2026-01-02T00:00:00.000Z",
      to: "2026-01-02T23:59:59.999Z",
    });
    expect(results.map((item) => item.id)).toEqual([childId]);
  });

  it("returns a complete lineage family and applies a bounded newest-first limit", () => {
    expect(
      filterRunVaultHistory(database(), { lineageRunId: childId }).map(
        (item) => item.id,
      ),
    ).toEqual([childId, rootId]);
    expect(filterRunVaultHistory(database(), { limit: 1 })[0]?.id).toBe(otherId);
  });

  it("returns summaries without Run content or verification output", () => {
    const serialized = JSON.stringify(filterRunVaultHistory(database(), {}));
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("/private/workspace");
    expect(serialized).not.toContain("npm test");
  });
});

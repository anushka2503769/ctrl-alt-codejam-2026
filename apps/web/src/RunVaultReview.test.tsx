import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RunVaultReview } from "./RunVaultReview";
import type { AgentRun } from "./types";

const run: AgentRun = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  agentId: "agent-1",
  parentRunId: null,
  supersededByRunId: null,
  revisionNumber: 0,
  status: "completed",
  prompt: "Review deployment and dependency changes",
  output: "Prepared changes",
  error: null,
  usage: null,
  runVault: {
    outcome: "quarantined",
    reason: "protected_path",
    resolution: "policy",
    stagingWorkspaceId: "run-1",
    provisionalThreadId: "thread-1",
    trustedWorkspaceFingerprint: "trusted",
    stagingWorkspaceFingerprint: "staged",
    changedFiles: {
      addedCount: 2,
      modifiedCount: 0,
      deletedCount: 0,
      protectedPathsTouched: ["deploy/secret.txt"],
      files: [
        {
          path: "deploy/secret.txt",
          kind: "added",
          protected: true,
          dependencyFile: false,
          executable: false,
          binary: false,
          symbolicLink: false,
        },
        {
          path: "package-lock.json",
          kind: "added",
          protected: false,
          dependencyFile: true,
          executable: false,
          binary: false,
          symbolicLink: false,
        },
      ],
      omittedFileCount: 0,
      changedBytes: 128,
    },
    findings: [{
      code: "protected_path",
      severity: "warning",
      title: "Protected path changed",
      explanation: "A protected path was changed.",
      paths: ["deploy/secret.txt"],
      omittedPathCount: 0,
    }],
    verification: {
      status: "passed",
      command: "npm test",
      redactedSummary: "Tests completed.",
    },
    trustedWorkspaceChanged: false,
    policy: {
      version: 1,
      profile: "standard",
      capturedAt: "2026-01-01T00:00:00.000Z",
      protectedPatterns: ["deploy/**"],
      maxChangedFiles: 20,
      maxDeletedFiles: 5,
      maxChangedBytes: 26_214_400,
      verificationMode: "allow-skipped",
      stagingPerRunBytes: 536_870_912,
      stagingTotalBytes: 2_147_483_648,
      quarantineRetentionMs: 604_800_000,
      runtime: {
        agentTimeoutMs: 600_000,
        verificationTimeoutMs: 120_000,
        containerCpuLimit: 2,
        containerMemoryLimit: "2g",
        containerPidsLimit: 256,
      },
    },
    retainedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-08T00:00:00.000Z",
    decidedAt: "2026-01-01T00:00:00.000Z",
  },
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("RunVault review workspace", () => {
  it("renders complete safe evidence and quarantine controls", () => {
    const html = renderToStaticMarkup(
      <RunVaultReview
        run={run}
        action={null}
        onAction={vi.fn()}
        revising={false}
        onRevision={vi.fn()}
      />,
    );
    expect(html).toContain("Run review");
    expect(html).toContain("Protected path changed");
    expect(html).toContain("deploy/secret.txt");
    expect(html).toContain("package-lock.json");
    expect(html).toContain("Protected");
    expect(html).toContain("Dependency");
    expect(html).toContain("Tests passed");
    expect(html).toContain("standard · allow-skipped");
    expect(html).toContain("128 changed bytes");
    expect(html).toContain("expires");
    expect(html).toContain("Approve and promote");
    expect(html).toContain("Discard staged work");
    expect(html).toContain("Create revision Run");
    expect(html).not.toContain("PROTECTED-CONTENT");
  });
});

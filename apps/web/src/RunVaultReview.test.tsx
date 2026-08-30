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
    expect(html).toContain("Approve and promote");
    expect(html).toContain("Discard staged work");
    expect(html).toContain("Create revision Run");
    expect(html).not.toContain("PROTECTED-CONTENT");
  });
});

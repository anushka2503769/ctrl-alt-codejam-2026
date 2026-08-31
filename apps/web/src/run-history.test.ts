import { describe, expect, it } from "vitest";
import type { AgentRun, Message } from "./types";
import {
  lastMessageIndexes,
  replaceRun,
  resolvedRunId,
  runsWithoutMessages,
} from "./run-history";

function run(id: string, status: AgentRun["status"] = "completed"): AgentRun {
  return {
    id,
    agentId: "agent-1",
    parentRunId: null,
    supersededByRunId: null,
    revisionNumber: 0,
    status,
    prompt: `prompt-${id}`,
    output: null,
    error: null,
    usage: null,
    runVault: null,
    runVaultEvents: [],
    runVaultMetrics: {
      stagingDurationMs: null,
      stagingCopiedEntries: null,
      stagingCopiedBytes: null,
      agentDurationMs: null,
      inspectionDurationMs: null,
      verificationDurationMs: null,
      decisionDurationMs: null,
      cleanupDurationMs: null,
      cleanupStatus: "not_required",
      changedFileCount: 0,
      changedBytes: 0,
      outcome: null,
      verificationStatus: null,
    },
    startedAt: null,
    completedAt: null,
    createdAt: `2026-01-01T00:00:0${id}.000Z`,
  };
}

function message(id: string, runId: string): Message {
  return {
    id,
    agentId: "agent-1",
    runId,
    role: "user",
    content: id,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("Run history collection", () => {
  it("updates only the polled Run and preserves historical Runs", () => {
    const previous = [run("2", "running"), run("1")];
    const next = replaceRun(previous, run("2", "completed"));
    expect(next.map((item) => [item.id, item.status])).toEqual([
      ["2", "completed"],
      ["1", "completed"],
    ]);
  });

  it("keeps a historical selection and safely resets stale selections", () => {
    const runs = [run("2"), run("1")];
    expect(resolvedRunId("1", runs)).toBe("1");
    expect(resolvedRunId("old-agent-run", runs)).toBe("2");
    expect(resolvedRunId("old-agent-run", [])).toBeNull();
  });

  it("places each Run summary after its last correlated message", () => {
    const messages = [message("prompt", "1"), message("reply", "1"), message("next", "2")];
    expect([...lastMessageIndexes(messages)]).toEqual([["1", 1], ["2", 2]]);
  });

  it("retains failed Runs that have no message", () => {
    const orphan = run("1", "failed");
    expect(runsWithoutMessages([run("2"), orphan], [message("m2", "2")])).toEqual([orphan]);
  });
});

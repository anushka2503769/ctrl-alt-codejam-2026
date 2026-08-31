import { describe, expect, it } from "vitest";
import {
  appendRunVaultEvent,
  emitRunVaultMetric,
  emptyRunVaultMetrics,
  MAX_RUNVAULT_LIFECYCLE_EVENTS,
  runVaultMetricsChannel,
  type RunVaultMetricEvent,
} from "./runvault-observability.js";

describe("RunVault observability", () => {
  it("bounds lifecycle evidence to the newest events", () => {
    const run = { runVaultEvents: [] };
    for (let index = 0; index < MAX_RUNVAULT_LIFECYCLE_EVENTS + 5; index += 1) {
      appendRunVaultEvent(run, "inspected", `2026-01-01T00:00:${index}.000Z`);
    }
    expect(run.runVaultEvents).toHaveLength(MAX_RUNVAULT_LIFECYCLE_EVENTS);
    expect(run.runVaultEvents[0]?.at).toBe("2026-01-01T00:00:5.000Z");
  });

  it("publishes a fixed metadata-only metric shape", () => {
    let published: RunVaultMetricEvent | undefined;
    const listener = (message: unknown) => {
      published = message as RunVaultMetricEvent;
    };
    runVaultMetricsChannel.subscribe(listener);
    try {
      emitRunVaultMetric("run_decision", {
        id: "run-1",
        agentId: "agent-1",
        runVaultMetrics: {
          ...emptyRunVaultMetrics(),
          outcome: "promoted",
          verificationStatus: "passed",
          cleanupStatus: "completed",
          stagingDurationMs: 10,
          verificationDurationMs: 20,
          cleanupDurationMs: 5,
          stagingCopiedBytes: 100,
          changedBytes: 12,
        },
      }, "2026-01-01T00:00:00.000Z");
    } finally {
      runVaultMetricsChannel.unsubscribe(listener);
    }

    expect(published).toEqual({
      name: "run_decision",
      at: "2026-01-01T00:00:00.000Z",
      runId: "run-1",
      agentId: "agent-1",
      outcome: "promoted",
      verificationStatus: "passed",
      cleanupStatus: "completed",
      stagingDurationMs: 10,
      verificationDurationMs: 20,
      cleanupDurationMs: 5,
      stagedBytes: 100,
      changedBytes: 12,
    });
    expect(Object.keys(published ?? {})).not.toContain("prompt");
    expect(Object.keys(published ?? {})).not.toContain("workspacePath");
  });
});

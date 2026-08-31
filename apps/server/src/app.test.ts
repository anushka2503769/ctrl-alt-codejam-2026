import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("exposes approve and discard actions for quarantined Runs", async () => {
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const approveRun = vi.fn(async (id: string) => ({ id, action: "approved" }));
    const discardRun = vi.fn(async (id: string) => ({ id, action: "discarded" }));
    const lifecycleService = {
      approveRun,
      discardRun,
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), lifecycleService);

    const approved = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/approve`,
    });
    const discarded = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/discard`,
    });

    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toEqual({ run: { id: runId, action: "approved" } });
    expect(discarded.statusCode).toBe(200);
    expect(discarded.json()).toEqual({ run: { id: runId, action: "discarded" } });
    expect(approveRun).toHaveBeenCalledWith(runId);
    expect(discardRun).toHaveBeenCalledWith(runId);
    await app.close();
  });

  it("exposes retained review and encoded diff paths", async () => {
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const getRunVaultReview = vi.fn(async (id: string) => ({ id, availability: "available" }));
    const getRunVaultDiff = vi.fn(async (id: string, path: string) => ({ id, path }));
    const reviewService = {
      getRunVaultReview,
      getRunVaultDiff,
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), reviewService);

    const review = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/runvault/review`,
    });
    const diff = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/runvault/diff?path=src%2Findex.ts`,
    });

    expect(review.statusCode).toBe(200);
    expect(diff.statusCode).toBe(200);
    expect(getRunVaultReview).toHaveBeenCalledWith(runId);
    expect(getRunVaultDiff).toHaveBeenCalledWith(runId, "src/index.ts");
    await app.close();
  });

  it("creates revisions through the Run API", async () => {
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const requestRevision = vi.fn(async (id: string, instructions: string) => ({
      run: { id: "child", parentRunId: id },
      message: { content: instructions },
    }));
    const revisionService = { requestRevision } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), revisionService);
    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/revisions`,
      payload: { instructions: "remove the risky change" },
    });
    expect(response.statusCode).toBe(202);
    expect(requestRevision).toHaveBeenCalledWith(runId, "remove the risky change");
    await app.close();
  });

  it("exposes validated history, evidence downloads, and diagnostics", async () => {
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const getRunVaultHistory = vi.fn(() => [{ id: runId }]);
    const getRunVaultEvidence = vi.fn(() => ({ version: 1, run: { id: runId } }));
    const runVaultDiagnostics = vi.fn(async () => ({
      storageModel: "single-process-json",
      tamperProof: false,
    }));
    const historyService = {
      getRunVaultHistory,
      getRunVaultEvidence,
      runVaultDiagnostics,
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), historyService);

    const history = await app.inject({
      method: "GET",
      url: `/api/runs?outcome=quarantined&lineage=revision&lineageRunId=${runId}&limit=20`,
    });
    const evidence = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/runvault/evidence`,
    });
    const diagnostics = await app.inject({
      method: "GET",
      url: "/api/runvault/diagnostics",
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/api/runs?limit=201",
    });

    expect(history.statusCode).toBe(200);
    expect(getRunVaultHistory).toHaveBeenCalledWith({
      outcome: "quarantined",
      lineage: "revision",
      lineageRunId: runId,
      limit: 20,
    });
    expect(evidence.headers["content-disposition"]).toBe(
      `attachment; filename="runvault-evidence-${runId}.json"`,
    );
    expect(evidence.json()).toEqual({
      evidence: { version: 1, run: { id: runId } },
    });
    expect(diagnostics.json()).toEqual({
      diagnostics: { storageModel: "single-process-json", tamperProof: false },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it("requires explicit network confirmation for dependency preparation", async () => {
    const agentId = "123e4567-e89b-42d3-a456-426614174000";
    const prepareDependencies = vi.fn(async () => ({
      status: "prepared" as const,
      cacheKey: "a".repeat(64),
    }));
    const dependencyService = { prepareDependencies } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), dependencyService);

    const denied = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/dependencies/prepare`,
      payload: { confirmNetworkAccess: false },
    });
    const prepared = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/dependencies/prepare`,
      payload: { confirmNetworkAccess: true },
    });

    expect(denied.statusCode).toBe(400);
    expect(prepared.statusCode).toBe(200);
    expect(prepareDependencies).toHaveBeenCalledOnce();
    expect(prepareDependencies).toHaveBeenCalledWith(agentId, true);
    await app.close();
  });
});

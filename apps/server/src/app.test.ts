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
});

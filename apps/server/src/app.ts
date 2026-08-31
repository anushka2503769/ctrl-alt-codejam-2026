import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const reviewDiffQuery = z.object({ path: z.string().min(1).max(500) });
const revisionBody = z.object({
  instructions: z.string().trim().min(1).max(50_000),
});
const dependencyPreparationBody = z.object({
  confirmNetworkAccess: z.literal(true),
});
const runHistoryQuery = z
  .object({
    agentId: z.string().uuid().optional(),
    outcome: z.enum(["promoted", "quarantined", "discarded"]).optional(),
    finding: z
      .enum([
        "execution_cancelled",
        "execution_timed_out",
        "execution_failed",
        "verification_failed",
        "trusted_workspace_changed",
        "unsafe_link",
        "protected_path",
        "dependency_change",
        "unsafe_file",
        "change_limit_exceeded",
        "deletion_limit_exceeded",
        "verification_required",
        "change_bytes_exceeded",
        "verification_unavailable",
        "staging_quota_exceeded",
        "retention_expired",
      ])
      .optional(),
    verification: z
      .enum(["passed", "failed", "skipped", "unavailable"])
      .optional(),
    lineage: z.enum(["root", "revision"]).optional(),
    lineageRunId: z.string().uuid().optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .refine(
    (query) => !query.from || !query.to || Date.parse(query.from) <= Date.parse(query.to),
    "History start date must be before the end date",
  );

export async function createApp(
  config: AppConfig,
  service: AgentService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });
  app.addHook("onClose", async () => {
    service.shutdown?.();
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/runvault/diagnostics", async () => ({
    diagnostics: await service.runVaultDiagnostics(),
  }));

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  app.post("/api/agents/:id/dependencies/prepare", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = dependencyPreparationBody.parse(request.body);
    return {
      dependencyCache: await service.prepareDependencies(
        id,
        body.confirmNetworkAccess,
      ),
    };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content);
    return reply.code(202).send(result);
  });

  app.get("/api/runs", async (request) => {
    const filters = runHistoryQuery.parse(request.query);
    return { runs: service.getRunVaultHistory(filters) };
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  app.get("/api/runs/:id/runvault/evidence", async (request, reply) => {
    const { id } = runIdParams.parse(request.params);
    reply.header(
      "Content-Disposition",
      `attachment; filename="runvault-evidence-${id}.json"`,
    );
    return { evidence: service.getRunVaultEvidence(id) };
  });

  app.get("/api/runs/:id/runvault/review", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { review: await service.getRunVaultReview(id) };
  });

  app.get("/api/runs/:id/runvault/diff", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const { path } = reviewDiffQuery.parse(request.query);
    return { diff: await service.getRunVaultDiff(id, path) };
  });

  app.post("/api/runs/:id/approve", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: await service.approveRun(id) };
  });

  app.post("/api/runs/:id/discard", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: await service.discardRun(id) };
  });

  app.post("/api/runs/:id/revisions", async (request, reply) => {
    const { id } = runIdParams.parse(request.params);
    const { instructions } = revisionBody.parse(request.body);
    return reply.code(202).send(await service.requestRevision(id, instructions));
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  createRunVaultPolicySnapshot,
  parseProtectedPatterns,
} from "./runvault-policy-config.js";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  VERIFICATION_PROVIDER: z.enum(["container", "host"]).default("container"),
  VERIFICATION_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(120_000),
  VERIFICATION_MAX_OUTPUT_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .default(16_384),
  VERIFICATION_WORKSPACE_HOST_ROOT: z.string().optional(),
  CONTAINER_WORKSPACE_HOST_ROOT: z.string().optional(),
  CONTAINER_CODEX_HOME_HOST_ROOT: z.string().optional(),
  DEPENDENCY_MODE: z
    .enum(["disabled", "existing-cache", "isolated-ci"])
    .default("disabled"),
  DEPENDENCY_CACHE_ROOT: z.string().optional(),
  DEPENDENCY_CACHE_HOST_ROOT: z.string().optional(),
  DEPENDENCY_PREPARATION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(600_000),
  RUNVAULT_POLICY_PROFILE: z.enum(["standard", "strict"]).default("standard"),
  RUNVAULT_PROTECTED_PATTERNS: z.string().max(32_768).optional(),
  RUNVAULT_MAX_CHANGED_FILES: z.coerce.number().int().min(1).max(10_000).optional(),
  RUNVAULT_MAX_DELETED_FILES: z.coerce.number().int().min(0).max(10_000).optional(),
  RUNVAULT_MAX_CHANGED_BYTES: z.coerce.number().int().min(1_024).optional(),
  RUNVAULT_VERIFICATION_MODE: z
    .enum(["allow-skipped", "require-verification"])
    .optional(),
  RUNVAULT_STAGING_PER_RUN_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .optional(),
  RUNVAULT_STAGING_TOTAL_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .optional(),
  RUNVAULT_QUARANTINE_RETENTION_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(366 * 24 * 60 * 60 * 1_000)
    .optional(),
  RUNVAULT_QUOTA_POLL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(1_000),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  const rightInsideLeft =
    relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
  const reverse = path.relative(right, left);
  const leftInsideRight =
    reverse === "" || (reverse !== ".." && !reverse.startsWith(`..${path.sep}`));
  return rightInsideLeft || leftInsideRight;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  if (env.NODE_ENV === "production" && env.VERIFICATION_PROVIDER === "host") {
    throw new Error("Host verification is not allowed in production");
  }
  if (
    env.DEPENDENCY_MODE !== "disabled" &&
    (env.RUNTIME_PROVIDER !== "container" || env.VERIFICATION_PROVIDER !== "container")
  ) {
    throw new Error(
      "Managed dependency modes require container Agent and verification providers",
    );
  }
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  if (env.DEPENDENCY_MODE === "isolated-ci" && authToken.length === 0) {
    throw new Error(
      "DEPENDENCY_MODE=isolated-ci requires APP_AUTH_TOKEN for authenticated preparation",
    );
  }
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  const workspaceRoot = path.resolve(env.AGENT_WORKSPACE_ROOT);
  const dataDirectory = path.resolve(env.APP_DATA_DIR);
  const codexHome = path.resolve(env.CODEX_HOME);
  const dependencyCacheRoot = path.resolve(
    env.DEPENDENCY_CACHE_ROOT?.trim() || path.join(dataDirectory, "dependencies"),
  );
  const containerWorkspaceHostRoot = path.resolve(
    env.CONTAINER_WORKSPACE_HOST_ROOT?.trim() || workspaceRoot,
  );
  const containerCodexHomeHostRoot = path.resolve(
    env.CONTAINER_CODEX_HOME_HOST_ROOT?.trim() || codexHome,
  );
  const dependencyCacheHostRoot = path.resolve(
    env.DEPENDENCY_CACHE_HOST_ROOT?.trim() || dependencyCacheRoot,
  );
  if (
    pathsOverlap(dependencyCacheRoot, workspaceRoot) ||
    pathsOverlap(dependencyCacheRoot, codexHome)
  ) {
    throw new Error(
      "Dependency cache root must be separate from workspace and Codex roots",
    );
  }
  if (
    pathsOverlap(dependencyCacheHostRoot, containerWorkspaceHostRoot) ||
    pathsOverlap(dependencyCacheHostRoot, containerCodexHomeHostRoot)
  ) {
    throw new Error(
      "Dependency cache host root must be separate from host workspace and Codex roots",
    );
  }
  const runVaultPolicy = createRunVaultPolicySnapshot(
    env.RUNVAULT_POLICY_PROFILE,
    {
      protectedPatterns: parseProtectedPatterns(
        env.RUNVAULT_PROTECTED_PATTERNS,
      ),
      maxChangedFiles: env.RUNVAULT_MAX_CHANGED_FILES,
      maxDeletedFiles: env.RUNVAULT_MAX_DELETED_FILES,
      maxChangedBytes: env.RUNVAULT_MAX_CHANGED_BYTES,
      verificationMode: env.RUNVAULT_VERIFICATION_MODE,
      stagingPerRunBytes: env.RUNVAULT_STAGING_PER_RUN_BYTES,
      stagingTotalBytes: env.RUNVAULT_STAGING_TOTAL_BYTES,
      quarantineRetentionMs: env.RUNVAULT_QUARANTINE_RETENTION_MS,
    },
    {
      agentTimeoutMs: env.CODEX_TIMEOUT_MS,
      verificationTimeoutMs: env.VERIFICATION_TIMEOUT_MS,
      containerCpuLimit: env.CONTAINER_CPU_LIMIT,
      containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
      containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    },
    new Date().toISOString(),
  );
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory,
    workspaceRoot,
    codexHome,
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    verificationProvider: env.VERIFICATION_PROVIDER,
    verificationTimeoutMs: env.VERIFICATION_TIMEOUT_MS,
    verificationMaxOutputBytes: env.VERIFICATION_MAX_OUTPUT_BYTES,
    verificationWorkspaceHostRoot: path.resolve(
      env.VERIFICATION_WORKSPACE_HOST_ROOT?.trim() || workspaceRoot,
    ),
    containerWorkspaceHostRoot,
    containerCodexHomeHostRoot,
    dependencyMode: env.DEPENDENCY_MODE,
    dependencyCacheRoot,
    dependencyCacheHostRoot,
    dependencyPreparationTimeoutMs: env.DEPENDENCY_PREPARATION_TIMEOUT_MS,
    runVaultPolicy,
    runVaultQuotaPollMs: env.RUNVAULT_QUOTA_POLL_MS,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
  };
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const toml = [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(config.arkBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}

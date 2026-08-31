import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("managed dependency configuration", () => {
  it("requires container Agent and verification providers", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        DEPENDENCY_MODE: "existing-cache",
        RUNTIME_PROVIDER: "local-process",
        VERIFICATION_PROVIDER: "container",
      }),
    ).toThrow("require container Agent and verification providers");
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        DEPENDENCY_MODE: "isolated-ci",
        APP_AUTH_TOKEN: "dependency-test-token",
        RUNTIME_PROVIDER: "container",
        VERIFICATION_PROVIDER: "host",
      }),
    ).toThrow("require container Agent and verification providers");
  });

  it("requires API authentication before isolated preparation is enabled", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        DEPENDENCY_MODE: "isolated-ci",
        RUNTIME_PROVIDER: "container",
        VERIFICATION_PROVIDER: "container",
      }),
    ).toThrow("requires APP_AUTH_TOKEN");
  });

  it("rejects cache roots that overlap sensitive Runtime roots", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        AGENT_WORKSPACE_ROOT: "/app/workspaces",
        CODEX_HOME: "/app/codex",
        DEPENDENCY_CACHE_ROOT: "/app/workspaces/dependencies",
      }),
    ).toThrow("separate from workspace and Codex roots");
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        AGENT_WORKSPACE_ROOT: "/app/workspaces",
        CODEX_HOME: "/app/codex",
        DEPENDENCY_CACHE_ROOT: "/app/dependencies",
        CONTAINER_WORKSPACE_HOST_ROOT: "/host/workspaces",
        CONTAINER_CODEX_HOME_HOST_ROOT: "/host/codex",
        DEPENDENCY_CACHE_HOST_ROOT: "/host/workspaces/dependencies",
      }),
    ).toThrow("separate from host workspace and Codex roots");
  });
});

describe("RunVault policy configuration", () => {
  it("loads a strict profile with validated overrides and Runtime limits", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNVAULT_POLICY_PROFILE: "strict",
      RUNVAULT_PROTECTED_PATTERNS: '["secrets/**"]',
      RUNVAULT_MAX_CHANGED_FILES: "7",
      RUNVAULT_MAX_DELETED_FILES: "1",
      RUNVAULT_MAX_CHANGED_BYTES: "1048576",
      RUNVAULT_STAGING_PER_RUN_BYTES: "2097152",
      RUNVAULT_STAGING_TOTAL_BYTES: "4194304",
      RUNVAULT_QUARANTINE_RETENTION_MS: "60000",
      CODEX_TIMEOUT_MS: "30000",
      VERIFICATION_TIMEOUT_MS: "10000",
      CONTAINER_CPU_LIMIT: "1.5",
      CONTAINER_MEMORY_LIMIT: "768m",
      CONTAINER_PIDS_LIMIT: "128",
    });

    expect(config.runVaultPolicy).toMatchObject({
      profile: "strict",
      maxChangedFiles: 7,
      maxDeletedFiles: 1,
      maxChangedBytes: 1_048_576,
      verificationMode: "require-verification",
      stagingPerRunBytes: 2_097_152,
      stagingTotalBytes: 4_194_304,
      quarantineRetentionMs: 60_000,
      runtime: {
        agentTimeoutMs: 30_000,
        verificationTimeoutMs: 10_000,
        containerCpuLimit: 1.5,
        containerMemoryLimit: "768m",
        containerPidsLimit: 128,
      },
    });
    expect(config.runVaultPolicy.protectedPatterns).toContain("secrets/**");
    expect(config.runVaultPolicy.protectedPatterns).toContain(".env");
  });

  it("rejects malformed patterns and inconsistent quotas", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        RUNVAULT_PROTECTED_PATTERNS: '["/absolute"]',
      }),
    ).toThrow("Invalid RunVault protected pattern");
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        RUNVAULT_MAX_CHANGED_BYTES: "2097152",
        RUNVAULT_STAGING_PER_RUN_BYTES: "1048576",
      }),
    ).toThrow("cannot exceed");
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        RUNVAULT_MAX_CHANGED_BYTES: "1048576",
        RUNVAULT_STAGING_PER_RUN_BYTES: "2097152",
        RUNVAULT_STAGING_TOTAL_BYTES: "1048576",
      }),
    ).toThrow("must be at least");
  });
});

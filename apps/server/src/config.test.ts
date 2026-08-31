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

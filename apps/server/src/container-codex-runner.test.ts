import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildContainerRunArgs,
  containerName,
} from "./container-codex-runner.js";

describe("Container Codex runner", () => {
  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      AGENT_WORKSPACE_ROOT: "/tmp/workspaces",
      CONTAINER_WORKSPACE_HOST_ROOT: "/host/workspaces",
      CONTAINER_CODEX_HOME_HOST_ROOT: "/host/codex-home",
      DEPENDENCY_CACHE_ROOT: "/tmp/dependencies",
      DEPENDENCY_CACHE_HOST_ROOT: "/host/dependencies",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent/unsafe",
        workspacePath: "/tmp/workspaces/.staging/run-1",
        prompt: "write a small program",
        threadId: null,
        dependencyCachePath: `/host/dependencies/${"a".repeat(64)}/node_modules`,
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain(
      "type=bind,src=/host/workspaces/.staging/run-1,dst=/workspace",
    );
    expect(args).toContain("type=bind,src=/host/codex-home,dst=/codex-home");
    expect(args).toContain(
      `type=bind,src=/host/dependencies/${"a".repeat(64)}/node_modules,dst=/workspace/node_modules,readonly`,
    );
    expect(args.slice(0, 5)).toEqual(["run", "--rm", "--pull", "never", "--init"]);
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it("forks a committed thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      AGENT_WORKSPACE_ROOT: "/tmp/workspaces",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspaces/.staging/run-2",
        prompt: "continue",
        threadId: "thread-123",
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["fork", "thread-123", "continue"]);
    expect(args).not.toContain("resume");
    expect(args).not.toContain("keep-id");
  });
});

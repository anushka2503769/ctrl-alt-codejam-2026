import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildVerificationContainerArgs,
  verificationContainerName,
  verificationWorkspaceMountSource,
} from "./container-verification-runner.js";

describe("container verification runner", () => {
  it("builds a no-network, resource-limited, non-root command", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      AGENT_WORKSPACE_ROOT: path.resolve("workspaces"),
      VERIFICATION_WORKSPACE_HOST_ROOT: "/srv/launchpad/workspaces",
      CONTAINER_ENGINE: "docker",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "0:0",
      ARK_API_KEY: "must-not-enter-verifier",
      APP_AUTH_TOKEN: "app-auth-must-not-enter-verifier",
      CODEX_HOME: path.resolve("secret-codex-home"),
    });
    const staging = path.join(config.workspaceRoot, ".staging", "run-123");
    const args = buildVerificationContainerArgs(staging, config);
    const rendered = args.join(" ");

    expect(args.slice(0, 5)).toEqual(["run", "--rm", "--pull", "never", "--init"]);
    expect(rendered).toContain("--network none");
    expect(rendered).toContain("--cap-drop ALL");
    expect(rendered).toContain("--security-opt no-new-privileges");
    expect(rendered).toContain("--read-only");
    expect(rendered).toContain("--cpus 2");
    expect(rendered).toContain("--memory 2g");
    expect(rendered).toContain("--pids-limit 256");
    expect(rendered).toContain("--user 1000:1000");
    expect(rendered).toContain(
      "type=bind,src=/srv/launchpad/workspaces/.staging/run-123,dst=/workspace",
    );
    expect(rendered).not.toContain("must-not-enter-verifier");
    expect(rendered).not.toContain("app-auth-must-not-enter-verifier");
    expect(rendered).not.toContain(config.codexHome);
    expect(rendered).toContain("ARK_API_KEY=");
    expect(rendered).toContain("APP_AUTH_TOKEN=");
    expect(rendered).toContain("CODEX_HOME=");
    expect(rendered).toContain("DOCKER_HOST=");
    expect(rendered).toContain("SSH_AUTH_SOCK=");
    expect(rendered).not.toContain("docker.sock");
    expect(args.filter((argument) => argument === "--mount")).toHaveLength(1);
    expect(args.slice(-3)).toEqual(["runtime:test", "npm", "test"]);
  });

  it("rejects trusted and out-of-scope workspace mounts", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      AGENT_WORKSPACE_ROOT: "/app/workspaces",
      VERIFICATION_WORKSPACE_HOST_ROOT: "/host/workspaces",
    });

    expect(
      verificationWorkspaceMountSource(
        "/app/workspaces/.staging/run-1",
        config,
      ),
    ).toBe("/host/workspaces/.staging/run-1");
    expect(() =>
      verificationWorkspaceMountSource("/app/workspaces/agent-1", config),
    ).toThrow("only a Run staging workspace");
    expect(() =>
      verificationWorkspaceMountSource("/etc", config),
    ).toThrow("only a Run staging workspace");
  });

  it("uses bounded Run-scoped container names", () => {
    expect(verificationContainerName("/tmp/.staging/run id", "instance"))
      .toBe("runvault-verify-instance-run-id");
  });
});

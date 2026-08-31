import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildDependencyPreparationArgs,
  dependencyPreparationContainerName,
} from "./container-dependency-runner.js";

describe("container dependency preparation", () => {
  it("uses a constrained networked container only for explicit npm ci", () => {
    const root = path.resolve("dependency-runner-test");
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      DEPENDENCY_MODE: "isolated-ci",
      DEPENDENCY_CACHE_ROOT: path.join(root, "dependencies"),
      RUNTIME_PROVIDER: "container",
      VERIFICATION_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "0:0",
      ARK_API_KEY: "must-not-enter-preparation",
      APP_AUTH_TOKEN: "app-secret-must-not-enter-preparation",
    });
    const cacheKey = "a".repeat(64);
    const args = buildDependencyPreparationArgs(
      { cacheKey, cacheHostPath: "/host/dependencies/partial" },
      config,
    );
    const rendered = args.join(" ");

    expect(args.slice(0, 5)).toEqual(["run", "--rm", "--pull", "never", "--init"]);
    expect(rendered).toContain("--network bridge");
    expect(rendered).toContain("--security-opt no-new-privileges");
    expect(rendered).toContain("--cap-drop ALL");
    expect(rendered).toContain("--read-only");
    expect(rendered).toContain("--user 1000:1000");
    expect(rendered).toContain("--userns keep-id");
    expect(rendered).toContain(
      "type=bind,src=/host/dependencies/partial,dst=/cache",
    );
    expect(args.filter((argument) => argument === "--mount")).toHaveLength(1);
    expect(args.slice(-7)).toEqual([
      "npm",
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      "/tmp/npm-cache",
    ]);
    expect(rendered).not.toContain("must-not-enter-preparation");
    expect(rendered).not.toContain("app-secret-must-not-enter-preparation");
    expect(rendered).not.toContain(config.workspaceRoot);
    expect(rendered).not.toContain(config.codexHome);
  });

  it("uses a bounded cache-scoped container name", () => {
    expect(dependencyPreparationContainerName("b".repeat(64), "instance"))
      .toBe(`runvault-deps-instance-${"b".repeat(16)}`);
  });
});

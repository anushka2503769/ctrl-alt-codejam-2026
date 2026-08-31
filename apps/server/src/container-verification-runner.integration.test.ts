import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  ContainerVerificationRunner,
  verificationContainerName,
} from "./container-verification-runner.js";
import { RunCancelledError } from "./errors.js";
import { RunVaultVerifier } from "./runvault-verifier.js";

const enabled = process.env.RUN_CONTAINER_INTEGRATION === "1";
const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe.skipIf(!enabled)("container verification integration", () => {
  it("blocks network and credentials while retaining staged test changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "runvault-container-test-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, ".staging", "run");
    await mkdir(workspace, { recursive: true });
    await chmod(workspace, 0o777);
    const script = [
      "const fs=require('fs');",
      "if (process.env.ARK_API_KEY||process.env.APP_AUTH_TOKEN||process.env.CODEX_HOME||process.env.DOCKER_HOST) process.exit(2);",
      "console.log('API_TOKEN=literal-container-secret');",
      "try{fs.writeFileSync('/runvault-outside-marker','escape');process.exit(4)}catch{}",
      "fetch('https://example.com', { signal: AbortSignal.timeout(2000) })",
      ".then(() => process.exit(3))",
      ".catch(() => fs.writeFileSync('verification-marker', 'isolated'))",
    ].join("");
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ scripts: { test: `node -e ${JSON.stringify(script)}` } }),
    );
    const config = loadConfig({
      NODE_ENV: "test",
      AGENT_WORKSPACE_ROOT: root,
      CONTAINER_ENGINE: "docker",
      CONTAINER_RUNTIME_IMAGE: "volc-agent-runtime:local",
      ARK_API_KEY: "server-secret-must-not-enter",
    });
    const verifier = new RunVaultVerifier({
      timeoutMs: 10_000,
      runner: new ContainerVerificationRunner(config),
      sourceEnvironment: { ARK_API_KEY: "server-secret-must-not-enter" },
    });

    const result = await verifier.verify(workspace);

    expect(result, result.redactedSummary).toMatchObject({
      status: "passed",
      exitCode: 0,
    });
    expect(result.redactedSummary).not.toContain("server-secret-must-not-enter");
    expect(result.redactedSummary).not.toContain("literal-container-secret");
    expect(result.redactedSummary).toContain("API_TOKEN=[REDACTED]");
    await expect(
      readFile(path.join(workspace, "verification-marker"), "utf8"),
    ).resolves.toBe("isolated");
  }, 20_000);

  it("force-removes a verification container when cancelled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "runvault-container-cancel-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, ".staging", "run");
    await mkdir(workspace, { recursive: true });
    await chmod(workspace, 0o777);
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({
        scripts: {
          test: `node -e "process.on('SIGTERM',()=>{});setInterval(() => {}, 1000)"`,
        },
      }),
    );
    const config = loadConfig({
      NODE_ENV: "test",
      AGENT_WORKSPACE_ROOT: root,
      CONTAINER_ENGINE: "docker",
      CONTAINER_RUNTIME_IMAGE: "volc-agent-runtime:local",
    });
    const verifier = new RunVaultVerifier({
      timeoutMs: 10_000,
      runner: new ContainerVerificationRunner(config),
    });
    const controller = new AbortController();
    const verification = verifier.verify(workspace, controller.signal);

    setTimeout(() => controller.abort(), 150);

    await expect(verification).rejects.toBeInstanceOf(RunCancelledError);
    await expect(
      execFileAsync("docker", [
        "inspect",
        verificationContainerName(workspace, config.runtimeInstanceId),
      ]),
    ).rejects.toBeDefined();
  }, 20_000);

  it("contains a process storm within the configured PID limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "runvault-container-pids-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, ".staging", "run");
    await mkdir(workspace, { recursive: true });
    await chmod(workspace, 0o777);
    const script = [
      "const cp=require('child_process'),fs=require('fs');",
      "let blocked=0;const children=[];",
      "for(let i=0;i<64;i++){",
      "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)']);",
      "child.on('error',()=>blocked++);children.push(child);}",
      "setTimeout(()=>{",
      "for(const child of children){try{child.kill('SIGKILL')}catch{}}",
      "if(blocked===0)process.exit(2);",
      "fs.writeFileSync('pids-marker',String(blocked));process.exit(0);",
      "},1500);",
    ].join("");
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ scripts: { test: `node -e ${JSON.stringify(script)}` } }),
    );
    const config = loadConfig({
      NODE_ENV: "test",
      AGENT_WORKSPACE_ROOT: root,
      CONTAINER_ENGINE: "docker",
      CONTAINER_RUNTIME_IMAGE: "volc-agent-runtime:local",
      CONTAINER_PIDS_LIMIT: "32",
    });
    const verifier = new RunVaultVerifier({
      timeoutMs: 10_000,
      runner: new ContainerVerificationRunner(config),
    });

    const result = await verifier.verify(workspace);

    expect(result, result.redactedSummary).toMatchObject({
      status: "passed",
      exitCode: 0,
    });
    expect(Number(await readFile(path.join(workspace, "pids-marker"), "utf8")))
      .toBeGreaterThan(0);
  }, 20_000);

  it("force-removes a verification container after its time limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "runvault-container-timeout-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, ".staging", "run");
    await mkdir(workspace, { recursive: true });
    await chmod(workspace, 0o777);
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({
        scripts: { test: `node -e "setInterval(() => {}, 1000)"` },
      }),
    );
    const config = loadConfig({
      NODE_ENV: "test",
      AGENT_WORKSPACE_ROOT: root,
      CONTAINER_ENGINE: "docker",
      CONTAINER_RUNTIME_IMAGE: "volc-agent-runtime:local",
    });
    const verifier = new RunVaultVerifier({
      timeoutMs: 300,
      runner: new ContainerVerificationRunner(config),
    });

    const result = await verifier.verify(workspace);

    expect(result).toMatchObject({ status: "failed", timedOut: true });
    await expect(
      execFileAsync("docker", [
        "inspect",
        verificationContainerName(workspace, config.runtimeInstanceId),
      ]),
    ).rejects.toBeDefined();
  }, 20_000);

  it("mounts managed dependencies read-only during offline verification", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "runvault-dependency-mount-"));
    temporaryDirectories.push(root);
    const workspaceRoot = path.join(root, "workspaces");
    const workspace = path.join(workspaceRoot, ".staging", "run");
    const cacheRoot = path.join(root, "dependencies");
    const cacheKey = "a".repeat(64);
    const dependencyPath = path.join(cacheRoot, cacheKey, "node_modules");
    const fixturePath = path.join(dependencyPath, "fixture", "index.js");
    await mkdir(path.dirname(fixturePath), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await chmod(workspace, 0o777);
    await writeFile(fixturePath, "module.exports = 'managed';\n");
    const script = [
      "const fs=require('fs');",
      "const resolved=require.resolve('fixture');",
      "if(require('fixture')!=='managed')process.exit(2);",
      "try{fs.writeFileSync(resolved,'tampered');process.exit(3)}catch{}",
      "fs.writeFileSync('dependency-verification-marker','readonly');",
    ].join("");
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ scripts: { test: `node -e ${JSON.stringify(script)}` } }),
    );
    const config = loadConfig({
      NODE_ENV: "test",
      AGENT_WORKSPACE_ROOT: workspaceRoot,
      DEPENDENCY_CACHE_ROOT: cacheRoot,
      DEPENDENCY_CACHE_HOST_ROOT: cacheRoot,
      CONTAINER_ENGINE: "docker",
      CONTAINER_RUNTIME_IMAGE: "volc-agent-runtime:local",
    });
    const verifier = new RunVaultVerifier({
      timeoutMs: 10_000,
      runner: new ContainerVerificationRunner(config),
    });

    const result = await verifier.verify(workspace, undefined, dependencyPath);

    expect(result, result.redactedSummary).toMatchObject({
      status: "passed",
      exitCode: 0,
    });
    await expect(readFile(fixturePath, "utf8")).resolves.toBe(
      "module.exports = 'managed';\n",
    );
    await expect(
      readFile(path.join(workspace, "dependency-verification-marker"), "utf8"),
    ).resolves.toBe("readonly");
  }, 20_000);
});

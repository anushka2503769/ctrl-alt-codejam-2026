import { execFile, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { validatedDependencyMountSource } from "./container-codex-runner.js";
import { RunCancelledError } from "./errors.js";
import {
  redactVerificationOutput,
  type RunVaultVerificationResult,
  type RunVaultVerificationRunner,
  type RunVaultVerificationRunnerOptions,
} from "./runvault-verifier.js";

const execFileAsync = promisify(execFile);

export function verificationContainerName(
  workspacePath: string,
  instanceId: string,
): string {
  const runId = path.basename(workspacePath).replace(/[^a-zA-Z0-9_.-]/g, "-");
  return `runvault-verify-${instanceId}-${runId}`.slice(0, 120);
}

export function verificationWorkspaceMountSource(
  workspacePath: string,
  config: AppConfig,
): string {
  const stagingRoot = path.resolve(config.workspaceRoot, ".staging");
  const workspace = path.resolve(workspacePath);
  const relative = path.relative(stagingRoot, workspace);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Verification may mount only a Run staging workspace");
  }
  return path.resolve(
    config.verificationWorkspaceHostRoot,
    ".staging",
    relative,
  );
}

export function buildVerificationContainerArgs(
  workspacePath: string,
  config: AppConfig,
  dependencyCachePath: string | null = null,
): string[] {
  const name = verificationContainerName(workspacePath, config.runtimeInstanceId);
  const mountSource = verificationWorkspaceMountSource(workspacePath, config);
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  const configuredUser = config.containerUser;
  const user = /^(?:0|root)(?::(?:0|root))?$/.test(configuredUser)
    ? "1000:1000"
    : configuredUser;
  const dependencyMount = dependencyCachePath
    ? validatedDependencyMountSource(dependencyCachePath, config)
    : null;
  return [
    "run",
    "--rm",
    "--pull",
    "never",
    "--init",
    "--name",
    name,
    "--label",
    "io.codejam.launchpad=runvault-verifier",
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    "--network",
    "none",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cpus",
    String(config.containerCpuLimit),
    "--memory",
    config.containerMemoryLimit,
    "--pids-limit",
    String(config.containerPidsLimit),
    "--user",
    user,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m",
    "--env",
    "CI=true",
    "--env",
    "APP_AUTH_TOKEN=",
    "--env",
    "ARK_API_KEY=",
    "--env",
    "CODEX_HOME=",
    "--env",
    "DOCKER_HOST=",
    "--env",
    "GIT_ASKPASS=",
    "--env",
    "HOME=/tmp",
    "--env",
    "NO_COLOR=1",
    "--env",
    "npm_config_audit=false",
    "--env",
    "npm_config_cache=/tmp/npm-cache",
    "--env",
    "npm_config_fund=false",
    "--env",
    "SSH_AUTH_SOCK=",
    "--mount",
    `type=bind,src=${mountSource},dst=/workspace`,
    ...(dependencyMount
      ? [
          "--mount",
          `type=bind,src=${dependencyMount},dst=/workspace/node_modules,readonly`,
        ]
      : []),
    "--workdir",
    "/workspace",
    config.containerRuntimeImage,
    "npm",
    "test",
  ];
}

export class ContainerVerificationRunner implements RunVaultVerificationRunner {
  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      const environment = this.engineEnvironment();
      await execFileAsync(this.config.containerEngine, ["version"], {
        timeout: 5_000,
        env: environment,
      });
      await execFileAsync(
        this.config.containerEngine,
        ["image", "inspect", this.config.containerRuntimeImage],
        { timeout: 5_000, env: environment },
      );
      return true;
    } catch {
      return false;
    }
  }

  async run(
    workspacePath: string,
    options: RunVaultVerificationRunnerOptions,
    signal?: AbortSignal,
  ): Promise<RunVaultVerificationResult> {
    if (signal?.aborted) throw new RunCancelledError();
    const containerName = verificationContainerName(
      workspacePath,
      this.config.runtimeInstanceId,
    );
    const child = spawn(
      this.config.containerEngine,
      buildVerificationContainerArgs(
        workspacePath,
        this.config,
        options.dependencyCachePath,
      ),
      { env: this.engineEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = Buffer.alloc(0);
    let truncated = false;
    const consume = (chunk: Buffer) => {
      const remaining = options.maxOutputBytes - output.length;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      output = Buffer.concat([output, chunk.subarray(0, remaining)]);
      if (chunk.length > remaining) truncated = true;
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);

    let timedOut = false;
    let cancelled = false;
    let removalPromise: Promise<void> | null = null;
    const remove = () => {
      removalPromise ??= execFileAsync(
        this.config.containerEngine,
        ["rm", "--force", containerName],
        { timeout: 8_000, env: this.engineEnvironment() },
      ).then(
        () => undefined,
        () => {
          child.kill("SIGKILL");
        },
      );
      return removalPromise;
    };
    const abort = () => {
      cancelled = true;
      void remove();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      void remove();
    }, options.timeoutMs);
    timer.unref();
    try {
      const completion = await new Promise<{ code: number | null; error: Error | null }>(
        (resolve) => {
          let settled = false;
          const finish = (code: number | null, error: Error | null) => {
            if (!settled) {
              settled = true;
              resolve({ code, error });
            }
          };
          child.once("error", (error) => finish(null, error));
          child.once("close", (code) => finish(code, null));
        },
      );
      const raw = output.toString("utf8").trim();
      const captured = redactVerificationOutput(
        `${raw}${truncated ? `${raw ? "\n" : ""}[output truncated]` : ""}`,
        options.sourceEnvironment,
      );
      if (cancelled) {
        await remove();
        throw new RunCancelledError();
      }
      if (timedOut) {
        await remove();
        return {
          status: "failed",
          command: "npm test",
          redactedSummary: `npm test timed out after ${options.timeoutMs} ms.${captured ? `\n${captured}` : ""}`,
          exitCode: completion.code,
          timedOut: true,
        };
      }
      if (completion.error) {
        return {
          status: "failed",
          command: "npm test",
          redactedSummary: `Verification container could not start: ${completion.error.message}`,
          exitCode: null,
          timedOut: false,
        };
      }
      return {
        status: completion.code === 0 ? "passed" : "failed",
        command: "npm test",
        redactedSummary:
          captured || `npm test exited with code ${completion.code ?? "unknown"}.`,
        exitCode: completion.code,
        timedOut: false,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  private engineEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "HOME", "TMPDIR", "XDG_RUNTIME_DIR", "DOCKER_HOST"]) {
      if (process.env[name]) environment[name] = process.env[name];
    }
    return environment;
  }
}

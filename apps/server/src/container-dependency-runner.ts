import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import {
  type DependencyPreparationRequest,
  type DependencyPreparationRunner,
  type DependencyRuntimeIdentity,
  DependencyPreparationError,
} from "./dependency-manager.js";
import { redactVerificationOutput } from "./runvault-verifier.js";

const execFileAsync = promisify(execFile);
const MAX_PREPARATION_OUTPUT_BYTES = 16_384;

export function dependencyPreparationContainerName(
  cacheKey: string,
  instanceId: string,
): string {
  if (!/^[a-f0-9]{64}$/.test(cacheKey)) {
    throw new DependencyPreparationError("Invalid dependency cache key");
  }
  return `runvault-deps-${instanceId}-${cacheKey.slice(0, 16)}`.slice(0, 120);
}

export function buildDependencyPreparationArgs(
  request: DependencyPreparationRequest,
  config: AppConfig,
): string[] {
  const configuredUser = config.containerUser;
  const user = /^(?:0|root)(?::(?:0|root))?$/.test(configuredUser)
    ? "1000:1000"
    : configuredUser;
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  return [
    "run",
    "--rm",
    "--pull",
    "never",
    "--init",
    "--name",
    dependencyPreparationContainerName(
      request.cacheKey,
      config.runtimeInstanceId,
    ),
    "--label",
    "io.codejam.launchpad=dependency-preparation",
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    "--network",
    "bridge",
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
    "/tmp:rw,nosuid,nodev,size=256m",
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
    "SSH_AUTH_SOCK=",
    "--mount",
    `type=bind,src=${request.cacheHostPath},dst=/cache`,
    "--workdir",
    "/cache",
    config.containerRuntimeImage,
    "npm",
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--cache",
    "/tmp/npm-cache",
  ];
}

export class ContainerDependencyRunner implements DependencyPreparationRunner {
  constructor(private readonly config: AppConfig) {}

  async runtimeIdentity(): Promise<DependencyRuntimeIdentity> {
    const environment = this.engineEnvironment();
    const [{ stdout: inspectedImage }, { stdout: npmVersion }] = await Promise.all([
      execFileAsync(
        this.config.containerEngine,
        [
          "image",
          "inspect",
          "--format",
          "{{.Id}} {{.Os}}/{{.Architecture}}",
          this.config.containerRuntimeImage,
        ],
        { timeout: 8_000, env: environment },
      ),
      execFileAsync(
        this.config.containerEngine,
        [
          "run",
          "--rm",
          "--pull",
          "never",
          "--network",
          "none",
          this.config.containerRuntimeImage,
          "npm",
          "--version",
        ],
        { timeout: 15_000, env: environment },
      ),
    ]);
    const [imageId = "", normalizedPlatform = ""] = inspectedImage
      .trim()
      .split(/\s+/);
    const normalizedVersion = npmVersion.trim();
    if (
      !/^sha256:[a-f0-9]{64}$/i.test(imageId) ||
      !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(normalizedPlatform) ||
      !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9_.-]+)?$/.test(normalizedVersion)
    ) {
      throw new DependencyPreparationError(
        "Runtime image returned an invalid platform or npm version",
      );
    }
    return {
      imageId: imageId.toLowerCase(),
      platform: normalizedPlatform,
      npmVersion: normalizedVersion,
    };
  }

  async prepare(request: DependencyPreparationRequest): Promise<void> {
    const containerName = dependencyPreparationContainerName(
      request.cacheKey,
      this.config.runtimeInstanceId,
    );
    const child = spawn(
      this.config.containerEngine,
      buildDependencyPreparationArgs(request, this.config),
      { env: this.engineEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = Buffer.alloc(0);
    let truncated = false;
    const consume = (chunk: Buffer) => {
      const remaining = MAX_PREPARATION_OUTPUT_BYTES - output.length;
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
    const remove = () =>
      execFileAsync(
        this.config.containerEngine,
        ["rm", "--force", containerName],
        { timeout: 8_000, env: this.engineEnvironment() },
      ).catch(() => child.kill("SIGKILL"));
    const timer = setTimeout(() => {
      timedOut = true;
      void remove();
    }, this.config.dependencyPreparationTimeoutMs);
    timer.unref();
    try {
      const completion = await new Promise<{
        code: number | null;
        error: Error | null;
      }>((resolve) => {
        let settled = false;
        const finish = (code: number | null, error: Error | null) => {
          if (settled) return;
          settled = true;
          resolve({ code, error });
        };
        child.once("error", (error) => finish(null, error));
        child.once("close", (code) => finish(code, null));
      });
      if (timedOut) {
        await remove();
        throw new DependencyPreparationError(
          `Dependency preparation timed out after ${this.config.dependencyPreparationTimeoutMs} ms`,
        );
      }
      const raw = output.toString("utf8").trim();
      const summary = redactVerificationOutput(
        `${raw}${truncated ? `${raw ? "\n" : ""}[output truncated]` : ""}`,
      );
      if (completion.error) {
        throw new DependencyPreparationError(
          `Dependency preparation container could not start: ${completion.error.message}`,
        );
      }
      if (completion.code !== 0) {
        throw new DependencyPreparationError(
          `npm ci failed with code ${completion.code ?? "unknown"}.${summary ? `\n${summary}` : ""}`,
        );
      }
    } finally {
      clearTimeout(timer);
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

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { RunCancelledError } from "./errors.js";
import type { RunVaultVerification } from "./types.js";

export const DEFAULT_VERIFICATION_TIMEOUT_MS = 120_000;
export const DEFAULT_VERIFICATION_MAX_OUTPUT_BYTES = 16_384;
const execFileAsync = promisify(execFile);

const SENSITIVE_ENVIRONMENT_NAME =
  /(token|secret|password|passwd|credential|private|api[_-]?key|authorization|cookie)/i;

export interface RunVaultVerificationResult extends RunVaultVerification {
  exitCode: number | null;
  timedOut: boolean;
}

export interface RunVaultVerifierOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  npmCommand?: string;
  sourceEnvironment?: NodeJS.ProcessEnv;
  runner?: RunVaultVerificationRunner;
}

export interface RunVaultVerificationRunnerOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  sourceEnvironment: NodeJS.ProcessEnv;
  dependencyCachePath: string | null;
}

export interface RunVaultVerificationRunner {
  isAvailable?(): Promise<boolean>;
  run(
    workspacePath: string,
    options: RunVaultVerificationRunnerOptions,
    signal?: AbortSignal,
  ): Promise<RunVaultVerificationResult>;
}

class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;

  constructor(private readonly maximumBytes: number) {}

  append(chunk: Buffer | string): void {
    if (this.bytes >= this.maximumBytes) {
      this.truncated = true;
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const available = this.maximumBytes - this.bytes;
    const retained = buffer.subarray(0, available);
    this.chunks.push(retained);
    this.bytes += retained.length;
    if (retained.length < buffer.length) this.truncated = true;
  }

  toString(): string {
    const output = Buffer.concat(this.chunks).toString("utf8").trim();
    return this.truncated
      ? `${output}${output ? "\n" : ""}[output truncated]`
      : output;
  }
}

function replaceAllLiteral(value: string, candidate: string): string {
  return value.split(candidate).join("[REDACTED]");
}

export function redactVerificationOutput(
  output: string,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): string {
  let redacted = output;
  const sensitiveValues = Object.entries(sourceEnvironment)
    .filter(([name, value]) => SENSITIVE_ENVIRONMENT_NAME.test(name) && value)
    .map(([, value]) => value as string)
    .filter((value) => value.length >= 8)
    .sort((left, right) => right.length - left.length);

  for (const value of sensitiveValues) {
    redacted = replaceAllLiteral(redacted, value);
  }

  redacted = redacted
    .replace(
      /(\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API_KEY|AUTHORIZATION|COOKIE)[A-Z0-9_]*\s*[=:]\s*)[^\s'";)]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(^|\n)(\s*[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API_KEY|AUTHORIZATION|COOKIE)[A-Z0-9_]*\s*[=:]\s*)[^\r\n]*/gi,
      "$1$2[REDACTED]",
    )
    .replace(
      /(["']?(?:token|secret|password|passwd|credential|private[_-]?key|api[_-]?key|authorization|cookie)["']?\s*:\s*)["'][^"'\r\n]*["']/gi,
      "$1\"[REDACTED]\"",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/\b(?:gh[opsu]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");

  return redacted;
}

function createVerificationEnvironment(
  source: NodeJS.ProcessEnv,
  temporaryHome: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CI: "true",
    FORCE_COLOR: "0",
    HOME: temporaryHome,
    NO_COLOR: "1",
    USERPROFILE: temporaryHome,
    XDG_CACHE_HOME: path.join(temporaryHome, ".cache"),
    XDG_CONFIG_HOME: path.join(temporaryHome, ".config"),
    npm_config_audit: "false",
    npm_config_cache: path.join(temporaryHome, ".npm-cache"),
    npm_config_color: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_userconfig: path.join(temporaryHome, ".npmrc"),
  };

  for (const name of ["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TMP", "TEMP", "TMPDIR"]) {
    if (source[name]) environment[name] = source[name];
  }
  return environment;
}

function terminateProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to terminating the direct child if its process group is gone.
    }
  }
  child.kill(signal);
}

function failedResult(summary: string): RunVaultVerificationResult {
  return {
    status: "failed",
    command: "npm test",
    redactedSummary: summary,
    exitCode: null,
    timedOut: false,
  };
}

export class RunVaultVerifier {
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly npmCommand: string;
  private readonly sourceEnvironment: NodeJS.ProcessEnv;
  private readonly runner: RunVaultVerificationRunner | null;

  constructor(options: RunVaultVerifierOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
    this.maxOutputBytes =
      options.maxOutputBytes ?? DEFAULT_VERIFICATION_MAX_OUTPUT_BYTES;
    this.npmCommand =
      options.npmCommand ?? (process.platform === "win32" ? "npm.cmd" : "npm");
    this.sourceEnvironment = options.sourceEnvironment ?? process.env;
    this.runner = options.runner ?? null;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Verification timeout must be a positive integer");
    }
    if (!Number.isInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0) {
      throw new Error("Verification output limit must be a positive integer");
    }
  }

  async isAvailable(): Promise<boolean> {
    if (this.runner?.isAvailable) return this.runner.isAvailable();
    try {
      await execFileAsync(this.npmCommand, ["--version"], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async verify(
    workspacePath: string,
    signal?: AbortSignal,
    dependencyCachePath: string | null = null,
  ): Promise<RunVaultVerificationResult> {
    if (signal?.aborted) throw new RunCancelledError();
    const manifestPath = path.join(workspacePath, "package.json");
    let manifestStats;
    try {
      manifestStats = await lstat(manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          status: "skipped",
          command: null,
          redactedSummary: "No package.json test script is configured.",
          exitCode: null,
          timedOut: false,
        };
      }
      throw error;
    }

    if (!manifestStats.isFile() || manifestStats.size > 1_048_576) {
      return failedResult("package.json must be a regular file no larger than 1 MiB.");
    }

    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      return failedResult("package.json could not be parsed.");
    }
    const scripts =
      manifest && typeof manifest === "object"
        ? (manifest as { scripts?: unknown }).scripts
        : null;
    const testScript =
      scripts && typeof scripts === "object"
        ? (scripts as Record<string, unknown>).test
        : null;
    if (typeof testScript !== "string" || testScript.trim() === "") {
      return {
        status: "skipped",
        command: null,
        redactedSummary: "No package.json test script is configured.",
        exitCode: null,
        timedOut: false,
      };
    }

    return this.runner
      ? this.runner.run(
          workspacePath,
          {
            timeoutMs: this.timeoutMs,
            maxOutputBytes: this.maxOutputBytes,
            sourceEnvironment: this.sourceEnvironment,
            dependencyCachePath,
          },
          signal,
        )
      : this.runNpmTest(workspacePath, signal);
  }

  private async runNpmTest(
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<RunVaultVerificationResult> {
    const temporaryHome = await mkdtemp(path.join(tmpdir(), "runvault-verify-"));
    const output = new BoundedOutput(this.maxOutputBytes);
    let timedOut = false;
    let aborted = false;

    try {
      const child = spawn(this.npmCommand, ["test"], {
        cwd: workspacePath,
        detached: process.platform !== "win32",
        env: createVerificationEnvironment(this.sourceEnvironment, temporaryHome),
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (chunk: Buffer) => output.append(chunk));
      child.stderr?.on("data", (chunk: Buffer) => output.append(chunk));
      const abort = () => {
        aborted = true;
        terminateProcess(child, "SIGTERM");
      };
      signal?.addEventListener("abort", abort, { once: true });

      let forceKillTimer: NodeJS.Timeout | undefined;
      const timeout = setTimeout(() => {
        timedOut = true;
        terminateProcess(child, "SIGTERM");
        forceKillTimer = setTimeout(() => terminateProcess(child, "SIGKILL"), 2_000);
        forceKillTimer.unref();
      }, this.timeoutMs);
      timeout.unref();

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

      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);
      const captured = redactVerificationOutput(
        output.toString(),
        this.sourceEnvironment,
      );

      if (aborted) throw new RunCancelledError();

      if (timedOut) {
        return {
          status: "failed",
          command: "npm test",
          redactedSummary: `npm test timed out after ${this.timeoutMs} ms.${captured ? `\n${captured}` : ""}`,
          exitCode: completion.code,
          timedOut: true,
        };
      }
      if (completion.error) {
        return failedResult(
          `npm test could not start: ${completion.error.message}`,
        );
      }

      const status = completion.code === 0 ? "passed" : "failed";
      return {
        status,
        command: "npm test",
        redactedSummary:
          captured || `npm test exited with code ${completion.code ?? "unknown"}.`,
        exitCode: completion.code,
        timedOut: false,
      };
    } finally {
      await rm(temporaryHome, { recursive: true, force: true });
    }
  }
}

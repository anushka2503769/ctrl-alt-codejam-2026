import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyRunVaultMetrics } from "./runvault-observability.js";
import { historicalRunVaultPolicySnapshot } from "./runvault-policy-config.js";
import type { Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 1,
  agents: [],
  messages: [],
  runs: [],
});

function validIsoTimestamp(value: string | null | undefined, fallback: string): string {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Database;
      if (parsed.version !== 1 || !Array.isArray(parsed.agents)) {
        throw new Error("Unsupported database format");
      }
      for (const run of parsed.runs) {
        run.parentRunId ??= null;
        run.supersededByRunId ??= null;
        run.revisionNumber ??= 0;
        run.runVault ??= null;
        run.runVaultEvents ??= [];
        run.runVaultMetrics ??= emptyRunVaultMetrics();
        run.runVaultMetrics.stagingDurationMs ??= null;
        run.runVaultMetrics.stagingCopiedEntries ??= null;
        run.runVaultMetrics.stagingCopiedBytes ??= null;
        run.runVaultMetrics.agentDurationMs ??= null;
        run.runVaultMetrics.inspectionDurationMs ??= null;
        run.runVaultMetrics.verificationDurationMs ??= null;
        run.runVaultMetrics.decisionDurationMs ??= null;
        run.runVaultMetrics.cleanupDurationMs ??= null;
        run.runVaultMetrics.cleanupStatus ??= "not_required";
        run.runVaultMetrics.changedFileCount ??= 0;
        run.runVaultMetrics.changedBytes ??= 0;
        run.runVaultMetrics.outcome ??= null;
        run.runVaultMetrics.verificationStatus ??= null;
        if (run.runVault) {
          run.runVault.resolution ??= "policy";
          run.runVault.trustedWorkspaceFingerprint ??= null;
          run.runVault.stagingWorkspaceFingerprint ??= null;
          run.runVault.findings ??= [];
          run.runVault.changedFiles ??= {
            addedCount: 0,
            modifiedCount: 0,
            deletedCount: 0,
            protectedPathsTouched: [],
            files: [],
            omittedFileCount: 0,
            changedBytes: 0,
          };
          run.runVault.changedFiles.files ??= [];
          run.runVault.changedFiles.omittedFileCount ??= 0;
          run.runVault.changedFiles.changedBytes ??= 0;
          run.runVault.policy ??= historicalRunVaultPolicySnapshot(
            run.createdAt,
          );
          if (run.runVault.outcome === "quarantined") {
            const retainedAt = validIsoTimestamp(
              run.runVault.retainedAt ?? run.runVault.decidedAt,
              new Date().toISOString(),
            );
            run.runVault.retainedAt = retainedAt;
            run.runVault.expiresAt = validIsoTimestamp(
              run.runVault.expiresAt,
              new Date(
                Date.parse(retainedAt) +
                  run.runVault.policy.quarantineRetentionMs,
              ).toISOString(),
            );
          } else {
            run.runVault.retainedAt ??= null;
            run.runVault.expiresAt ??= null;
          }
        }
      }
      this.data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

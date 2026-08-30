import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CHANGED_FILES,
  DEFAULT_MAX_DELETED_FILES,
  evaluateRunVaultPolicy,
  type RunVaultPolicyInput,
} from "./runvault-policy.js";
import type { RunVaultFileChange } from "./types.js";

function change(
  path: string,
  overrides: Partial<RunVaultFileChange> = {},
): RunVaultFileChange {
  return {
    path,
    kind: "modified",
    protected: false,
    dependencyFile: false,
    executable: false,
    binary: false,
    symbolicLink: false,
    ...overrides,
  };
}

function evaluate(overrides: Partial<RunVaultPolicyInput> = {}) {
  return evaluateRunVaultPolicy({
    executionStatus: "succeeded",
    verificationStatus: "passed",
    changes: [change("src/index.ts")],
    ...overrides,
  });
}

describe("RunVault deterministic policy", () => {
  it("promotes safe changes after verification passes", () => {
    expect(evaluate()).toEqual({
      outcome: "promoted",
      reason: "verified_safe",
      changedFiles: {
        addedCount: 0,
        modifiedCount: 1,
        deletedCount: 0,
        protectedPathsTouched: [],
      },
    });
  });

  it("allows safe changes when verification is not configured", () => {
    expect(evaluate({ verificationStatus: "skipped" })).toMatchObject({
      outcome: "promoted",
      reason: "verified_safe",
    });
  });

  it.each([
    ["cancelled", "cancelled"],
    ["timed_out", "timed_out"],
    ["failed", "run_failed"],
  ] as const)("discards a %s execution", (executionStatus, reason) => {
    expect(evaluate({ executionStatus })).toMatchObject({
      outcome: "discarded",
      reason,
    });
  });

  it("discards verification failures before considering risky changes", () => {
    const result = evaluate({
      verificationStatus: "failed",
      changes: [change("deploy/app.yaml", { protected: true })],
    });
    expect(result).toMatchObject({
      outcome: "discarded",
      reason: "verification_failed",
    });
  });

  it("quarantines when the trusted workspace changed concurrently", () => {
    expect(evaluate({ trustedWorkspaceChanged: true })).toMatchObject({
      outcome: "quarantined",
      reason: "trusted_workspace_changed",
    });
  });

  it("quarantines symbolic links before other risky file classifications", () => {
    const result = evaluate({
      changes: [
        change("deploy/current", {
          protected: true,
          dependencyFile: true,
          executable: true,
          symbolicLink: true,
        }),
      ],
    });
    expect(result).toMatchObject({ outcome: "quarantined", reason: "unsafe_link" });
  });

  it("quarantines protected paths and reports only their normalized names", () => {
    const result = evaluate({
      changes: [
        change("src/index.ts", { kind: "added" }),
        change(".env.production", { protected: true }),
        change("deploy/app.yaml", { protected: true, kind: "deleted" }),
      ],
    });
    expect(result).toEqual({
      outcome: "quarantined",
      reason: "protected_path",
      changedFiles: {
        addedCount: 1,
        modifiedCount: 1,
        deletedCount: 1,
        protectedPathsTouched: [".env.production", "deploy/app.yaml"],
      },
    });
  });

  it("quarantines dependency files", () => {
    expect(
      evaluate({ changes: [change("package-lock.json", { dependencyFile: true })] }),
    ).toMatchObject({ outcome: "quarantined", reason: "dependency_change" });
  });

  it.each([
    ["executable", { executable: true }],
    ["binary", { binary: true }],
  ] as const)("quarantines a new %s file", (_label, flags) => {
    expect(
      evaluate({ changes: [change("build/tool", { kind: "added", ...flags })] }),
    ).toMatchObject({ outcome: "quarantined", reason: "unsafe_file" });
  });

  it("quarantines only after the changed-file limit is exceeded", () => {
    const atLimit = Array.from({ length: DEFAULT_MAX_CHANGED_FILES }, (_, index) =>
      change(`src/file-${index}.ts`),
    );
    expect(evaluate({ changes: atLimit }).outcome).toBe("promoted");
    expect(
      evaluate({ changes: [...atLimit, change("src/one-too-many.ts")] }),
    ).toMatchObject({ outcome: "quarantined", reason: "change_limit_exceeded" });
  });

  it("quarantines only after the deletion limit is exceeded", () => {
    const atLimit = Array.from({ length: DEFAULT_MAX_DELETED_FILES }, (_, index) =>
      change(`src/old-${index}.ts`, { kind: "deleted" }),
    );
    expect(evaluate({ changes: atLimit }).outcome).toBe("promoted");
    expect(
      evaluate({
        changes: [...atLimit, change("src/one-too-many.ts", { kind: "deleted" })],
      }),
    ).toMatchObject({ outcome: "quarantined", reason: "change_limit_exceeded" });
  });

  it("supports explicit limits without changing the platform defaults", () => {
    expect(
      evaluate({
        changes: [change("one.ts"), change("two.ts")],
        maxChangedFiles: 1,
      }),
    ).toMatchObject({ outcome: "quarantined", reason: "change_limit_exceeded" });
    expect(DEFAULT_MAX_CHANGED_FILES).toBe(20);
    expect(DEFAULT_MAX_DELETED_FILES).toBe(5);
  });
});

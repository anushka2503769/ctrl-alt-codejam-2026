import { describe, expect, it } from "vitest";
import type {
  RunVaultFindingCode,
  RunVaultOutcome,
  RunVaultReason,
  RunVaultResolution,
} from "./types";
import {
  findingCopy,
  reasonCopy,
  resolutionCopy,
  verificationCopy,
  workspaceOutcomeCopy,
} from "./runvault-copy";

describe("RunVault outcome language", () => {
  it("defines copy for every persisted enum value", () => {
    const outcomes: RunVaultOutcome[] = ["promoted", "quarantined", "discarded"];
    const reasons: RunVaultReason[] = ["verified_safe", "protected_path", "change_limit_exceeded", "dependency_change", "verification_failed", "run_failed", "cancelled", "timed_out", "unsafe_file", "unsafe_link", "trusted_workspace_changed", "verification_required", "verification_unavailable", "change_bytes_exceeded", "staging_quota_exceeded", "retention_expired"];
    const resolutions: RunVaultResolution[] = ["policy", "human_approved", "human_discarded", "expired"];
    const findings: RunVaultFindingCode[] = ["execution_cancelled", "execution_timed_out", "execution_failed", "verification_failed", "trusted_workspace_changed", "unsafe_link", "protected_path", "dependency_change", "unsafe_file", "change_limit_exceeded", "deletion_limit_exceeded", "verification_required", "change_bytes_exceeded", "verification_unavailable", "staging_quota_exceeded", "retention_expired"];
    expect(outcomes.every((value) => workspaceOutcomeCopy[value].label)).toBe(true);
    expect(reasons.every((value) => reasonCopy[value])).toBe(true);
    expect(resolutions.every((value) => resolutionCopy[value])).toBe(true);
    expect(findings.every((value) => findingCopy[value].title)).toBe(true);
  });

  it("never describes skipped verification as verified or passed", () => {
    const copy = verificationCopy({ status: "skipped", command: null, redactedSummary: "No package.json test script is configured." });
    expect(copy.label).toBe("No tests ran — no test script configured");
    expect(`${copy.label} ${copy.explanation}`).not.toMatch(/verified|passed/i);
  });

  it("uses a safety-specific explanation for other skipped checks", () => {
    const copy = verificationCopy({ status: "skipped", command: null, redactedSummary: "Verification was skipped because the staged workspace introduced a symbolic link." });
    expect(copy.label).toBe("No tests ran — verification skipped");
    expect(copy.explanation).toContain("symbolic link");
  });

  it("separates workspace application from test status", () => {
    expect(workspaceOutcomeCopy.promoted.label).toBe("Applied to trusted workspace");
    expect(verificationCopy({ status: "passed", command: "npm test", redactedSummary: null }).label).toBe("Tests passed");
  });

  it("distinguishes human-approved and automatic promotion", () => {
    expect(resolutionCopy.human_approved).not.toBe(resolutionCopy.policy);
  });

  it("distinguishes unavailable verification from skipped and failed", () => {
    const unavailable = verificationCopy({
      status: "unavailable",
      command: null,
      redactedSummary: "Matching dependencies were unavailable.",
    });
    expect(unavailable.label).toBe("Tests unavailable");
    expect(unavailable.explanation).toContain("dependencies");
    expect(unavailable.label).not.toBe(
      verificationCopy({ status: "skipped", command: null, redactedSummary: null })
        .label,
    );
  });
});

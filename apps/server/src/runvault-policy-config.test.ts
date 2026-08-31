import { describe, expect, it } from "vitest";
import {
  createRunVaultPolicySnapshot,
  matchesProtectedPattern,
  parseProtectedPatterns,
} from "./runvault-policy-config.js";

const runtime = {
  agentTimeoutMs: 30_000,
  verificationTimeoutMs: 10_000,
  containerCpuLimit: 1.5,
  containerMemoryLimit: "768m",
  containerPidsLimit: 128,
};

describe("RunVault policy profiles", () => {
  it("creates distinct validated standard and strict profiles", () => {
    const standard = createRunVaultPolicySnapshot(
      "standard",
      {},
      runtime,
      "2026-01-01T00:00:00.000Z",
    );
    const strict = createRunVaultPolicySnapshot(
      "strict",
      {},
      runtime,
      "2026-01-02T00:00:00.000Z",
    );

    expect(standard).toMatchObject({
      version: 1,
      profile: "standard",
      verificationMode: "allow-skipped",
      runtime,
    });
    expect(strict).toMatchObject({
      profile: "strict",
      verificationMode: "require-verification",
      runtime,
    });
    expect(strict.maxChangedFiles).toBeLessThan(standard.maxChangedFiles);
    expect(strict.maxChangedBytes).toBeLessThan(standard.maxChangedBytes);
    expect(strict.quarantineRetentionMs).toBeLessThan(
      standard.quarantineRetentionMs,
    );
  });

  it("adds custom protected patterns without removing platform protections", () => {
    const policy = createRunVaultPolicySnapshot(
      "standard",
      { protectedPatterns: ["secrets", "secrets/**", "*.pem"] },
      runtime,
      "2026-01-01T00:00:00.000Z",
    );

    expect(matchesProtectedPattern("secrets/key.txt", policy.protectedPatterns))
      .toBe(true);
    expect(matchesProtectedPattern("server.pem", policy.protectedPatterns)).toBe(true);
    expect(matchesProtectedPattern(".env.production", policy.protectedPatterns))
      .toBe(true);
    expect(matchesProtectedPattern(".git/config", policy.protectedPatterns)).toBe(true);
    expect(matchesProtectedPattern("src/index.ts", policy.protectedPatterns)).toBe(false);
  });

  it("parses only bounded, normalized relative patterns", () => {
    expect(parseProtectedPatterns('["./secrets/**","private/*"]')).toEqual([
      "secrets/**",
      "private/*",
    ]);
    expect(() => parseProtectedPatterns("not-json")).toThrow("JSON string array");
    expect(() => parseProtectedPatterns('["../escape"]')).toThrow(
      "Invalid RunVault protected pattern",
    );
    expect(() => parseProtectedPatterns('["safe",42]')).toThrow(
      "only strings",
    );
  });

  it("rejects internally inconsistent storage and byte limits", () => {
    expect(() =>
      createRunVaultPolicySnapshot(
        "standard",
        { stagingPerRunBytes: 2_000_000, stagingTotalBytes: 1_000_000 },
        runtime,
        "2026-01-01T00:00:00.000Z",
      ),
    ).toThrow("must be at least");
    expect(() =>
      createRunVaultPolicySnapshot(
        "standard",
        { stagingPerRunBytes: 2_000_000, maxChangedBytes: 2_000_001 },
        runtime,
        "2026-01-01T00:00:00.000Z",
      ),
    ).toThrow("cannot exceed");
  });
});

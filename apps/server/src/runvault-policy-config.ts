import type {
  RunVaultPolicyProfileName,
  RunVaultPolicySnapshot,
  RunVaultVerificationMode,
} from "./types.js";

export const MANDATORY_PROTECTED_PATTERNS = [
  ".git",
  ".git/**",
  "node_modules",
  "node_modules/**",
  ".codex",
  ".codex/**",
  ".staging",
  ".staging/**",
] as const;

export const DEFAULT_PROTECTED_PATTERNS = [
  ...MANDATORY_PROTECTED_PATTERNS,
  ".env",
  ".env.*",
  "AGENTS.md",
  ".github/workflows",
  ".github/workflows/**",
  "infra",
  "infra/**",
  "deploy",
  "deploy/**",
] as const;

interface PolicyDefaults {
  maxChangedFiles: number;
  maxDeletedFiles: number;
  maxChangedBytes: number;
  verificationMode: RunVaultVerificationMode;
  stagingPerRunBytes: number;
  stagingTotalBytes: number;
  quarantineRetentionMs: number;
}

const POLICY_DEFAULTS: Record<RunVaultPolicyProfileName, PolicyDefaults> = {
  standard: {
    maxChangedFiles: 20,
    maxDeletedFiles: 5,
    maxChangedBytes: 25 * 1024 * 1024,
    verificationMode: "allow-skipped",
    stagingPerRunBytes: 512 * 1024 * 1024,
    stagingTotalBytes: 2 * 1024 * 1024 * 1024,
    quarantineRetentionMs: 7 * 24 * 60 * 60 * 1_000,
  },
  strict: {
    maxChangedFiles: 10,
    maxDeletedFiles: 2,
    maxChangedBytes: 10 * 1024 * 1024,
    verificationMode: "require-verification",
    stagingPerRunBytes: 256 * 1024 * 1024,
    stagingTotalBytes: 1024 * 1024 * 1024,
    quarantineRetentionMs: 24 * 60 * 60 * 1_000,
  },
};

export interface RunVaultPolicyOverrides {
  protectedPatterns?: string[] | undefined;
  maxChangedFiles?: number | undefined;
  maxDeletedFiles?: number | undefined;
  maxChangedBytes?: number | undefined;
  verificationMode?: RunVaultVerificationMode | undefined;
  stagingPerRunBytes?: number | undefined;
  stagingTotalBytes?: number | undefined;
  quarantineRetentionMs?: number | undefined;
}

export interface RunVaultRuntimePolicyInput {
  agentTimeoutMs: number;
  verificationTimeoutMs: number;
  containerCpuLimit: number;
  containerMemoryLimit: string;
  containerPidsLimit: number;
}

function validatePattern(pattern: string): string {
  const normalized = pattern.trim().replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized) > 256 ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("\0") ||
    /[?\[\]{}]/.test(normalized)
  ) {
    throw new Error(`Invalid RunVault protected pattern: ${pattern}`);
  }
  return normalized.replace(/^\.\//, "");
}

export function parseProtectedPatterns(raw: string | undefined): string[] | undefined {
  if (!raw?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("RUNVAULT_PROTECTED_PATTERNS must be a JSON string array");
  }
  if (!Array.isArray(parsed) || parsed.length > 100) {
    throw new Error("RUNVAULT_PROTECTED_PATTERNS must contain at most 100 patterns");
  }
  return parsed.map((item) => {
    if (typeof item !== "string") {
      throw new Error("RUNVAULT_PROTECTED_PATTERNS must contain only strings");
    }
    return validatePattern(item);
  });
}

function orderedPatterns(configured: string[] | undefined): string[] {
  const candidates = [
    ...DEFAULT_PROTECTED_PATTERNS,
    ...(configured ?? []),
  ];
  return [...new Set(candidates.map(validatePattern))].sort();
}

export function createRunVaultPolicySnapshot(
  profile: RunVaultPolicyProfileName,
  overrides: RunVaultPolicyOverrides,
  runtime: RunVaultRuntimePolicyInput,
  capturedAt: string,
): RunVaultPolicySnapshot {
  const defaults = POLICY_DEFAULTS[profile];
  const snapshot: RunVaultPolicySnapshot = {
    version: 1,
    profile,
    capturedAt,
    protectedPatterns: orderedPatterns(overrides.protectedPatterns),
    maxChangedFiles: overrides.maxChangedFiles ?? defaults.maxChangedFiles,
    maxDeletedFiles: overrides.maxDeletedFiles ?? defaults.maxDeletedFiles,
    maxChangedBytes: overrides.maxChangedBytes ?? defaults.maxChangedBytes,
    verificationMode: overrides.verificationMode ?? defaults.verificationMode,
    stagingPerRunBytes:
      overrides.stagingPerRunBytes ?? defaults.stagingPerRunBytes,
    stagingTotalBytes: overrides.stagingTotalBytes ?? defaults.stagingTotalBytes,
    quarantineRetentionMs:
      overrides.quarantineRetentionMs ?? defaults.quarantineRetentionMs,
    runtime: {
      agentTimeoutMs: runtime.agentTimeoutMs,
      verificationTimeoutMs: runtime.verificationTimeoutMs,
      containerCpuLimit: runtime.containerCpuLimit,
      containerMemoryLimit: runtime.containerMemoryLimit,
      containerPidsLimit: runtime.containerPidsLimit,
    },
  };
  if (snapshot.stagingTotalBytes < snapshot.stagingPerRunBytes) {
    throw new Error(
      "RUNVAULT_STAGING_TOTAL_BYTES must be at least RUNVAULT_STAGING_PER_RUN_BYTES",
    );
  }
  if (snapshot.maxChangedBytes > snapshot.stagingPerRunBytes) {
    throw new Error(
      "RUNVAULT_MAX_CHANGED_BYTES cannot exceed RUNVAULT_STAGING_PER_RUN_BYTES",
    );
  }
  return snapshot;
}

export function historicalRunVaultPolicySnapshot(
  capturedAt: string,
): RunVaultPolicySnapshot {
  return createRunVaultPolicySnapshot(
    "standard",
    {},
    {
      agentTimeoutMs: 600_000,
      verificationTimeoutMs: 120_000,
      containerCpuLimit: 2,
      containerMemoryLimit: "2g",
      containerPidsLimit: 256,
    },
    capturedAt,
  );
}

function globExpression(pattern: string): RegExp {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else {
      expression += character.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${expression}$`);
}

export function matchesProtectedPattern(
  relativePath: string,
  patterns: readonly string[],
): boolean {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  return patterns.some((pattern) => globExpression(pattern).test(normalized));
}

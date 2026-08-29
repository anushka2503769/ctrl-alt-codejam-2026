import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunCancelledError } from "./errors.js";
import {
  redactVerificationOutput,
  RunVaultVerifier,
} from "./runvault-verifier.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "runvault-verifier-test-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function writePackage(testScript?: string): Promise<void> {
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify({
      name: "verification-fixture",
      private: true,
      ...(testScript === undefined ? {} : { scripts: { test: testScript } }),
    }),
    "utf8",
  );
}

describe("RunVaultVerifier", () => {
  it("passes a configured npm test in the staged workspace", async () => {
    await writePackage(`node -e "console.log('verification passed')"`);

    const result = await new RunVaultVerifier().verify(workspace);

    expect(result).toMatchObject({
      status: "passed",
      command: "npm test",
      exitCode: 0,
      timedOut: false,
    });
    expect(result.redactedSummary).toContain("verification passed");
  });

  it("reports a failing npm test", async () => {
    await writePackage(`node -e "console.error('assertion failed'); process.exit(2)"`);

    const result = await new RunVaultVerifier().verify(workspace);

    expect(result).toMatchObject({
      status: "failed",
      command: "npm test",
      exitCode: 2,
      timedOut: false,
    });
    expect(result.redactedSummary).toContain("assertion failed");
  });

  it.each([
    ["without a package manifest", false],
    ["without a test script", true],
  ])("skips verification %s", async (_label, createPackage) => {
    if (createPackage) await writePackage();

    const result = await new RunVaultVerifier().verify(workspace);

    expect(result).toEqual({
      status: "skipped",
      command: null,
      redactedSummary: "No package.json test script is configured.",
      exitCode: null,
      timedOut: false,
    });
  });

  it("fails closed when package.json is malformed", async () => {
    await writeFile(path.join(workspace, "package.json"), "{not json", "utf8");

    const result = await new RunVaultVerifier().verify(workspace);

    expect(result).toMatchObject({
      status: "failed",
      redactedSummary: "package.json could not be parsed.",
    });
  });

  it("does not follow a package.json symbolic link", async () => {
    const outside = path.join(path.dirname(workspace), path.basename(workspace) + ".json");
    await writeFile(outside, JSON.stringify({ scripts: { test: "echo unsafe" } }));
    try {
      await symlink(outside, path.join(workspace, "package.json"));

      const result = await new RunVaultVerifier().verify(workspace);

      expect(result).toMatchObject({
        status: "failed",
        redactedSummary: "package.json must be a regular file no larger than 1 MiB.",
      });
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("times out and terminates the test process group", async () => {
    await writePackage(`node -e "setInterval(() => {}, 1000)"`);

    const result = await new RunVaultVerifier({ timeoutMs: 100 }).verify(workspace);

    expect(result).toMatchObject({ status: "failed", timedOut: true });
    expect(result.redactedSummary).toContain("timed out after 100 ms");
  });

  it("terminates verification when the Run is cancelled", async () => {
    await writePackage(`node -e "setInterval(() => {}, 1000)"`);
    const controller = new AbortController();
    const verification = new RunVaultVerifier({ timeoutMs: 10_000 }).verify(
      workspace,
      controller.signal,
    );

    setTimeout(() => controller.abort(), 100);

    await expect(verification).rejects.toBeInstanceOf(RunCancelledError);
  });

  it("bounds retained output", async () => {
    await writePackage(`node -e "process.stdout.write('x'.repeat(5000))"`);

    const result = await new RunVaultVerifier({ maxOutputBytes: 256 }).verify(workspace);

    expect(result.status).toBe("passed");
    expect(Buffer.byteLength(result.redactedSummary ?? "")).toBeLessThan(300);
    expect(result.redactedSummary).toContain("[output truncated]");
  });

  it("redacts credential-shaped output and known sensitive values", async () => {
    await writePackage(
      `node -e "console.log('API_TOKEN=visible-secret'); console.log('Authorization: Bearer abcdefghijklmnop'); console.log('known-value-123')"`,
    );
    const verifier = new RunVaultVerifier({
      sourceEnvironment: {
        PATH: process.env.PATH,
        ARK_API_KEY: "known-value-123",
      },
    });

    const result = await verifier.verify(workspace);

    expect(result.status).toBe("passed");
    expect(result.redactedSummary).not.toContain("visible-secret");
    expect(result.redactedSummary).not.toContain("abcdefghijklmnop");
    expect(result.redactedSummary).not.toContain("known-value-123");
    expect(result.redactedSummary).toContain("[REDACTED]");
  });

  it("does not pass server credentials to npm tests", async () => {
    await writePackage(
      `node -e "console.log(process.env.ARK_API_KEY || 'credential-not-inherited')"`,
    );
    const verifier = new RunVaultVerifier({
      sourceEnvironment: {
        PATH: process.env.PATH,
        ARK_API_KEY: "server-secret-value",
      },
    });

    const result = await verifier.verify(workspace);

    expect(result.status).toBe("passed");
    expect(result.redactedSummary).toContain("credential-not-inherited");
    expect(result.redactedSummary).not.toContain("server-secret-value");
  });

  it("reports when npm cannot be started", async () => {
    await writePackage("echo test");

    const result = await new RunVaultVerifier({
      npmCommand: path.join(workspace, "missing-npm"),
    }).verify(workspace);

    expect(result).toMatchObject({ status: "failed", exitCode: null });
    expect(result.redactedSummary).toContain("npm test could not start");
  });

  it("validates verifier resource limits", () => {
    expect(() => new RunVaultVerifier({ timeoutMs: 0 })).toThrow(
      "Verification timeout must be a positive integer",
    );
    expect(() => new RunVaultVerifier({ maxOutputBytes: 0 })).toThrow(
      "Verification output limit must be a positive integer",
    );
  });
});

describe("redactVerificationOutput", () => {
  it("redacts common token formats and JSON secrets", () => {
    const output = [
      "github_pat_abcdefghijklmnop",
      '"password": "correct horse battery staple"',
      "Authorization: Bearer bearer-token-value",
    ].join("\n");

    const redacted = redactVerificationOutput(output, {});

    expect(redacted).not.toContain("abcdefghijklmnop");
    expect(redacted).not.toContain("correct horse battery staple");
    expect(redacted).not.toContain("bearer-token-value");
  });
});

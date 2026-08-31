import type { AppConfig } from "./config.js";
import { ContainerVerificationRunner } from "./container-verification-runner.js";
import { RunVaultVerifier } from "./runvault-verifier.js";

export function createVerifier(config: AppConfig): RunVaultVerifier {
  const options = {
    timeoutMs: config.verificationTimeoutMs,
    maxOutputBytes: config.verificationMaxOutputBytes,
  };
  if (config.verificationProvider === "host") {
    if (config.nodeEnv === "production") {
      throw new Error("Host verification is not allowed in production");
    }
    return new RunVaultVerifier(options);
  }
  return new RunVaultVerifier({
    ...options,
    runner: new ContainerVerificationRunner(config),
  });
}

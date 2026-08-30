import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { createVerifier } from "./verifier-factory.js";

describe("verification provider configuration", () => {
  it("defaults to container verification", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.verificationProvider).toBe("container");
    expect(createVerifier(config)).toBeDefined();
  });

  it("allows an explicit host fallback only outside production", () => {
    expect(
      loadConfig({ NODE_ENV: "development", VERIFICATION_PROVIDER: "host" })
        .verificationProvider,
    ).toBe("host");
    expect(() =>
      loadConfig({ NODE_ENV: "production", VERIFICATION_PROVIDER: "host" }),
    ).toThrow("Host verification is not allowed in production");
  });
});

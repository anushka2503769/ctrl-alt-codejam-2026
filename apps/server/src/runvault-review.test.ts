import { describe, expect, it } from "vitest";
import {
  buildBoundedTextDiff,
  MAX_REVIEW_DIFF_CHARS,
  validateReviewPath,
} from "./runvault-review.js";

describe("RunVault review helpers", () => {
  it.each([
    "../secret",
    "src/../secret",
    "/absolute",
    "src\\secret",
    ".",
    "",
  ])("rejects unsafe review path %j", (candidate) => {
    expect(() => validateReviewPath(candidate)).toThrow("Invalid review path");
  });

  it("accepts normalized manifest paths", () => {
    expect(validateReviewPath("src/index.ts")).toBe("src/index.ts");
  });

  it("creates a bounded deterministic text diff", () => {
    expect(buildBoundedTextDiff("one\ntwo\n", "one\nthree\n")).toEqual({
      diff: "--- trusted\n+++ staged\n one\n+three\n-two\n ",
      truncated: false,
    });
    const large = buildBoundedTextDiff(
      `${"a".repeat(100)}\n`.repeat(400),
      `${"b".repeat(100)}\n`.repeat(400),
    );
    expect(large.truncated).toBe(true);
    expect(large.diff.length).toBeLessThanOrEqual(MAX_REVIEW_DIFF_CHARS + 25);
  });
});

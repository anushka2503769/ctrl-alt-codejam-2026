import path from "node:path";

export const MAX_REVIEW_FILE_BYTES = 64 * 1024;
export const MAX_REVIEW_FILE_LINES = 400;
export const MAX_REVIEW_DIFF_CHARS = 32 * 1024;

export function validateReviewPath(candidate: string): string {
  if (
    !candidate ||
    candidate.includes("\\") ||
    path.posix.isAbsolute(candidate) ||
    path.posix.normalize(candidate) !== candidate ||
    candidate === "." ||
    candidate.startsWith("../")
  ) {
    throw new Error("Invalid review path");
  }
  return candidate;
}

export function buildBoundedTextDiff(
  before: string,
  after: string,
): { diff: string; truncated: boolean } {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const lengths = Array.from({ length: beforeLines.length + 1 }, () =>
    new Uint16Array(afterLines.length + 1),
  );
  for (let left = beforeLines.length - 1; left >= 0; left -= 1) {
    for (let right = afterLines.length - 1; right >= 0; right -= 1) {
      lengths[left]![right] = beforeLines[left] === afterLines[right]
        ? lengths[left + 1]![right + 1]! + 1
        : Math.max(lengths[left + 1]![right]!, lengths[left]![right + 1]!);
    }
  }

  const output = ["--- trusted", "+++ staged"];
  let left = 0;
  let right = 0;
  while (left < beforeLines.length || right < afterLines.length) {
    if (beforeLines[left] === afterLines[right]) {
      output.push(` ${beforeLines[left] ?? ""}`);
      left += 1;
      right += 1;
    } else if (
      right < afterLines.length &&
      (left >= beforeLines.length ||
        lengths[left]![right + 1]! >= lengths[left + 1]![right]!)
    ) {
      output.push(`+${afterLines[right] ?? ""}`);
      right += 1;
    } else {
      output.push(`-${beforeLines[left] ?? ""}`);
      left += 1;
    }
  }
  const complete = output.join("\n");
  if (complete.length <= MAX_REVIEW_DIFF_CHARS) {
    return { diff: complete, truncated: false };
  }
  return {
    diff: `${complete.slice(0, MAX_REVIEW_DIFF_CHARS)}\n… diff truncated …`,
    truncated: true,
  };
}

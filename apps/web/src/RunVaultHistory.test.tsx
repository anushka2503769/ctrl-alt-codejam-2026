import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RunVaultHistory } from "./RunVaultHistory";

describe("RunVault history workspace", () => {
  it("renders all operator filters and the audit limitation", () => {
    const html = renderToStaticMarkup(
      <RunVaultHistory
        agents={[{
          id: "agent-1",
          name: "Builder",
          description: "Builds things",
          instructions: "",
          status: "ready",
          workspacePath: "/private/workspace",
          codexThreadId: null,
          lastError: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }]}
        onOpenRun={vi.fn()}
      />,
    );

    expect(html).toContain("RunVault history");
    expect(html).toContain("All Agents");
    expect(html).toContain("All outcomes");
    expect(html).toContain("All findings");
    expect(html).toContain("All verification");
    expect(html).toContain("Lineage Run ID");
    expect(html).toContain("Exports exclude prompts, outputs, errors");
    expect(html).toContain("single-process JSON audit aid");
    expect(html).toContain("not a tamper-proof or multi-user audit log");
    expect(html).not.toContain("/private/workspace");
  });
});

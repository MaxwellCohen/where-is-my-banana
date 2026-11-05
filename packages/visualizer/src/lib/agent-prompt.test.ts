import { describe, expect, it } from "vitest";
import { buildAgentPrompt } from "./agent-prompt";

describe("buildAgentPrompt", () => {
  it("embeds the URL without a trailing slash and key commands", () => {
    const p = buildAgentPrompt("https://example.com/");
    expect(p).toContain("opens https://example.com");
    expect(p).toContain("wimb speed");
    expect(p).toContain(".wimb/plan.md");
    expect(p).toContain("wimb open");
  });
});

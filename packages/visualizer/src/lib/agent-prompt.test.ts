import { describe, expect, it } from "vitest";
import { buildAgentPrompt } from "./agent-prompt";

describe("buildAgentPrompt", () => {
  it("embeds the URL without a trailing slash and key commands", () => {
    const p = buildAgentPrompt("https://example.com/");
    expect(p).toContain("- URL: https://example.com\n");
    expect(p).toContain("viz build");
    expect(p).toContain("wins --analyze-export");
  });
});

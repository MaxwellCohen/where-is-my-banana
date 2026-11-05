import { describe, expect, it } from "vitest";
import { HEAVY } from "../../src/audit/deps.js";

describe("HEAVY markdown stack", () => {
  it("flags unified/remark/rehype/mdast/hast/markdown libs with pre-check advice", () => {
    for (const n of ["unified", "remark-parse", "rehype-stringify", "micromark", "mdast-util-from-markdown", "hast-util-to-html", "react-markdown", "markdown-it", "marked", "showdown", "commonmark", "@mdx-js/mdx"]) {
      const h = HEAVY.find((x) => x.re.test(n));
      expect(h, n).toBeDefined();
      expect(h!.fix).toContain("pre-check");
    }
    expect(HEAVY.find((x) => x.re.test("remarkable-lite-not"))).toBeUndefined();
  });
});

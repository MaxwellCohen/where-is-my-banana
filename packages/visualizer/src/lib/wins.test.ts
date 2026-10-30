import { describe, expect, it } from "vitest";
import { editPrompt, pathsMatch, normalizePath, parseWinsReport, safeSavings } from "./wins";

const win = (over: Record<string, unknown> = {}) => ({
  id: "w1",
  fixKind: "lazy",
  safety: "safe",
  safetyReasons: [],
  usage: "x",
  edge: { importer: "a.ts", imported: "b.ts", packageName: null },
  routes: { "/": 100 },
  totalSavedBytes: 100,
  byteSource: "measured",
  chain: ["a.ts", "b.ts"],
  edit: { summary: "s", steps: ["one"], verify: "v" },
  ...over,
});
const report = (wins: unknown[]) => ({ version: "2", routes: [{ route: "/", firstLoadBytes: 5 }, { route: 1 }], wins });

describe("parseWinsReport", () => {
  it("keeps valid wins and drops malformed ones", () => {
    const r = parseWinsReport(
      report([
        win(),
        win({ id: "bad1", edit: { summary: "s", steps: "no", verify: "v" } }),
        win({ id: "bad2", edge: null }),
        win({ id: "bad3", chain: [1] }),
        win({ id: "bad4", fixKind: "nope" }),
        win({ id: "bad5", routes: { "/": "x" } }),
        null,
      ]),
    );
    expect(r.wins.map((w) => w.id)).toEqual(["w1"]);
    expect(r.routes).toHaveLength(1);
  });
  it("rejects wrong envelope", () => {
    expect(() => parseWinsReport({ wins: [] })).toThrow(/WinsReport/);
    expect(() => parseWinsReport(null)).toThrow(/WinsReport/);
  });
});

describe("helpers", () => {
  it("normalizes and matches paths", () => {
    expect(normalizePath("./src\\a.ts?x#y")).toBe("src/a.ts");
    expect(pathsMatch("/app/src/a.ts", "src/a.ts")).toBe(true);
    expect(pathsMatch("", "a")).toBe(false);
  });
  it("sums safe savings and builds prompt", () => {
    const r = parseWinsReport(report([win(), win({ id: "w2", safety: "needs-review" })]));
    expect(safeSavings(r, "/")).toBe(100);
    expect(editPrompt(r.wins[0])).toContain("1. one");
  });
});

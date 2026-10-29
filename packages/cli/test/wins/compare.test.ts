import { describe, expect, it } from "vitest";
import { checkBudget, compareWins } from "../../src/wins/compare.js";
import type { Win, WinsReport } from "../../src/wins/types.js";

function win(id: string, bytes: number, safety: Win["safety"] = "safe"): Win {
  return {
    id,
    fixKind: "lazy",
    safety,
    safetyReasons: [],
    usage: "unknown",
    edge: { importer: "a.tsx", imported: id, packageName: null },
    routes: { "/": bytes },
    totalSavedBytes: bytes,
    byteSource: "measured",
    chain: ["a.tsx", id],
    edit: { summary: "s", steps: [], verify: "v" },
  };
}
const rep = (first: number, wins: Win[]): WinsReport => ({
  version: "2",
  timestamp: "t",
  projectRoot: "/p",
  byteSource: "measured",
  routes: [{ route: "/", firstLoadBytes: first }],
  wins,
});

describe("compareWins", () => {
  it("computes deltas and resolved/new wins", () => {
    const c = compareWins(rep(1000, [win("x", 10), win("y", 5)]), rep(800, [win("y", 5), win("z", 3)]));
    expect(c.routes[0].delta).toBe(-200);
    expect(c.resolved.map((w) => w.id)).toEqual(["x"]);
    expect(c.introduced.map((w) => w.id)).toEqual(["z"]);
  });
});

describe("checkBudget", () => {
  it("flags route budget and safe wins", () => {
    const r = rep(1000, [win("x", 600), win("y", 500, "needs-review")]);
    expect(checkBudget(r, { routeBudgetBytes: 900 })).toHaveLength(1);
    expect(checkBudget(r, { maxSafeWinBytes: 500 })).toHaveLength(1);
    expect(checkBudget(r, { maxSafeWinBytes: 600, routeBudgetBytes: 1000 })).toHaveLength(0);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFailedPreviously, applyRevert, failedWinIds, judge, planRevert, recordVerify, snapshotFileState } from "../../src/wins/verify.js";
import type { Win, WinsReport } from "../../src/wins/types.js";

const win = (id: string, importer: string, routes: Record<string, number>): Win =>
  ({ id, fixKind: "lazy", safety: "safe", safetyReasons: [], usage: "conditional-render", edge: { importer, imported: "x", packageName: null }, routes, totalSavedBytes: 5000, byteSource: "measured", chain: [], edit: { summary: "", steps: [], verify: "" }, predictedSavedBytes: 5000 }) as Win;
const rep = (first: Record<string, number>, wins: Win[] = []): WinsReport => ({
  version: "2", timestamp: "", projectRoot: "/", byteSource: "measured", wins,
  routes: Object.entries(first).map(([route, firstLoadBytes]) => ({ route, firstLoadBytes })),
});

describe("judge", () => {
  const w = win("lazy:a:b", "a.tsx", { "/": 5000 });
  it("kept when target route drops beyond tolerance", () => {
    expect(judge(rep({ "/": 100000 }), rep({ "/": 95000 }), { tolerance: 200, win: w }).status).toBe("kept");
  });
  it("failed when any route rises beyond tolerance, ignores noise below it", () => {
    expect(judge(rep({ "/": 100000, "/b": 5 }), rep({ "/": 90000, "/b": 5 + 15000 }), { tolerance: 200, win: w }).status).toBe("failed");
    expect(judge(rep({ "/": 100000 }), rep({ "/": 100150 }), { tolerance: 200 }).status).toBe("neutral");
  });
  it("failed when the win's route does not improve", () => {
    const v = judge(rep({ "/": 100000 }), rep({ "/": 99900 }), { tolerance: 200, win: w });
    expect(v.status).toBe("failed");
    expect(v.reason).toContain("no first-load improvement");
  });
});

describe("failed-previously", () => {
  it("demotes wins recorded as failed", () => {
    const root = mkdtempSync(join(tmpdir(), "wimb-vf-"));
    try {
      recordVerify(root, { winId: "lazy:a:b", status: "failed", deltas: [], reason: "r", timestamp: "t" });
      recordVerify(root, { winId: "lazy:c:d", status: "kept", deltas: [], reason: "r", timestamp: "t" });
      expect([...failedWinIds(root)]).toEqual(["lazy:a:b"]);
      const wins = [win("lazy:a:b", "a.tsx", {}), win("lazy:c:d", "c.tsx", {})];
      applyFailedPreviously(wins, failedWinIds(root));
      expect(wins[0]).toMatchObject({ status: "failed-previously", safety: "needs-review", predictedSavedBytes: 0 });
      expect(wins[0].safetyReasons).toContain("failed-previously");
      expect(wins[1].status).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("revert", () => {
  let root: string;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "wimb-rev-"));
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "app/a.tsx"), "one\n");
    writeFileSync(join(root, "app/b.tsx"), "one\n");
    writeFileSync(join(root, "app/other.tsx"), "one\n");
    git("add", "."); git("commit", "-qm", "init");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("restores only the listed files; leaves others and refuses files dirty before the win", () => {
    writeFileSync(join(root, "app/b.tsx"), "pre-existing local edit\n"); // dirty before baseline
    snapshotFileState(root, rep({}, [win("w1", "app/a.tsx", {}), win("w2", "app/b.tsx", {})]));
    writeFileSync(join(root, "app/a.tsx"), "win edit\n");
    writeFileSync(join(root, "app/b.tsx"), "pre-existing local edit\nwin edit\n");
    writeFileSync(join(root, "app/other.tsx"), "unrelated edit\n");
    const plan = planRevert(root, ["app/a.tsx", "app/b.tsx"]);
    expect(plan.revert).toEqual(["app/a.tsx"]);
    expect(plan.refused.map((r) => r.file)).toEqual(["app/b.tsx"]);
    applyRevert(root, plan);
    expect(readFileSync(join(root, "app/a.tsx"), "utf-8")).toBe("one\n");
    expect(readFileSync(join(root, "app/b.tsx"), "utf-8")).toContain("win edit");
    expect(readFileSync(join(root, "app/other.tsx"), "utf-8")).toBe("unrelated edit\n");
    expect(planRevert(root, ["app/b.tsx"], true).revert).toEqual(["app/b.tsx"]);
  });

  it("refuses untracked files", () => {
    writeFileSync(join(root, "app/new.tsx"), "x");
    expect(planRevert(root, ["app/new.tsx"]).refused[0].why).toContain("not tracked");
  });
});

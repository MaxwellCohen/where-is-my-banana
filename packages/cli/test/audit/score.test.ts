import { describe, it, expect } from "vitest";
import { impactOf, effortOf, priority } from "../../src/audit/score.js";
import { doFirst } from "../../src/audit/output.js";
import type { Finding } from "../../src/audit/types.js";

const mk = (id: string, check: Finding["check"], severity: Finding["severity"], file = "app/a.tsx"): Finding => ({
  id, check, severity, file, line: 1, message: id, fix: "", impactScore: impactOf({ id, check, severity, file }), effort: effortOf({ id, check }),
});

describe("scoring", () => {
  it("scales with severity, boosts layouts, clamps to 0-100", () => {
    expect(impactOf({ id: "raw-img", check: "raw-img", severity: "high", file: "a.tsx" })).toBeGreaterThan(impactOf({ id: "raw-img", check: "raw-img", severity: "medium", file: "a.tsx" }));
    expect(impactOf({ id: "x", check: "third-party-script", severity: "high", file: "app/layout.tsx" })).toBeLessThanOrEqual(100);
    expect(impactOf({ id: "x", check: "raw-img", severity: "medium", file: "app/layout.tsx" })).toBeGreaterThan(impactOf({ id: "x", check: "raw-img", severity: "medium", file: "app/a.tsx" }));
  });
  it("assigns effort", () => {
    expect(effortOf({ id: "raw-img", check: "raw-img" })).toBe("S");
    expect(effortOf({ id: "heavy-deps/moment", check: "heavy-deps" })).toBe("L");
    expect(effortOf({ id: "force-dynamic/no-store", check: "force-dynamic" })).toBe("M");
  });
  it("ranks do-first by impact per effort", () => {
    const bigButHard = mk("heavy-deps/moment", "heavy-deps", "high", "package.json"); // 75 / L
    const smallEasy = mk("raw-img", "raw-img", "medium"); // 45 / S
    expect(priority(smallEasy)).toBeGreaterThan(priority(bigButHard));
    expect(doFirst([bigButHard, smallEasy])[0]).toBe(smallEasy);
  });
});

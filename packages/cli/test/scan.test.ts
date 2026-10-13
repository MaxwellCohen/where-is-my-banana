import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { scan } from "../src/scan.js";
import { readFileSync, existsSync } from "node:fs";
import { fixturePath } from "./helpers.js";

describe("e2e scan", () => {
  it("detects seeded violations in e2e fixture", async () => {
    const projectRoot = fixturePath("e2e-app");
    const code = await scan({ projectRoot, formats: ["json"] });
    expect(existsSync(join(projectRoot, ".wimb", "wimb-report.json"))).toBe(true);
    expect(existsSync(join(projectRoot, ".wimb", "forest.json"))).toBe(true);
    const report = JSON.parse(readFileSync(join(projectRoot, ".wimb", "wimb-report.json"), "utf-8"));
    const forest = JSON.parse(readFileSync(join(projectRoot, ".wimb", "forest.json"), "utf-8"));
    expect(forest.pages).toHaveLength(1);
    expect(forest.pages[0]?.route).toBe("/");
    expect(forest.entries["app/page.tsx"]).toBeDefined();
    const ruleIds = report.findings.map((f: { ruleId: string }) => f.ruleId);
    expect(ruleIds).toContain("server-logic-in-client");
    expect(ruleIds).toContain("barrel-import");
    expect(ruleIds).toContain("env-var-misuse");
    expect(ruleIds).toContain("heavy-client-import");
    expect(code).toBe(1);
  });

  it("rejects non-Next projects with exit code 2", async () => {
    const code = await scan({ projectRoot: fixturePath("not-next"), formats: ["json"] });
    expect(code).toBe(2);
  });
});

describe("use-client-unnecessary fixture", () => {
  it("flags unnecessary use client", async () => {
    const { runScanOnFixture } = await import("./helpers.js");
    const findings = await runScanOnFixture("use-client-unnecessary");
    expect(findings.some((f) => f.ruleId === "use-client-unnecessary")).toBe(true);
  });

  it("clean variant passes", async () => {
    const { runScanOnFixture } = await import("./helpers.js");
    const findings = await runScanOnFixture("use-client-unnecessary/clean");
    expect(findings.some((f) => f.ruleId === "use-client-unnecessary")).toBe(false);
  });
});

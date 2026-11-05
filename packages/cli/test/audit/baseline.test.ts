import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAudit, collectFindings } from "../../src/audit/index.js";
import { applyBaseline, fingerprint, makeBaseline, readBaseline, writeBaseline } from "../../src/audit/baseline.js";

function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "wimb-base-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}

describe("baseline", () => {
  it("fingerprint ignores line numbers and digits", () => {
    const a = { id: "x", file: "a.ts", message: "5 files, 1.5 KB" };
    expect(fingerprint(a)).toBe(fingerprint({ ...a, message: "7 files, 2.5 KB" }));
  });
  it("hides baselined findings, reports only new ones, tolerates line moves", () => {
    const root = project({ "app/a.tsx": `export const A = () => <img src="x" />;` });
    const { findings } = collectFindings({ projectRoot: root, checks: ["raw-img"] });
    const file = join(root, ".wimb", "b.json");
    writeBaseline(file, makeBaseline(findings));
    const baseline = readBaseline(file);
    expect(runAudit({ projectRoot: root, checks: ["raw-img"], baseline }).findings).toHaveLength(0);

    // same issue moves down a line: still baselined
    writeFileSync(join(root, "app/a.tsx"), `\n\nexport const A = () => <img src="x" />;`);
    expect(runAudit({ projectRoot: root, checks: ["raw-img"], baseline }).findings).toHaveLength(0);

    // a second occurrence in the same file and a new file are new
    writeFileSync(join(root, "app/a.tsx"), `export const A = () => <img src="x" />;\nexport const B = () => <img src="y" />;`);
    writeFileSync(join(root, "app/b.tsx"), `export const C = () => <img src="z" />;`);
    const r = runAudit({ projectRoot: root, checks: ["raw-img"], baseline });
    expect(r.findings).toHaveLength(2);
    expect(r.baselined).toBe(1);
    expect(r.summary.medium).toBe(2);
  });
  it("rejects malformed baseline files", () => {
    const root = project({ "bad.json": "{}" });
    expect(() => readBaseline(join(root, "bad.json"))).toThrow(/not a wimb audit baseline/);
    expect(() => readBaseline(join(root, "missing.json"))).toThrow(/cannot read baseline/);
  });
  it("applyBaseline is a multiset", () => {
    const f = { id: "raw-img", check: "raw-img", severity: "medium", file: "a", line: 1, message: "m", fix: "" } as const;
    const { fresh, baselined } = applyBaseline([f, f, f], makeBaseline([f, f]));
    expect([fresh.length, baselined]).toEqual([1, 2]);
  });
});

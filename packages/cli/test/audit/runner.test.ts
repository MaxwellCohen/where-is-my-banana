import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAudit } from "../../src/audit/index.js";
import { writeAudit, formatAuditMarkdown } from "../../src/audit/output.js";
import { FlagError, parseAuditChecks, parseFailOn, parseTop } from "../../src/index-flags.js";
import { run } from "./helpers.js";

function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "wimb-audit-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}

describe("runAudit", () => {
  it("walks the project, skips node_modules, writes json+md", () => {
    const root = project({
      "app/a.tsx": `export const A = () => <img src="x" />;`,
      "node_modules/x/b.tsx": `export const B = () => <img src="x" />;`,
    });
    const report = runAudit({ projectRoot: root, checks: ["raw-img"] });
    expect(report.findings).toHaveLength(1);
    expect(report.summary).toMatchObject({ medium: 1, byCheck: { "raw-img": 1 } });
    const { json, md } = writeAudit(root, report, 10);
    expect(existsSync(json)).toBe(true);
    const text = readFileSync(md, "utf-8");
    expect(text).toContain("Do these first");
    expect(text).toContain("wimb scan");
    expect(text).toContain("app/a.tsx:1");
  });
  it("honors config ignores", () => {
    const root = project({ "app/a.tsx": `export const A = () => <img src="x" />;` });
    expect(runAudit({ projectRoot: root, checks: ["raw-img"], ignoreRules: ["raw-img"] }).findings).toHaveLength(0);
  });
  it("honors wimb-ignore-next-line", () => {
    const c = `// wimb-ignore-next-line raw-img\nexport const A = () => <img src="x" />;\nexport const B = () => <img src="y" />;`;
    const f = run("raw-img", { "app/a.tsx": c });
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(3);
  });
  it("caps findings per check in markdown", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`app/f${i}.tsx`] = `const a = <img src="x" />;`;
    const root = project(files);
    const md = formatAuditMarkdown(runAudit({ projectRoot: root, checks: ["raw-img"] }), 2);
    expect(md).toContain("and 3 more");
  });
});

describe("flag parsing", () => {
  it("validates --checks, --fail-on, --top", () => {
    expect(parseAuditChecks("raw-img,fonts")).toEqual(["raw-img", "fonts"]);
    expect(() => parseAuditChecks("nope")).toThrow(FlagError);
    expect(parseFailOn("high")).toBe("high");
    expect(() => parseFailOn("low")).toThrow(FlagError);
    expect(parseTop(undefined, 10)).toBe(10);
    expect(() => parseTop("0", 10)).toThrow(FlagError);
    expect(() => parseTop("abc", 10)).toThrow(FlagError);
  });
});

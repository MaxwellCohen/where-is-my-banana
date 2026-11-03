import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { classifyWins } from "../../src/wins/classify.js";
import { findGuardCandidate } from "../../src/wins/usage-analyze.js";
import { clearTestImpactCache } from "../../src/wins/test-impact.js";
import type { RouteAttribution } from "../../src/wins/types.js";

let root: string;
const write = (rel: string, src: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), src);
};
const att = (importer: string, imported: string, pkg: string | null, bytes = 40000): RouteAttribution[] => [
  { route: "/", firstLoadBytes: 200000, measured: true, edges: [{ edge: { importer, imported, packageName: pkg }, chain: [importer, imported], uniqueBytes: bytes, subtreeBytes: bytes }] },
];
const MARKED = { importer: "lib/render.ts", imported: "node_modules/marked/lib/marked.esm.js", packageName: "marked" };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "wimb-guard-"));
  write("package.json", JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "1" } }));
  write("lib/render.ts", `import { marked } from "marked";\nexport function renderBody(text: string) {\n  return marked.parse(text);\n}\n`);
  write("lib/component.tsx", `import { marked } from "marked";\nexport function Body({ text }: { text: string }) { return <div dangerouslySetInnerHTML={{ __html: marked.parse(text) }} />; }\n`);
  write("lib/toplevel.ts", `import { marked } from "marked";\nexport const html = marked.parse("# hi");\n`);
  write("components/Chart.tsx", `export default function Chart(){ return <div/>; }\n`);
  write("app/cond.tsx", `import Chart from "../components/Chart";\nexport default function P({open}:{open:boolean}){ return <main>{open && <Chart />}</main>; }\n`);
  write("app/cond.test.tsx", `import { render, screen } from "@testing-library/react";\nimport P from "./cond";\nvi.useFakeTimers();\nit("x", () => { render(<P open />); expect(screen.getByText("a")).toBeTruthy(); expect(1).toMatchSnapshot(); });\n`);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("findGuardCandidate", () => {
  it("finds a call inside a plain function", () => {
    const c = findGuardCandidate("lib/render.ts", `import { marked } from "marked";\nexport function renderBody(text: string) {\n  return marked.parse(text);\n}\n`, MARKED_EDGE());
    expect(c).toMatchObject({ calleeSrc: "marked.parse", argSrc: "text", fnName: "renderBody", loc: { line: 3 } });
  });
  it("rejects components and module-level calls", () => {
    expect(findGuardCandidate("lib/component.tsx", `import { marked } from "marked";\nexport function Body({ text }) { return <div>{marked.parse(text)}</div>; }\n`, MARKED_EDGE())).toBeNull();
    expect(findGuardCandidate("lib/toplevel.ts", `import { marked } from "marked";\nexport const html = marked.parse("x");\n`, MARKED_EDGE())).toBeNull();
  });
});
function MARKED_EDGE() {
  return MARKED;
}

describe("guard-heavy wins", () => {
  it("generates a concrete pre-check edit, needs-review with behavior-change", async () => {
    const [w] = await classifyWins(att(MARKED.importer, MARKED.imported, "marked"), { projectRoot: root, byteSource: "measured", framework: "next" });
    expect(w!.fixKind).toBe("guard-heavy");
    expect(w!.safety).toBe("needs-review");
    expect(w!.safetyReasons).toContain("behavior-change");
    expect(w!.edit.replacementImport).toContain("MARKDOWN_HINT.test(text) ? (await import('marked')).marked.parse(text) : escapeHtml(text)");
    expect(w!.edit.steps.join(" ")).toContain("Verify output equality on sample inputs");
    expect(w!.loc?.line).toBe(1);
  });
  it("does not apply to render-time component usage", async () => {
    const [w] = await classifyWins(att("lib/component.tsx", MARKED.imported, "marked"), { projectRoot: root, byteSource: "measured", framework: "next" });
    expect(w?.fixKind).not.toBe("guard-heavy");
  });
});

describe("test impact on lazy wins", () => {
  it("attaches tests, warnings and a test run in verify", async () => {
    clearTestImpactCache();
    const [w] = await classifyWins(att("app/cond.tsx", "components/Chart.tsx", null), { projectRoot: root, byteSource: "measured", framework: "next" });
    expect(w!.fixKind).toBe("lazy");
    expect(w!.testImpact?.files).toEqual(["app/cond.test.tsx"]);
    expect(w!.testImpact?.warnings.join(" ")).toMatch(/findBy|waitFor/);
    expect(w!.testImpact?.warnings.join(" ")).toMatch(/fake timers|useFakeTimers|runAllTimersAsync/);
    expect(w!.testImpact?.warnings.join(" ")).toMatch(/snapshot/i);
    expect(w!.edit.steps.join("\n")).toContain("Update/run these tests: app/cond.test.tsx");
    expect(w!.edit.verify).toContain("vitest run app/cond.test.tsx");
  });
});

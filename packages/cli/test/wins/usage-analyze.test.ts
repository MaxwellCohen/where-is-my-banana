import { describe, expect, it } from "vitest";
import { analyzeImportUsage, moduleFacts } from "../../src/wins/usage-analyze.js";

const edge = { importer: "app/page.tsx", imported: "components/Chart.tsx", packageName: null };
const imp = `import Chart from "../components/Chart";\n`;

describe("analyzeImportUsage", () => {
  it("unused binding", () => {
    const u = analyzeImportUsage("app/page.tsx", imp + "export default function P(){ return null }", edge);
    expect(u.found).toBe(true);
    expect(u.unused).toBe(true);
  });

  it("always-rendered", () => {
    const u = analyzeImportUsage("app/page.tsx", imp + "export default function P(){ return <Chart/> }", edge);
    expect(u.usage).toBe("always-rendered");
    expect(u.isPageOrLayout).toBe(true);
  });

  it("conditional render", () => {
    const u = analyzeImportUsage(
      "app/page.tsx",
      imp + "export default function P({s}){ return <div>{s && <Chart/>}</div> }",
      edge,
    );
    expect(u.usage).toBe("conditional-render");
  });

  it("event-handler only", () => {
    const u = analyzeImportUsage(
      "app/page.tsx",
      `import x from "../components/Chart";\nexport default function P(){ return <button onClick={() => x()}/> }`,
      edge,
    );
    expect(u.usage).toBe("event-handler-only");
  });

  it("type-only import and missing import", () => {
    const t = analyzeImportUsage("app/page.tsx", `import type Chart from "../components/Chart";\n`, edge);
    expect(t.typeOnly).toBe(true);
    const n = analyzeImportUsage("app/page.tsx", `import y from "other";\n`, edge);
    expect(n.found).toBe(false);
  });

  it("unparseable source falls back to empty", () => {
    expect(analyzeImportUsage("app/page.tsx", "import {{{", edge).found).toBe(false);
  });
});

describe("moduleFacts", () => {
  it("detects default export and use client", () => {
    const f = moduleFacts("a.tsx", `"use client";\nexport default function A(){ return null }`);
    expect(f.hasDefault).toBe(true);
    expect(f.isClient).toBe(true);
    expect(moduleFacts("b.ts", "export const b = 1").hasDefault).toBe(false);
  });
});

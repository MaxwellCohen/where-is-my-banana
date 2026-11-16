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

  it("|| with negated operand is always-rendered", () => {
    const u = analyzeImportUsage("app/page.tsx", imp + "export default function P({m,o}){ return <div>{m === \"a\" || !o ? <Chart/> : null}</div> }", edge);
    expect(u.usage).toBe("always-rendered");
  });

  it("?? with negated operand is always-rendered", () => {
    const u = analyzeImportUsage("app/page.tsx", imp + "export default function P({m,o}){ return <div>{m ?? !o ? <Chart/> : null}</div> }", edge);
    expect(u.usage).toBe("always-rendered");
  });

  it("|| of comparisons stays conditional", () => {
    const u = analyzeImportUsage("app/page.tsx", imp + "export default function P({t}){ return <div>{t === \"a\" || t === \"b\" ? <Chart/> : null}</div> }", edge);
    expect(u.usage).toBe("conditional-render");
  });

  it("&& guard around || stays conditional", () => {
    const u = analyzeImportUsage("app/page.tsx", imp + "export default function P({m,o,open}){ return <div>{open && (m || !o) ? <Chart/> : null}</div> }", edge);
    expect(u.usage).toBe("conditional-render");
  });

  it("!(a || b) stays conditional", () => {
    const u = analyzeImportUsage("app/page.tsx", imp + "export default function P({a,b}){ return <div>{!(a || b) ? <Chart/> : null}</div> }", edge);
    expect(u.usage).toBe("conditional-render");
  });

  it("plain ternary stays conditional", () => {
    const u = analyzeImportUsage("app/page.tsx", imp + "export default function P({s}){ return <div>{s ? <Chart/> : null}</div> }", edge);
    expect(u.usage).toBe("conditional-render");
  });

  it("(a || !o) && X is always-rendered", () => {
    const u = analyzeImportUsage("app/page.tsx", imp + "export default function P({a,o}){ return <div>{(a || !o) && <Chart/>}</div> }", edge);
    expect(u.usage).toBe("always-rendered");
  });

  it("if (a || !o) return X is always-rendered", () => {
    const u = analyzeImportUsage("app/page.tsx", imp + "export default function P({a,o}){ if (a || !o) { return <Chart/> } return null }", edge);
    expect(u.usage).toBe("always-rendered");
  });

  it("|| ternary inside a real guard stays conditional", () => {
    const u = analyzeImportUsage("app/page.tsx", imp + "export default function P({a,o,ready}){ return <div>{ready && (a || !o ? <Chart/> : null)}</div> }", edge);
    expect(u.usage).toBe("conditional-render");
  });

  it("ternary else branch is conditional", () => {
    const u = analyzeImportUsage("app/page.tsx", imp + "export default function P({a,o}){ return <div>{(a || !o) ? null : <Chart/>}</div> }", edge);
    expect(u.usage).toBe("conditional-render");
  });

  it("if/else branch is conditional", () => {
    const u = analyzeImportUsage("app/page.tsx", imp + "export default function P({a,o}){ if (a || !o) { return null } else { return <Chart/> } }", edge);
    expect(u.usage).toBe("conditional-render");
  });

  it("!a && !b stays conditional", () => {
    const u = analyzeImportUsage("app/page.tsx", imp + "export default function P({a,b}){ return <div>{!a && !b ? <Chart/> : null}</div> }", edge);
    expect(u.usage).toBe("conditional-render");
  });

  it("!a && !b && X stays conditional", () => {
    const u = analyzeImportUsage("app/page.tsx", imp + "export default function P({a,b}){ return <div>{!a && !b && <Chart/>}</div> }", edge);
    expect(u.usage).toBe("conditional-render");
  });

  it("!!x inside || stays conditional", () => {
    const u = analyzeImportUsage("app/page.tsx", imp + "export default function P({a,o}){ return <div>{a === 1 || !!o ? <Chart/> : null}</div> }", edge);
    expect(u.usage).toBe("conditional-render");
  });

  it("&& of negations under || stays conditional", () => {
    const u = analyzeImportUsage("app/page.tsx", imp + "export default function P({x,a,b}){ return <div>{x || (!a && !b) ? <Chart/> : null}</div> }", edge);
    expect(u.usage).toBe("conditional-render");
  });

  it("TS as-wrapped || guard is always-rendered", () => {
    const u = analyzeImportUsage("app/page.tsx", imp + "export default function P({a,o}){ return <div>{(a || !o) as boolean ? <Chart/> : null}</div> }", edge);
    expect(u.usage).toBe("always-rendered");
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

  describe("several import statements from one package", () => {
    const rx = { importer: "components/Rx.tsx", imported: "node_modules/rxjs/dist/esm5/internal/observable/of.js", packageName: "rxjs" };
    const src = `import type { Observable } from "rxjs";
import { of } from "rxjs";
import { map } from "rxjs/operators";
export default function Rx(){ return <button onClick={() => of(1).pipe(map((x) => x + 1))}/> }`;

    it("a single-edge cut reads the first value import, not an earlier type-only one", () => {
      const u = analyzeImportUsage("components/Rx.tsx", src, rx);
      expect(u.typeOnly).toBe(false);
      expect(u.bindings).toEqual([{ local: "of", kind: "named", imported: "of" }]);
      expect(u.originalImport).toBe(`import { of } from "rxjs";`);
      expect(u.importCount).toBe(1);
    });

    it("a grouped cut covers every value import, each binding with its own specifier", () => {
      const u = analyzeImportUsage("components/Rx.tsx", src, rx, { all: true });
      expect(u.specifier).toBe("rxjs");
      expect(u.bindings).toEqual([
        { local: "of", kind: "named", imported: "of" },
        { local: "map", kind: "named", imported: "map", specifier: "rxjs/operators" },
      ]);
      expect(u.originalImport).toBe(`import { of } from "rxjs";\nimport { map } from "rxjs/operators";`);
      expect(u.importCount).toBe(2);
      expect(u.importLoc).toEqual({ line: 2, column: 1 });
      expect(u.usage).toBe("event-handler-only");
    });

    it("a grouped cut takes the least deferrable use across the statements", () => {
      const rendered = src.replace("<button onClick={() => of(1).pipe(map((x) => x + 1))}/>", "<button onClick={() => of(1)}>{map.name}</button>");
      expect(analyzeImportUsage("components/Rx.tsx", rendered, rx, { all: true }).usage).toBe("always-rendered");
      expect(analyzeImportUsage("components/Rx.tsx", rendered, rx).usage).toBe("event-handler-only");
    });
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

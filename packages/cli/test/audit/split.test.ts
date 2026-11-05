import { describe, it, expect } from "vitest";
import { auditContext, buildContext } from "../../src/audit/index.js";
import type { SplitThresholds } from "../../src/audit/types.js";
import { analyzeSource } from "../../src/audit/split.js";

const pad = (n: number) => Array.from({ length: n }, (_, i) => `    <i>{${i}}</i>`).join("\n");
const comp = (name: string, body = "", lines = 30, extra = "") =>
  `${extra}export function ${name}() {\n${body}  return (\n    <div>\n${pad(lines)}\n    </div>\n  );\n}\n`;

function run(files: Record<string, string>, split: Partial<SplitThresholds> = {}, measured?: Record<string, number>, next = true) {
  const all = { ...files, ...(next ? { "package.json": JSON.stringify({ dependencies: { next: "15" } }) } : {}) };
  const ctx = buildContext(Object.entries(all).map(([path, content]) => ({ path, content })), { split, measured });
  return auditContext(ctx, ["split-candidate"]);
}

const TWO = (head: string, a = "", b = "") => `${head}\n${comp("A", a)}\n${comp("B", b)}`;

describe("split-candidate clustering", () => {
  it("finds disjoint clusters and reports names, LOC, imports and cohesion", () => {
    const src = TWO('"use client";\nimport { useState } from "react";\nimport { Chart } from "recharts";\nimport { Dialog } from "./Dialog";', "  const [x] = useState(0);\n  const c = <Chart/>;\n", "  const d = <Dialog/>;\n");
    const [f] = run({ "components/X.tsx": src }, { splitMinLoc: 50 });
    expect(f.id).toBe("split-candidate/heavy-cluster");
    expect(f.severity).toBe("high");
    const ev = f.evidence!;
    expect(ev.clusters.map((c) => c.name).sort()).toEqual(["A", "B"]);
    expect(ev.clusters.find((c) => c.name === "A")!.heavy).toEqual(["recharts"]);
    expect(ev.cohesion).toBeGreaterThan(0.4);
    expect(ev.cohesion).toBeLessThan(0.6);
    expect(f.fix).toContain("next/dynamic");
    expect(f.fix).toContain("never ssr:false");
    expect(f.fix).toContain("do not leave re-exports");
  });

  it("shared local state merges clusters", () => {
    const src = `"use client";\nimport { useState } from "react";\nconst shared = { n: 1 };\n${comp("A", "  shared.n++;\n")}\n${comp("B", "  shared.n--;\n")}`;
    expect(run({ "components/X.tsx": src }, { splitMinLoc: 10 })).toEqual([]);
  });

  it("transitive local helper deps merge clusters", () => {
    const src = `function h1() { return h2(); }\nfunction h2() { return 1; }\n${comp("A", "  h1();\n")}\n${comp("B", "  h2();\n")}`;
    expect(run({ "components/X.tsx": src }, { splitMinLoc: 10 })).toEqual([]);
  });

  it("a stateless composer stays as the shell and does not glue clusters", () => {
    const src = `${comp("A")}\n${comp("B")}\nexport default function Page() {\n  return (\n    <main>\n      <A />\n      <B />\n    </main>\n  );\n}\n`;
    const [f] = run({ "components/X.tsx": src }, { splitMinLoc: 10 });
    expect(f.id).toBe("split-candidate/low-cohesion");
    expect(f.fix).toContain("thin composer");
  });

  it("a stateful hub keeps its children in one cluster", () => {
    const src = `import { useState } from "react";\n${comp("A")}\n${comp("B")}\nexport default function Page() {\n  const [s] = useState(0);\n  return (\n    <main>\n      <A />\n      <B />\n    </main>\n  );\n}\n`;
    expect(run({ "components/X.tsx": src }, { splitMinLoc: 10 })).toEqual([]);
  });

  it("ignores type-only imports and type references for linking and heaviness", () => {
    const src = `import type { Chart } from "recharts";\nimport { type Foo } from "recharts";\ntype T = { c: Chart };\n${comp("A", "  const t: T | undefined = undefined;\n")}\n${comp("B", "  const t: T | undefined = undefined;\n")}`;
    const [f] = run({ "components/X.tsx": src }, { splitMinLoc: 10 });
    expect(f.id).toBe("split-candidate/low-cohesion");
    expect(f.evidence!.uniqueHeavy).toEqual([]);
    expect(f.evidence!.packages).toBe(0);
  });

  it("respects threshold overrides", () => {
    const src = TWO("");
    expect(run({ "components/X.tsx": src })).toEqual([]); // ~80 LOC < 250
    expect(run({ "components/X.tsx": src }, { splitMinLoc: 60 })).toHaveLength(1);
    expect(run({ "components/X.tsx": src }, { splitMinLoc: 60, splitMinClusterLoc: 500 })).toEqual([]);
  });

  it("is low severity when the file is not client-reachable", () => {
    const [f] = run({ "lib/x.tsx": TWO("") }, { splitMinLoc: 60 });
    expect(f.severity).toBe("low");
  });

  it("uses measured bytes to flag a package as heavy and report KB", () => {
    const src = TWO('"use client";\nimport { a } from "mystery-lib";', "  a();\n");
    expect(run({ "components/X.tsx": src }, { splitMinLoc: 60 })[0].id).toBe("split-candidate/low-cohesion");
    const [f] = run({ "components/X.tsx": src }, { splitMinLoc: 60 }, { "mystery-lib": 120 * 1024 });
    expect(f.id).toBe("split-candidate/heavy-cluster");
    expect(f.evidence!.measuredKB).toBe(120);
    expect(f.message).toContain("~120 KB");
  });

  it("flags oversize coupled files only as low god-file", () => {
    const src = `function h() { return 1; }\n${comp("A", "  h();\n")}\n${comp("B", "  h();\n")}`;
    const [f] = run({ "components/X.tsx": src }, { splitGodFileLoc: 50 });
    expect(f.id).toBe("split-candidate/god-file");
    expect(f.severity).toBe("low");
  });

  it("skips tests, stories, d.ts and generated files", () => {
    const src = TWO("");
    const files = { "a/X.test.tsx": src, "a/X.stories.tsx": src, "a/x.d.ts": src, "a/generated/X.tsx": src, "a/Y.tsx": `// @generated\n${src}` };
    expect(run(files, { splitMinLoc: 10 })).toEqual([]);
  });
});

describe("split-candidate server-eligible", () => {
  it("detects a client file whose static part could be a Server Component", () => {
    const src = `"use client";\nimport { useState } from "react";\n${comp("Static", "", 90)}\nexport function Toggle() {\n  const [o, setO] = useState(false);\n  return <button onClick={() => setO(!o)}>{String(o)}</button>;\n}\n`;
    const f = run({ "components/X.tsx": src }, {}).find((x) => x.id === "split-candidate/server-eligible")!;
    expect(f).toBeTruthy();
    expect(f.fix).toContain('delete `"use client"`');
    expect(f.fix).toContain("Toggle");
    expect(f.evidence!.serverEligibleLoc).toBeGreaterThanOrEqual(90);
  });

  it("does not flag static parts rendered by interactive code or using client-only libs", () => {
    const pinned = `"use client";\nimport { useState } from "react";\n${comp("Static", "", 90)}\nexport function Toggle() {\n  const [o] = useState(false);\n  return <Static />;\n}\n`;
    expect(run({ "components/X.tsx": pinned })).toEqual([]);
    const lib = `"use client";\nimport { motion } from "framer-motion";\n${comp("Static", "  const m = <motion.div/>;\n", 90)}\n`;
    expect(run({ "components/X.tsx": lib }).filter((x) => x.id.endsWith("server-eligible"))).toEqual([]);
  });
});

describe("split-candidate registry", () => {
  it("flags files importing many components only to put them in a map", () => {
    const names = Array.from({ length: 9 }, (_, i) => `C${i}`);
    const src = `${names.map((n) => `import ${n} from "./${n}";`).join("\n")}\nexport const registry = {\n${names.map((n) => `  ${n.toLowerCase()}: ${n},`).join("\n")}\n};\n${"// pad\n".repeat(20)}`;
    const f = run({ "components/registry.tsx": src, "components/Page.tsx": '"use client";\nimport { registry } from "./registry";\n' + "// pad\n".repeat(30) })[0];
    expect(f.id).toBe("split-candidate/registry");
    expect(f.severity).toBe("medium");
    expect(f.fix).toContain("never ssr:false");
  });
});

describe("analyzeSource", () => {
  it("counts hooks, exports, jsx and imports", () => {
    const a = analyzeSource("x.tsx", `"use client";\nimport { useState } from "react";\nimport a, { b } from "lodash";\nexport default function X() { const [s] = useState(0); return <p>{s}</p>; }\nexport const K = 1;\n`)!;
    expect(a.client).toBe(true);
    expect(a.hooks).toBe(1);
    expect(a.jsx).toBe(1);
    expect(a.exports).toBe(2);
    expect(a.importCount).toBe(2);
    expect(a.packages.sort()).toEqual(["lodash", "react"]);
  });
});

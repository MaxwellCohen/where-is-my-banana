import { describe, it, expect } from "vitest";
import { useClientTooHigh } from "../../src/rules/boundary/use-client-too-high.js";
import { missingDynamicImport } from "../../src/rules/loading/missing-dynamic-import.js";
import { imp, mod, run, ROOT } from "./synthetic.js";

const page = `${ROOT}/app/page.tsx`;
const a = `${ROOT}/app/a.tsx`;
const b = `${ROOT}/app/b.tsx`;
const c = `${ROOT}/app/c.tsx`;
const loc = { line: 1, column: 1 };

describe("use-client-too-high", () => {
  const build = (pageBytes: number) => [
    mod(page, {
      isBoundary: true,
      subtreeBytes: pageBytes,
      imports: [imp("./a", { resolvedPath: a }), imp("./b", { resolvedPath: b }), imp("./c", { resolvedPath: c })],
    }),
    mod(a),
    mod(b),
    mod(c),
  ];

  it("flags a page boundary whose subtree has few client signals", () => {
    const f = run(useClientTooHigh, build(5000));
    expect(f).toHaveLength(1);
    expect(f[0]!.ruleId).toBe("use-client-too-high");
  });

  it("skips tiny page subtrees", () => {
    expect(run(useClientTooHigh, build(500))).toHaveLength(0);
  });

  it("skips when most of the subtree has client signals", () => {
    const mods = build(5000);
    for (const m of mods) m.signals.hooks.push(loc);
    expect(run(useClientTooHigh, mods)).toHaveLength(0);
  });

  it("ignores dynamically imported children", () => {
    const mods = build(5000);
    mods[0]!.imports = [imp("./a", { resolvedPath: a, isDynamic: true })];
    mods[1]!.signals.hooks.push(loc);
    const f = run(useClientTooHigh, mods);
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence.signalModules).toEqual([]);
  });
});

describe("missing-dynamic-import", () => {
  const target = `${ROOT}/app/big.tsx`;
  const mods = (extra = {}) => [
    mod(page, { imports: [imp("./big", { resolvedPath: target, ...extra })] }),
    mod(target, { subtreeBytes: 100_000 }),
  ];

  it("flags large local import as warning at threshold and suggests next/dynamic", () => {
    const f = run(missingDynamicImport, mods(), { thresholds: { dynamicImportMinSubtree: 100_000 } });
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warning");
    expect(f[0]!.fixStrategy.steps.join(" ")).toContain("next/dynamic");
  });

  it("skips type-only imports", () => {
    expect(run(missingDynamicImport, mods({ isTypeOnly: true }))).toHaveLength(0);
  });

  it("uses React.lazy text on Vite", () => {
    const f = run(missingDynamicImport, mods(), { deps: { vite: "5" } });
    expect(f[0]!.fixStrategy.steps.join(" ")).toContain("React.lazy");
  });
});

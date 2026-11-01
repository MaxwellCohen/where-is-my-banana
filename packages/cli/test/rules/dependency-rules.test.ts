import { describe, it, expect } from "vitest";
import { transitiveHeavyDependency } from "../../src/rules/dependency/transitive-heavy-dependency.js";
import { barrelImport } from "../../src/rules/dependency/barrel-import.js";
import { replaceableDependency } from "../../src/rules/dependency/replaceable-dependency.js";
import { runtimeCssInJs } from "../../src/rules/dependency/runtime-css-in-js.js";
import { staticIconMap } from "../../src/rules/dependency/static-icon-map.js";
import { loadReplacements } from "../../src/external/module-replacements.js";
import { imp, mod, run, ROOT } from "./synthetic.js";

const page = `${ROOT}/app/page.tsx`;

describe("transitive-heavy-dependency", () => {
  const mid = `${ROOT}/node_modules/mid/index.js`;
  const mods = () => [
    mod(page, { imports: [imp("mid", { resolvedPath: mid }), imp("heavy-lib")] }),
    mod(mid, {
      imports: [imp("heavy-lib")],
      importChainFromEntry: [page, mid],
    }),
  ];

  it("skips packages imported directly by project source", () => {
    expect(run(transitiveHeavyDependency, mods(), { installSizes: { "heavy-lib": 9_999_999 } })).toHaveLength(0);
  });

  it("reports chain and via for purely transitive imports", () => {
    const m = mods();
    m[0]!.imports = [imp("mid", { resolvedPath: mid })];
    const f = run(transitiveHeavyDependency, m, { installSizes: { "heavy-lib": 9_999_999 } });
    expect(f).toHaveLength(1);
    expect((f[0]!.evidence.chain as string[]).length).toBe(2);
    expect(f[0]!.evidence.via).toBe("node_modules/mid/index.js");
    expect(f[0]!.file).toBe("app/page.tsx");
  });

  it("prefers reachable importers over unreachable ones", () => {
    const orphan = `${ROOT}/node_modules/a-orphan/index.js`;
    const m = [
      mod(page, { imports: [imp("mid", { resolvedPath: mid })] }),
      mod(mid, { imports: [imp("heavy-lib")], importChainFromEntry: [page, mid] }),
      mod(orphan, { imports: [imp("heavy-lib")], importChainFromEntry: [] }),
    ];
    const f = run(transitiveHeavyDependency, m, { installSizes: { "heavy-lib": 9_999_999 } });
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence.via).toBe("node_modules/mid/index.js");
    expect(f[0]!.file).toBe("app/page.tsx");
  });

  it("falls back to an unreachable importer", () => {
    const orphan = `${ROOT}/node_modules/orphan/index.js`;
    const m = [
      mod(page, { imports: [imp("orphan", { resolvedPath: orphan })] }),
      mod(orphan, { imports: [imp("heavy-lib")], importChainFromEntry: [] }),
    ];
    const f = run(transitiveHeavyDependency, m, { installSizes: { "heavy-lib": 9_999_999 } });
    expect(f).toHaveLength(1);
    expect(f[0]!.file).toBe("app/page.tsx");
    expect(f[0]!.evidence.via).toBe("node_modules/orphan/index.js");
  });

  it("ignores.files uses substring matching", () => {
    const m = mods();
    m[0]!.imports = [imp("mid", { resolvedPath: mid })];
    const opts = { installSizes: { "heavy-lib": 9_999_999 } };
    expect(run(transitiveHeavyDependency, m, { ...opts, ignoreFiles: ["heavy"] })).toHaveLength(0);
    expect(run(transitiveHeavyDependency, m, { ...opts, ignoreFiles: ["./heav/"] })).toHaveLength(0);
    expect(run(transitiveHeavyDependency, m, { ...opts, ignoreFiles: ["nomatch"] })).toHaveLength(1);
  });

  it("ignores small packages", () => {
    expect(run(transitiveHeavyDependency, mods(), { installSizes: { "heavy-lib": 10 } })).toHaveLength(0);
  });
});

describe("barrel-import", () => {
  it("flags barrel imports and skips deep + type-only", () => {
    const f = run(barrelImport, [
      mod(page, {
        imports: [
          imp("lodash"),
          imp("lodash/get"),
          imp("react-icons", { isTypeOnly: true }),
        ],
      }),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence.specifier).toBe("lodash");
    expect(f[0]!.fixStrategy.steps.join(" ")).toContain("optimizePackageImports");
  });

  it("uses Vite fix text and skips tree-shakable libs on Vite", () => {
    const f = run(
      barrelImport,
      [mod(page, { imports: [imp("lodash"), imp("lucide-react")] })],
      { deps: { vite: "5" } },
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.fixStrategy.steps.join(" ")).not.toContain("optimizePackageImports");
  });
});

describe("replaceable-dependency", () => {
  it("flags a package with a known replacement", () => {
    const [pkg] = [...loadReplacements().keys()];
    const f = run(replaceableDependency, [mod(page, { imports: [imp(pkg!)] })]);
    expect(f.some((x) => x.evidence.package === pkg)).toBe(true);
  });

  it("is quiet without such imports", () => {
    expect(run(replaceableDependency, [mod(page, { imports: [imp("./local")] })])).toHaveLength(0);
  });
});

describe("runtime-css-in-js", () => {
  it("flags styled-components", () => {
    const f = run(runtimeCssInJs, [mod(page, { imports: [imp("styled-components")] })]);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
  });

  it("does not flag unrelated packages", () => {
    expect(run(runtimeCssInJs, [mod(page, { imports: [imp("react")] })])).toHaveLength(0);
  });
});

describe("static-icon-map", () => {
  const syms = (n: number) => Array.from({ length: n }, (_, i) => `Icon${i}`);

  it("counts named symbols from known icon packages", () => {
    const f = run(
      staticIconMap,
      [mod(page, { imports: [imp("lucide-react", { namedSymbols: syms(5) })] })],
      { thresholds: { iconMapMinEntries: 5 } },
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence.iconImportCount).toBe(5);
  });

  it("does not match arbitrary packages named like icons", () => {
    const f = run(
      staticIconMap,
      [mod(page, { imports: [imp("my-icons-helper", { namedSymbols: syms(10) })] })],
      { thresholds: { iconMapMinEntries: 5 } },
    );
    expect(f).toHaveLength(0);
  });

  it("does not count import statements as symbols", () => {
    const f = run(
      staticIconMap,
      [mod(page, { imports: [imp("lucide-react", { namedSymbols: ["A"] }), imp("react-icons/fa", { namedSymbols: ["B"] })] })],
      { thresholds: { iconMapMinEntries: 3 } },
    );
    expect(f).toHaveLength(0);
  });
});

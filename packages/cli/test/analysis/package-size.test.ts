import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { measureClientPackageSizes } from "../../src/analysis/package-size.js";
import type { ModuleGraph, PackageInfo, Module } from "../../src/types.js";

function makeGraph(projectRoot: string, packages: string[]): ModuleGraph {
  const filePath = join(projectRoot, "app", "page.tsx");
  const mod = {
    filePath,
    env: "client",
    isBoundary: true,
    directives: new Set(["use client"]),
    imports: packages.map((packageName) => ({
      specifier: packageName,
      resolvedPath: null,
      packageName,
      namedSymbols: [],
      isDynamic: false,
      isTypeOnly: false,
      loc: { line: 1, column: 1 },
    })),
    exports: [],
    ast: () => ({ type: "Program", body: [], sourceType: "module" }) as never,
    signals: {
      hooks: [],
      eventHandlers: [],
      browserGlobals: [],
      nodeBuiltins: [],
      envReads: [],
      jsxElements: 0,
      largestLiteralBytes: 0,
      components: [],
      useEffectCalls: [],
    },
    sourceBytes: 100,
    subtreeBytes: 100,
    importChainFromEntry: [],
    dependents: [],
  } as Module;

  return {
    modules: new Map([[filePath, mod]]),
    entries: [filePath],
    clientModules: new Set([filePath]),
    serverModules: new Set(),
    sharedModules: new Set(),
  };
}

describe("measureClientPackageSizes", () => {
  it("measures package dist size and caches under .wimb/cache.json", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "wimb-pkgsize-"));
    try {
      mkdirSync(join(projectRoot, "node_modules", "heavy-lib", "dist"), { recursive: true });
      writeFileSync(join(projectRoot, "node_modules", "heavy-lib", "package.json"), '{"version":"1.2.3"}');
      writeFileSync(join(projectRoot, "node_modules", "heavy-lib", "dist", "index.js"), "x".repeat(50_000));

      const pkg: PackageInfo = {
        dependencies: { "heavy-lib": "^1.2.3" },
        devDependencies: {},
        installSizes: new Map([["heavy-lib", 0]]),
        lockfileVersions: new Map(),
      };

      await measureClientPackageSizes(projectRoot, makeGraph(projectRoot, ["heavy-lib"]), pkg, null);

      expect(pkg.installSizes.get("heavy-lib")).toBe(50_000);
      expect(existsSync(join(projectRoot, ".wimb", "cache.json"))).toBe(true);
      const cache = JSON.parse(readFileSync(join(projectRoot, ".wimb", "cache.json"), "utf-8"));
      expect(cache.packages["heavy-lib@1.2.3"].bytes).toBe(50_000);

      // Second run uses cache (even if we wipe dist — cache hit)
      pkg.installSizes.set("heavy-lib", 0);
      await measureClientPackageSizes(projectRoot, makeGraph(projectRoot, ["heavy-lib"]), pkg, null);
      expect(pkg.installSizes.get("heavy-lib")).toBe(50_000);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("prefers byteAttribution module sizes when measured", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "wimb-pkgsize-attr-"));
    try {
      const pkg: PackageInfo = {
        dependencies: { lodash: "^4" },
        devDependencies: {},
        installSizes: new Map([["lodash", 999]]),
        lockfileVersions: new Map(),
      };
      await measureClientPackageSizes(
        projectRoot,
        makeGraph(projectRoot, ["lodash"]),
        pkg,
        {
          routes: new Map(),
          modules: new Map([["lodash", 24_000]]),
          measured: true,
        },
      );
      expect(pkg.installSizes.get("lodash")).toBe(24_000);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

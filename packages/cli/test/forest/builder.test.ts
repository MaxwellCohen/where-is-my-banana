import { describe, expect, it } from "vitest";
import { buildGraph } from "../../src/graph/builder.js";
import { buildForestReport, moduleEnvToForestRuntime } from "../../src/forest/builder.js";
import {
  filePathToRoute,
  findPageFiles,
  resolveLayoutChain,
} from "../../src/forest/routes.js";
import { serializeAst } from "../../src/forest/serialize-ast.js";
import { parseSync } from "oxc-parser";
import { readFileSync } from "node:fs";
import { fixturePath } from "../helpers.js";
import type { ForestImportEdge, ForestPage, ForestPageImport, ForestReport } from "../../src/forest/types.js";

function findModuleImport(
  report: ForestReport,
  pageReachable: string[],
  resolvedFile: string,
): ForestImportEdge | undefined {
  for (const file of pageReachable) {
    const mod = report.modules[file];
    if (!mod) continue;
    const imp = mod.imports.find((i) => i.resolvedFile === resolvedFile);
    if (imp) return imp;
  }
  return undefined;
}

function findPageImport(page: ForestPage, resolvedFile: string): ForestPageImport | undefined {
  return page.imports.find((i) => i.resolvedFile === resolvedFile);
}

function forestDepth(node: { imports: { child: unknown }[] }): number {
  if (node.imports.length === 0) return 1;
  return 1 + Math.max(...node.imports.map((i) => (i.child ? forestDepth(i.child as typeof node) : 1)));
}

function assertJsonSerializable(value: unknown) {
  expect(() => JSON.stringify(value)).not.toThrow();
}

describe("moduleEnvToForestRuntime", () => {
  it("maps shared to both", () => {
    expect(moduleEnvToForestRuntime("shared")).toBe("both");
    expect(moduleEnvToForestRuntime("server")).toBe("server");
    expect(moduleEnvToForestRuntime("client")).toBe("client");
  });
});

describe("routes", () => {
  it("finds pages and maps routes", () => {
    const root = fixturePath("e2e-app");
    expect(findPageFiles(root)).toEqual(["app/page.tsx"]);
    expect(filePathToRoute("app/page.tsx")).toBe("/");
    expect(resolveLayoutChain("app/page.tsx", root)).toEqual(["app/layout.tsx"]);
  });

  it("omits route groups and finds multiple pages", () => {
    const root = fixturePath("branch-exclusive-eager");
    const pages = findPageFiles(root);
    expect(pages).toContain("app/page.tsx");
    expect(pages).toContain("app/always/page.tsx");
    expect(filePathToRoute("app/always/page.tsx")).toBe("/always");
  });
});

describe("serializeAst", () => {
  it("produces a JSON-safe program", () => {
    const source = readFileSync(fixturePath("e2e-app/app/page.tsx"), "utf-8");
    const program = parseSync("page.tsx", source, { sourceType: "module" }).program;
    const ast = serializeAst(program, source);
    expect(ast.type).toBe("Program");
    expect(ast.body.length).toBeGreaterThan(0);
    assertJsonSerializable(ast);
  });
});

describe("buildForestReport", () => {
  it("builds e2e-app forest with layout chain and jsx tree", async () => {
    const root = fixturePath("e2e-app");
    const graph = await buildGraph(root);
    const report = buildForestReport(root, graph);

    expect(report.version).toBe("1.1.0");
    expect(report.pages).toHaveLength(1);

    const page = report.pages[0]!;
    expect(page.route).toBe("/");
    expect(page.pageFile).toBe("app/page.tsx");
    expect(page.layoutFiles).toEqual(["app/layout.tsx"]);
    expect(page.entryFiles).toEqual(["app/layout.tsx", "app/page.tsx"]);
    expect(page.reachableFiles).toContain("components/client-page.tsx");
    expect(page.clientReachableFiles).toContain("components/client-page.tsx");

    const clientPageImport = findPageImport(page, "components/client-page.tsx");
    expect(clientPageImport).toBeDefined();
    expect(clientPageImport!.runtime).toBe("client");
    expect(clientPageImport!.loadKind).toBe("eager-static");
    expect(clientPageImport!.hints).toContain("client-bundle");
    expect(clientPageImport!.importChain.length).toBeGreaterThan(0);
    expect(forestDepth(page.forest)).toBeGreaterThan(1);

    const layoutEntry = report.entries["app/layout.tsx"];
    const pageEntry = report.entries["app/page.tsx"];
    expect(layoutEntry?.role).toBe("layout");
    expect(pageEntry?.role).toBe("page");
    expect(pageEntry?.defaultExport?.kind).toBe("element");
    expect(pageEntry?.defaultExport?.name).toBe("ClientPage");
    expect(pageEntry?.defaultExport?.props?.title).toEqual({
      kind: "literal",
      value: "Hello",
    });

    const clientImport = findModuleImport(report, page.reachableFiles, "components/client-page.tsx");
    expect(clientImport?.subtreeBytes).toBeGreaterThan(0);
    expect(clientImport?.sourceBytes).toBeGreaterThan(0);

    expect(layoutEntry?.ast?.type).toBe("Program");
    expect(Object.keys(report.entries).length).toBe(2);
    assertJsonSerializable(report);
  });

  it("builds static-component-map with client runtime and heavy registry import", async () => {
    const root = fixturePath("static-component-map");
    const graph = await buildGraph(root);
    const report = buildForestReport(root, graph, null, { heavySubtreeThreshold: 1 });

    const page = report.pages[0]!;
    expect(page.route).toBe("/");
    const pageEntry = report.entries["app/page.tsx"];
    expect(pageEntry?.runtime).toBe("client");
    expect(pageEntry?.isBoundary).toBe(true);
    expect(pageEntry?.directives).toContain("use client");

    const registryImport = findPageImport(page, "components/registry.tsx");
    expect(registryImport).toBeDefined();
    expect(registryImport!.subtreeBytes!).toBeGreaterThan(pageEntry!.sourceBytes);
    expect(registryImport!.hints).toContain("heavy-subtree");
    expect(registryImport!.hints).toContain("client-bundle");

    expect(report.modules["app/page.tsx"]?.runtime).toBe("client");
    assertJsonSerializable(report);
  });

  it("dedupes shared layout entries across pages", async () => {
    const root = fixturePath("branch-exclusive-eager");
    const graph = await buildGraph(root);
    const report = buildForestReport(root, graph);

    expect(report.pages.length).toBeGreaterThanOrEqual(2);
    const layoutCount = Object.values(report.entries).filter((e) => e.role === "layout").length;
    expect(layoutCount).toBe(1);
    assertJsonSerializable(report);
  });

  it("builds branch-exclusive-eager with conditional HomeContent on / only", async () => {
    const root = fixturePath("branch-exclusive-eager");
    const graph = await buildGraph(root);
    const report = buildForestReport(root, graph, null, { heavySubtreeThreshold: 1 });

    const routes = report.pages.map((p) => p.route).sort();
    expect(routes).toContain("/");
    expect(routes).toContain("/always");

    const homePage = report.pages.find((p) => p.route === "/")!;
    const alwaysPage = report.pages.find((p) => p.route === "/always")!;

    const homeContentImport = findPageImport(homePage, "components/HomeContent.tsx");
    expect(homeContentImport).toBeDefined();
    expect(homeContentImport!.usage.kind).toBe("conditional");
    if (homeContentImport!.usage.kind === "conditional") {
      expect(homeContentImport!.usage.componentName).toBe("HomeContent");
    }
    expect(homeContentImport!.hints).toContain("branch-exclusive-eager");

    expect(findPageImport(alwaysPage, "components/HomeContent.tsx")).toBeUndefined();
    assertJsonSerializable(report);
  });

  it("collects lazy imports from dynamic-import fixture", async () => {
    const root = fixturePath("dynamic-import");
    const graph = await buildGraph(root);
    const report = buildForestReport(root, graph);

    const dynamicPage = report.pages.find((p) => p.pageFile === "app/dynamic/page.tsx");
    expect(dynamicPage).toBeDefined();
    expect(dynamicPage!.lazyImports.length).toBeGreaterThan(0);
    expect(dynamicPage!.lazyImports.some((i) => i.specifier === "recharts")).toBe(true);

    const lazyRow = dynamicPage!.imports.find((i) => i.loadKind === "lazy-dynamic");
    expect(lazyRow).toBeDefined();
    expect(lazyRow!.hints).toContain("lazy-already");
    assertJsonSerializable(report);
  });

  it("omits AST when compact mode is enabled", async () => {
    const root = fixturePath("e2e-app");
    const graph = await buildGraph(root);
    const report = buildForestReport(root, graph, null, { compact: true });

    expect(report.entries["app/page.tsx"]?.ast).toBeUndefined();
    expect(report.entries["app/page.tsx"]?.defaultExport).toBeUndefined();
    assertJsonSerializable(report);
  });
});

import { describe, it, expect } from "vitest";
import { parseSync } from "oxc-parser";
import { analyzeBranchExclusiveComponents } from "../../src/analysis/branch-exclusive-components.js";
import type { Import } from "../../src/types.js";

function parse(source: string) {
  return parseSync("test.tsx", source, { sourceType: "module" });
}

function staticImport(symbol: string, specifier = "./Component"): Import {
  return {
    specifier,
    resolvedPath: `/project/${symbol}.tsx`,
    packageName: null,
    namedSymbols: [symbol],
    isDynamic: false,
    isTypeOnly: false,
    loc: { line: 1, column: 0 },
  };
}

function analyze(source: string, imports: Import[]) {
  const { program } = parse(source);
  return analyzeBranchExclusiveComponents(source, program, imports);
}

describe("analyzeBranchExclusiveComponents", () => {
  it("flags component used only in if consequent (react.dev pattern)", () => {
    const source = `
import { HomeContent } from './HomeContent';

export function Page({ pathname }: { pathname: string }) {
  const cleanedPath = pathname.split(/[?#]/)[0];
  const isHomePage = cleanedPath === '/';
  let content;
  if (isHomePage) {
    content = <HomeContent />;
  } else {
    content = <div>Other</div>;
  }
  return content;
}`;
    const results = analyze(source, [staticImport("HomeContent", "./HomeContent")]);
    expect(results).toHaveLength(1);
    expect(results[0]?.componentName).toBe("HomeContent");
    expect(results[0]?.branch).toBe("consequent");
    expect(results[0]?.pathRootCondition).toBe(true);
    expect(results[0]?.routes).toContain("/");
  });

  it("flags both components in a ternary when each is branch-exclusive", () => {
    const source = `
import { Foo } from './Foo';
import { Bar } from './Bar';

export function Page({ showFoo }: { showFoo: boolean }) {
  return showFoo ? <Foo /> : <Bar />;
}`;
    const results = analyze(source, [
      staticImport("Foo", "./Foo"),
      staticImport("Bar", "./Bar"),
    ]);
    const names = results.map((r) => r.componentName).sort();
    expect(names).toEqual(["Bar", "Foo"]);
    expect(results.find((r) => r.componentName === "Foo")?.branch).toBe("consequent");
    expect(results.find((r) => r.componentName === "Bar")?.branch).toBe("alternate");
  });

  it("does not flag unconditional component usage", () => {
    const source = `
import { Foo } from './Foo';

export function Page() {
  return <Foo />;
}`;
    const results = analyze(source, [staticImport("Foo")]);
    expect(results).toHaveLength(0);
  });

  it("does not flag component used in both branches", () => {
    const source = `
import { Foo } from './Foo';

export function Page({ x }: { x: boolean }) {
  return x ? <Foo /> : <Foo />;
}`;
    const results = analyze(source, [staticImport("Foo")]);
    expect(results).toHaveLength(0);
  });

  it("does not flag components that are not statically imported", () => {
    const source = `
export function Page({ x }: { x: boolean }) {
  return x ? <Foo /> : <Bar />;
}`;
    const results = analyze(source, []);
    expect(results).toHaveLength(0);
  });

  it("does not flag when component appears both conditionally and unconditionally", () => {
    const source = `
import { Foo } from './Foo';

export function Page({ x }: { x: boolean }) {
  if (x) {
    return <Foo />;
  }
  return <Foo />;
}`;
    const results = analyze(source, [staticImport("Foo")]);
    expect(results).toHaveLength(0);
  });

  it("flags alternate-branch exclusive component", () => {
    const source = `
import { BlogIndex } from './BlogIndex';

export function Page({ isHome }: { isHome: boolean }) {
  let content;
  if (isHome) {
    content = <div>Home</div>;
  } else {
    content = <BlogIndex />;
  }
  return content;
}`;
    const results = analyze(source, [staticImport("BlogIndex", "./BlogIndex")]);
    expect(results).toHaveLength(1);
    expect(results[0]?.componentName).toBe("BlogIndex");
    expect(results[0]?.branch).toBe("alternate");
  });
});

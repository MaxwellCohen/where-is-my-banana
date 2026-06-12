import { describe, it, expect } from "vitest";
import { parseSync } from "oxc-parser";
import { analyzeComponentRegistries } from "../../src/analysis/component-registry.js";
import type { Import } from "../../src/types.js";

function parse(source: string) {
  return parseSync("test.tsx", source, { sourceType: "module" });
}

function staticImport(symbol: string, specifier = `./${symbol}`): Import {
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
  return analyzeComponentRegistries(source, program, imports);
}

describe("analyzeComponentRegistries", () => {
  it("detects exported component map with import-backed entries", () => {
    const source = `
import { WidgetA } from './widgets/WidgetA';
import { WidgetB } from './widgets/WidgetB';
import { WidgetC } from './widgets/WidgetC';
import { WidgetD } from './widgets/WidgetD';

export const Components = {
  WidgetA,
  WidgetB,
  WidgetC,
  WidgetD,
  p: (props) => <p {...props} />,
};`;
    const results = analyze(source, [
      staticImport("WidgetA", "./widgets/WidgetA"),
      staticImport("WidgetB", "./widgets/WidgetB"),
      staticImport("WidgetC", "./widgets/WidgetC"),
      staticImport("WidgetD", "./widgets/WidgetD"),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.exportName).toBe("Components");
    expect(results[0]?.componentEntryCount).toBe(5);
    expect(results[0]?.importedComponentCount).toBe(4);
    expect(results[0]?.referencedImportPaths).toHaveLength(4);
  });

  it("does not flag i18n-style literal maps", () => {
    const source = `
export const translations = {
  en: "Hello",
  fr: "Bonjour",
  de: "Hallo",
  es: "Hola",
  it: "Ciao",
};`;
    const results = analyze(source, []);
    expect(results).toHaveLength(0);
  });

  it("reports import counts for small maps without applying rule thresholds", () => {
    const source = `
import { WidgetA } from './WidgetA';

export const Components = {
  WidgetA,
  p: (props) => <p {...props} />,
  span: (props) => <span {...props} />,
  div: (props) => <div {...props} />,
};`;
    const results = analyze(source, [staticImport("WidgetA", "./WidgetA")]);
    expect(results).toHaveLength(1);
    expect(results[0]?.importedComponentCount).toBe(1);
    expect(results[0]?.componentEntryCount).toBe(4);
  });
});

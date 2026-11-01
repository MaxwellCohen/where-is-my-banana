import { describe, it, expect } from "vitest";
import { parseSync } from "oxc-parser";
import { exportedName, stringLiteralValue, toAst, walk, walkWithParent } from "../../src/graph/ast-walk.js";

describe("ast-walk", () => {
  const program = parseSync("a.ts", 'import x from "pkg"; export const y = f(x);', { sourceType: "module" }).program;

  it("walk visits nested nodes", () => {
    const types: string[] = [];
    walk(toAst(program), (n) => types.push(n.type));
    expect(types).toContain("ImportDeclaration");
    expect(types).toContain("CallExpression");
  });

  it("walkWithParent passes parent", () => {
    let rootParent: unknown = "unset";
    const parents = new Map<string, string | null>();
    walkWithParent(toAst(program), (n, p) => {
      if (n.type === "Program") rootParent = p;
      if (n.type === "CallExpression") parents.set(n.type, p?.type ?? null);
    });
    expect(rootParent).toBeNull();
    expect(parents.get("CallExpression")).toBe("VariableDeclarator");
  });

  it("stringLiteralValue and exportedName", () => {
    expect(stringLiteralValue({ type: "Literal", value: "s" })).toBe("s");
    expect(stringLiteralValue({ type: "Literal", value: 1 })).toBeNull();
    expect(stringLiteralValue(null)).toBeNull();
    expect(exportedName({ type: "Identifier", name: "n" })).toBe("n");
    expect(exportedName({ type: "Literal", value: "lit" })).toBe("lit");
    expect(exportedName(undefined)).toBe("");
  });
});

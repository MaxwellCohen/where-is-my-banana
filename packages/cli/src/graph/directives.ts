import type { Program } from "oxc-parser";
import type { Directive } from "../types.js";

type AstNode = { type: string; [key: string]: unknown };

const PROLOGUE_DIRECTIVES = new Set(["use client", "use server"]);

export function extractDirectives(program: Program): Set<Directive> {
  const directives = new Set<Directive>();

  for (const stmt of program.body) {
    if (stmt.type === "ImportDeclaration") {
      const spec = stmt.source?.value ?? "";
      if (spec === "server-only") directives.add("server-only");
      if (spec === "client-only") directives.add("client-only");
      continue;
    }
    if (stmt.type === "ExpressionStatement") {
      const value = getStringLiteralValue(stmt.expression as AstNode);
      if (value && PROLOGUE_DIRECTIVES.has(value)) {
        directives.add(value as Directive);
      }
      continue;
    }
    if (
      stmt.type !== "EmptyStatement" &&
      stmt.type !== "LineComment" &&
      stmt.type !== "BlockComment"
    ) {
      break;
    }
  }

  return directives;
}

function getStringLiteralValue(node: AstNode): string | null {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "StringLiteral" && typeof node.value === "string") {
    return node.value;
  }
  return null;
}

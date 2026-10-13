import type { Program } from "oxc-parser";
import type { Directive } from "../types.js";
import { stringLiteralValue, toAst } from "./ast-walk.js";

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
      const value = stringLiteralValue(toAst(stmt.expression));
      if (value && PROLOGUE_DIRECTIVES.has(value)) {
        directives.add(value as Directive);
      }
      continue;
    }
    // Stop at first non-prologue statement (comments are not part of body)
    if (stmt.type !== "EmptyStatement") {
      break;
    }
  }

  return directives;
}

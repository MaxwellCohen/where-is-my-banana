import type { Program } from "oxc-parser";
import type { Loc } from "../types.js";
import { locFromSpan } from "../graph/loc.js";
import { type AstNode, toAst } from "../graph/ast-walk.js";
import type { SerializableAst, SerializableAstNode, SerializableAstValue } from "./types.js";

const MAX_DEPTH = 12;
const MAX_ARRAY_LENGTH = 64;
const MAX_STRING_LENGTH = 256;

const SKIP_KEYS = new Set([
  "span",
  "start",
  "end",
  "hash",
  "parent",
  "range",
  "loc",
  "raw",
  "extra",
  "cooked",
]);

const SHALLOW_BODY_TYPES = new Set([
  "BlockStatement",
  "ClassBody",
  "SwitchCase",
  "CatchClause",
]);

export function serializeAst(program: Program, source: string): SerializableAst {
  const lines = source.split("\n");
  const bodyNodes = program.body.map((stmt) => toAst(stmt));
  const body = serializeNodes(bodyNodes, lines, 0);
  const truncated = body.length < bodyNodes.length;
  return {
    type: "Program",
    sourceType: program.sourceType === "script" ? "script" : "module",
    body,
    ...(truncated ? { truncated: true } : {}),
  };
}

function serializeNodes(nodes: AstNode[], lines: string[], depth: number): SerializableAstNode[] {
  const limit = Math.min(nodes.length, MAX_ARRAY_LENGTH);
  const out: SerializableAstNode[] = [];
  for (let i = 0; i < limit; i++) {
    out.push(serializeNode(nodes[i]!, lines, depth));
  }
  return out;
}

function serializeNode(node: AstNode, lines: string[], depth: number): SerializableAstNode {
  const result: SerializableAstNode = { type: node.type };
  try {
    result.loc = locFromSpan(node, lines);
  } catch {
    // omit loc when span is missing
  }

  if (depth >= MAX_DEPTH) return result;

  if (node.type === "Literal" || node.type === "StringLiteral") {
    const value = node.value;
    if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
      result.value = `[truncated ${value.length} chars]`;
      result.truncated = true;
      return result;
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key) || key === "type") continue;

    if (key === "body" && SHALLOW_BODY_TYPES.has(node.type)) {
      const body = value as AstNode[] | AstNode | undefined;
      if (Array.isArray(body)) {
        const shallow = body
          .filter((stmt) => stmt.type === "ReturnStatement" || stmt.type === "ImportDeclaration")
          .slice(0, 8);
        if (shallow.length > 0) {
          result.body = serializeNodes(shallow, lines, depth + 1);
        } else {
          result.bodyOmitted = true;
        }
      }
      continue;
    }

    const serialized = serializeValue(value, lines, depth + 1);
    if (serialized !== undefined) {
      result[key] = serialized;
    }
  }

  return result;
}

function serializeValue(
  value: unknown,
  lines: string[],
  depth: number,
): SerializableAstValue | undefined {
  if (value == null) return null;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const limit = Math.min(value.length, MAX_ARRAY_LENGTH);
    const out: SerializableAstNode[] = [];
    for (let i = 0; i < limit; i++) {
      const item = value[i];
      if (item && typeof item === "object" && "type" in item) {
        out.push(serializeNode(item as AstNode, lines, depth));
      }
    }
    return out;
  }
  if (typeof value === "object" && "type" in value) {
    return serializeNode(value as AstNode, lines, depth);
  }
  return undefined;
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}…[${value.length} chars]`;
}

export function sliceSource(source: string, loc: Loc): string {
  const lines = source.split("\n");
  if (loc.endLine != null && loc.endLine !== loc.line) {
    const startLine = lines[loc.line - 1] ?? "";
    const endLine = lines[loc.endLine - 1] ?? "";
    if (loc.line === loc.endLine) {
      return truncateString(
        startLine.slice(loc.column - 1, loc.endColumn != null ? loc.endColumn - 1 : undefined),
      );
    }
    const parts = [startLine.slice(loc.column - 1)];
    for (let i = loc.line; i < loc.endLine - 1; i++) {
      parts.push(lines[i] ?? "");
    }
    parts.push(endLine.slice(0, loc.endColumn != null ? loc.endColumn - 1 : undefined));
    return truncateString(parts.join("\n"));
  }
  const line = lines[loc.line - 1] ?? "";
  return truncateString(
    line.slice(loc.column - 1, loc.endColumn != null ? loc.endColumn - 1 : undefined),
  );
}

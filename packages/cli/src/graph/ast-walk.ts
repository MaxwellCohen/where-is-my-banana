/**
 * Dynamic AST walker helpers for oxc Program trees.
 *
 * oxc nodes are strongly typed and do not expose an index signature, so we
 * cast through this walkable shape for structural traversal.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AstNode = { type: string; [key: string]: any };

export function toAst(node: object): AstNode {
  return node as AstNode;
}

export function walk(node: AstNode, visitor: (n: AstNode) => void): void {
  visitor(node);
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (!val || typeof val !== "object") continue;
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === "object" && "type" in child) {
          walk(child as AstNode, visitor);
        }
      }
    } else if ("type" in val) {
      walk(val as AstNode, visitor);
    }
  }
}

export function walkWithParent(
  node: AstNode,
  visitor: (n: AstNode, parent: AstNode | null) => void,
  parent: AstNode | null = null,
): void {
  visitor(node, parent);
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (!val || typeof val !== "object") continue;
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === "object" && "type" in child) {
          walkWithParent(child as AstNode, visitor, node);
        }
      }
    } else if ("type" in val) {
      walkWithParent(val as AstNode, visitor, node);
    }
  }
}

/** Read a string from oxc Literal / StringLiteral / Identifier-like nodes. */
export function stringLiteralValue(node: AstNode | null | undefined): string | null {
  if (!node) return null;
  if ((node.type === "Literal" || node.type === "StringLiteral") && typeof node.value === "string") {
    return node.value;
  }
  return null;
}

export function exportedName(exported: AstNode | null | undefined): string {
  if (!exported) return "";
  if (exported.type === "Identifier" || exported.type === "IdentifierName") {
    return typeof exported.name === "string" ? exported.name : "";
  }
  if (exported.type === "Literal" || exported.type === "StringLiteral") {
    return typeof exported.value === "string" ? exported.value : "";
  }
  return "";
}

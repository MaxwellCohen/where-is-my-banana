import type { TreeNode } from "./types";

export function isVendor(n: { path?: string }): boolean {
  return Boolean(n.path?.includes("node_modules/"));
}

export function walkTree<T extends { children: T[] }>(node: T, visit: (n: T) => void): void {
  visit(node);
  for (const child of node.children) walkTree(child, visit);
}

/** Children sorted by subtree size, largest first (does not mutate). */
export function sortedChildren(node: TreeNode): TreeNode[] {
  return [...node.children].sort((a, b) => b.totalBytes - a.totalBytes);
}

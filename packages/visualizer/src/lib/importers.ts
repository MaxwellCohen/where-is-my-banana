import type { ImporterRow, TreeNode } from "./types";

function isAppSourcePath(path: string): boolean {
  if (!path) return false;
  if (path.startsWith("source:")) return false;
  if (path.startsWith("[")) return false;
  if (path.endsWith("/")) return false;
  if (path.includes("node_modules/")) return false;
  if (path.startsWith("next/") || path.startsWith("_next/")) return false;
  if (path.startsWith("turbopack/")) return false;
  // Prefer real files over path-prefix stubs from binary analyze trees.
  const base = path.split("/").pop() ?? path;
  return /\.(tsx?|jsx?|mjs|cjs|css|scss)$/i.test(base);
}

/** Rank modules by how much they pull into the selected route tree. */
export function rankImporters(
  tree: TreeNode | undefined,
  opts: { appOnly?: boolean } = {},
): ImporterRow[] {
  if (!tree) return [];
  const byPath = new Map<string, ImporterRow>();

  const visit = (node: TreeNode) => {
    if (node.kind === "module" && node.path && !node.shared && !node.cycle) {
      const appFile = isAppSourcePath(node.path);
      if (!opts.appOnly || appFile) {
        const prev = byPath.get(node.path);
        if (!prev || node.totalBytes > prev.pullBytes) {
          byPath.set(node.path, {
            path: node.path,
            label: node.label,
            selfBytes: node.selfBytes,
            pullBytes: node.totalBytes,
            routeCount: node.routeCount,
            appFile,
          });
        }
      }
    }
    for (const child of node.children) visit(child);
  };

  visit(tree);
  return [...byPath.values()].sort(
    (a, b) => b.pullBytes - a.pullBytes || b.selfBytes - a.selfBytes || a.label.localeCompare(b.label),
  );
}

export type { ImporterRow };

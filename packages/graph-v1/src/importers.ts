import { displayLabel, isAppSourcePath } from "./module-path.js";
import type { ImporterRow, TreeNode } from "./types.js";

/** Flatten a route tree into importer rows sorted by pull (subtree) weight. */
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
        // Keep the expansion with the largest pull weight.
        if (!prev || node.totalBytes > prev.pullBytes) {
          byPath.set(node.path, {
            path: node.path,
            label: node.label || displayLabel(node.path),
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

"use client";

import { memo, useEffect, useState } from "react";
import type { TreeNode } from "@/lib/types";
import { formatBytes } from "@/lib/format";
import { pathsMatch } from "@/lib/wins";

interface Props {
  node: TreeNode;
  depth: number;
  routeTotal: number;
  /** Selected win: target module + chain, for highlighting. */
  hl?: { target: string; chain: string[] } | null;
  /** Nodes that are, or contain, the highlighted target (see `collectHitAncestors`). */
  hits?: ReadonlySet<TreeNode>;
}

const MAX_CHILDREN = 100;

function hitKind(node: TreeNode, hl: Props["hl"]): "hit" | "chain" | null {
  if (!hl || node.kind !== "module") return null;
  const p = node.path ?? node.id;
  if (pathsMatch(p, hl.target)) return "hit";
  return hl.chain.some((c) => pathsMatch(p, c)) ? "chain" : null;
}

/** One pass over the tree: every node that is or contains the highlight target. */
export function collectHitAncestors(root: TreeNode, hl: Props["hl"]): Set<TreeNode> {
  const out = new Set<TreeNode>();
  if (!hl) return out;
  const visit = (node: TreeNode): boolean => {
    let found = hitKind(node, hl) === "hit";
    for (const c of node.children) if (visit(c)) found = true;
    if (found) out.add(node);
    return found;
  };
  visit(root);
  return out;
}

export const TreeNodeRow = memo(function TreeNodeRow({ node, depth, routeTotal, hl, hits }: Props) {
  const hasChildren = node.children.length > 0;
  const hasHit = !node.cycle && Boolean(hits?.has(node));
  const [open, setOpen] = useState((depth < 2 && !node.cycle) || hasHit);
  const [limit, setLimit] = useState(MAX_CHILDREN);
  // Auto-expand when a new highlight is selected, but let the user collapse it afterwards.
  useEffect(() => {
    if (hasHit) setOpen(true);
  }, [hasHit, hits]);
  const kind = hitKind(node, hl);
  const isOpen = open;

  const pct =
    routeTotal > 0 ? Math.min(100, Math.round((node.totalBytes / routeTotal) * 1000) / 10) : 0;

  return (
    <li className="tree-node">
      <div
        className={`tree-row${kind === "hit" ? " win-hit" : kind === "chain" ? " win-chain-hit" : ""}`}
        style={{ paddingLeft: `${depth * 1.1}rem` }}>
        <span className="tree-name">
          <button
            type="button"
            className="tree-toggle"
            disabled={!hasChildren}
            aria-expanded={hasChildren ? isOpen : undefined}
            onClick={() => hasChildren && setOpen((v) => !v)}
          >
            {hasChildren ? (isOpen ? "▾" : "▸") : "·"}
          </button>
          <span className="tree-label" title={node.path ?? node.id}>
            {node.label}
            {node.cycle ? <span className="badge cycle">cycle</span> : null}
            {node.shared ? <span className="badge shared">shared</span> : null}
            {node.edgeKind === "async" ? <span className="badge async">async</span> : null}
            {node.edgeKind === "sync" ? <span className="badge sync">sync</span> : null}
            {node.routeCount > 1 ? (
              <span className="badge use">{node.routeCount}× use</span>
            ) : null}
          </span>
        </span>
        <span className="tree-metric" title="Self attributed client bytes">
          {formatBytes(node.selfBytes)}
        </span>
        <span className="tree-metric" title="Subtree total">
          {formatBytes(node.totalBytes)}
        </span>
        <span className="tree-metric" title="Routes using this module">
          {node.routeCount}
        </span>
        <span className="tree-pct" title="% of route total">
          <span className="bar" style={{ width: `${pct}%` }} />
          <span className="pct-label">{pct}%</span>
        </span>
      </div>
      {isOpen && hasChildren ? (
        <ul className="tree-children">
          {node.children.slice(0, limit).map((child) => (
            <TreeNodeRow
              key={`${child.id}:${child.edgeKind ?? ""}`}
              node={child}
              depth={depth + 1}
              routeTotal={routeTotal}
              hl={hl}
              hits={hits}
            />
          ))}
          {node.children.length > limit ? (
            <li className="tree-node">
              <button type="button" className="tree-toggle" onClick={() => setLimit((l) => l + MAX_CHILDREN)}>
                Show {Math.min(MAX_CHILDREN, node.children.length - limit)} more ({node.children.length - limit} hidden)
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
});

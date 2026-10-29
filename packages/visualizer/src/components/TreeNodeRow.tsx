"use client";

import { useState } from "react";
import type { TreeNode } from "@/lib/types";
import { formatBytes } from "@/lib/format";
import { pathsMatch } from "@/lib/wins";

interface Props {
  node: TreeNode;
  depth: number;
  routeTotal: number;
  /** Selected win: target module + chain, for highlighting. */
  hl?: { target: string; chain: string[] } | null;
}

function hitKind(node: TreeNode, hl: Props["hl"]): "hit" | "chain" | null {
  if (!hl || node.kind !== "module") return null;
  const p = node.path ?? node.id;
  if (pathsMatch(p, hl.target)) return "hit";
  return hl.chain.some((c) => pathsMatch(p, c)) ? "chain" : null;
}

function containsHit(node: TreeNode, hl: Props["hl"]): boolean {
  if (!hl) return false;
  if (hitKind(node, hl) === "hit") return true;
  return node.children.some((c) => containsHit(c, hl));
}

export function TreeNodeRow({ node, depth, routeTotal, hl }: Props) {
  const hasChildren = node.children.length > 0;
  const [open, setOpen] = useState(depth < 2 && !node.cycle);
  const kind = hitKind(node, hl);
  const forceOpen = !node.cycle && containsHit(node, hl);
  const isOpen = open || forceOpen;

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
          {node.children.map((child) => (
            <TreeNodeRow
              key={`${child.id}:${child.edgeKind ?? ""}`}
              node={child}
              depth={depth + 1}
              routeTotal={routeTotal}
              hl={hl}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

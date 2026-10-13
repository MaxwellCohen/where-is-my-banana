"use client";

import { useState } from "react";
import type { TreeNode } from "@/lib/types";
import { formatBytes } from "@/lib/format";

interface Props {
  node: TreeNode;
  depth: number;
  routeTotal: number;
}

export function TreeNodeRow({ node, depth, routeTotal }: Props) {
  const hasChildren = node.children.length > 0;
  const [open, setOpen] = useState(depth < 2 && !node.cycle);

  const pct =
    routeTotal > 0 ? Math.min(100, Math.round((node.totalBytes / routeTotal) * 1000) / 10) : 0;

  return (
    <li className="tree-node">
      <div className="tree-row" style={{ paddingLeft: `${depth * 1.1}rem` }}>
        <span className="tree-name">
          <button
            type="button"
            className="tree-toggle"
            disabled={!hasChildren}
            aria-expanded={hasChildren ? open : undefined}
            onClick={() => hasChildren && setOpen((v) => !v)}
          >
            {hasChildren ? (open ? "▾" : "▸") : "·"}
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
      {open && hasChildren ? (
        <ul className="tree-children">
          {node.children.map((child) => (
            <TreeNodeRow
              key={`${child.id}:${child.edgeKind ?? ""}`}
              node={child}
              depth={depth + 1}
              routeTotal={routeTotal}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

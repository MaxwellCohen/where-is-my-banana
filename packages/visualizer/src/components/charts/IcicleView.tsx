"use client";

import { useMemo } from "react";
import { formatBytes } from "@/lib/format";
import { layoutPartition, nodeColor } from "@/lib/viz-layout";
import type { TreeNode } from "@/lib/types";

const W = 1000;
const ROW = 26;
const DEPTH = 12;

export function IcicleView({ root, onZoom }: { root: TreeNode; onZoom: (n: TreeNode) => void }) {
  const arcs = useMemo(() => layoutPartition(root, DEPTH), [root]);
  const maxDepth = Math.max(...arcs.map((a) => a.depth));
  return (
    <svg
      className="chart"
      viewBox={`0 0 ${W} ${(maxDepth + 1) * ROW}`}
      role="img"
      aria-label="Icicle chart"
    >
      {arcs.map(({ node, depth, a0, a1 }) => {
        const x = a0 * W;
        const w = (a1 - a0) * W;
        return (
          <g key={`${node.id}:${depth}:${a0}`} onClick={() => node.children.length && onZoom(node)}>
            <rect
              x={x}
              y={depth * ROW}
              width={Math.max(w - 1, 0)}
              height={ROW - 1}
              fill={depth === 0 ? "var(--bg2)" : nodeColor(node)}
              fillOpacity={0.85}
            >
              <title>{`${node.path ?? node.label}\n${formatBytes(node.totalBytes)} subtree`}</title>
            </rect>
            {w > 44 ? (
              <text x={x + 4} y={depth * ROW + 17} className="chart-label">
                {node.label.length > w / 6.5 ? `${node.label.slice(0, Math.max(Math.floor(w / 6.5) - 1, 1))}…` : node.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

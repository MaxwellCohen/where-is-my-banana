"use client";

import { useMemo } from "react";
import { formatBytes } from "@/lib/format";
import { layoutTreemap, nodeColor } from "@/lib/viz-layout";
import type { TreeNode } from "@/lib/types";

const W = 1000;
const H = 560;

export function TreemapView({ root, onZoom }: { root: TreeNode; onZoom: (n: TreeNode) => void }) {
  const cells = useMemo(() => layoutTreemap(root, W, H), [root]);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Treemap">
      {cells.map(({ node, depth, x, y, w, h }) => (
        <g key={`${node.id}:${x}:${y}`} onClick={() => node.children.length && onZoom(node)}>
          <rect
            x={x}
            y={y}
            width={Math.max(w - 1, 0)}
            height={Math.max(h - 1, 0)}
            fill={depth === 0 ? "var(--bg2)" : nodeColor(node)}
            fillOpacity={depth === 0 ? 1 : 0.55 + depth * 0.1}
            stroke="var(--bg0)"
          >
            <title>{`${node.path ?? node.label}\n${formatBytes(node.totalBytes)} subtree · ${formatBytes(node.selfBytes)} self`}</title>
          </rect>
          {w > 50 && h > 14 ? (
            <text x={x + 4} y={y + 12} className="chart-label">
              {truncate(node.label, Math.floor(w / 6.5))}
            </text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, Math.max(n - 1, 1))}…` : s;
}

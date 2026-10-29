"use client";

import { useMemo } from "react";
import { formatBytes } from "@/lib/format";
import { layoutPartition, nodeColor } from "@/lib/viz-layout";
import type { TreeNode } from "@/lib/types";

const SIZE = 640;
const R = SIZE / 2;
const RINGS = 6;
const TAU = Math.PI * 2;

function arcPath(a0: number, a1: number, r0: number, r1: number) {
  const full = a1 - a0 >= 0.9999;
  const s = a0 * TAU - Math.PI / 2;
  const e = (full ? a0 + 0.9999 : a1) * TAU - Math.PI / 2;
  const large = e - s > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => `${(R + r * Math.cos(a)).toFixed(2)} ${(R + r * Math.sin(a)).toFixed(2)}`;
  return `M${p(r1, s)}A${r1} ${r1} 0 ${large} 1 ${p(r1, e)}L${p(r0, e)}A${r0} ${r0} 0 ${large} 0 ${p(r0, s)}Z`;
}

export function SunburstView({ root, onZoom }: { root: TreeNode; onZoom: (n: TreeNode) => void }) {
  const arcs = useMemo(() => layoutPartition(root, RINGS), [root]);
  const ring = (R - 50) / (RINGS + 1);
  return (
    <svg className="chart chart-square" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="Sunburst">
      {arcs.map(({ node, depth, a0, a1 }) => (
        <path
          key={`${node.id}:${depth}:${a0}`}
          d={arcPath(a0, a1, depth === 0 ? 0 : 50 + (depth - 1) * ring, 50 + depth * ring)}
          fill={depth === 0 ? "var(--bg2)" : nodeColor(node)}
          fillOpacity={0.85}
          stroke="var(--bg0)"
          onClick={() => node.children.length && onZoom(node)}
        >
          <title>{`${node.path ?? node.label}\n${formatBytes(node.totalBytes)} subtree`}</title>
        </path>
      ))}
      <text x={R} y={R - 4} textAnchor="middle" className="chart-label chart-center">
        {root.label.length > 24 ? `${root.label.slice(0, 23)}…` : root.label}
      </text>
      <text x={R} y={R + 14} textAnchor="middle" className="chart-label chart-center">
        {formatBytes(root.totalBytes)}
      </text>
    </svg>
  );
}

"use client";

import { useMemo, useState } from "react";
import { formatBytes } from "@/lib/format";
import type { RouteSummary, TreeNode } from "@/lib/types";

const MAX_DEPTH = 4;
const MAX_KIDS = 4;
const MIN_FRACTION = 0.01;
const SLOT = 96;
const ROW = 130;
const TOP = 50;
const MIN_WIDTH = 640;
const ROOT_GAP = 0.6;

interface Placed {
  node: TreeNode;
  depth: number;
  x: number;
  y: number;
  r: number;
  parent?: Placed;
  imports: number;
  modules: number;
}

function isVendor(n: TreeNode) {
  return Boolean(n.path?.includes("node_modules/"));
}

function countModules(n: TreeNode): number {
  return n.children.reduce((s, c) => s + 1 + countModules(c), 0);
}

function build(roots: TreeNode[]) {
  const all: Placed[] = [];
  let leaf = 0;
  for (const [i, root] of roots.entries()) {
    if (i > 0) leaf += ROOT_GAP;
    const total = root.totalBytes || 1;
    const place = (node: TreeNode, depth: number, parent?: Placed): Placed => {
      const r = depth === 0 ? 20 : 9 + 26 * Math.sqrt(node.totalBytes / total);
      const p: Placed = {
        node,
        depth,
        x: 0,
        y: TOP + depth * ROW,
        r,
        parent,
        imports: node.children.length,
        modules: countModules(node),
      };
      all.push(p);
      const kids =
        depth >= MAX_DEPTH
          ? []
          : [...node.children]
              .filter((c) => c.totalBytes / total >= MIN_FRACTION)
              .sort((a, b) => b.totalBytes - a.totalBytes)
              .slice(0, MAX_KIDS);
      if (!kids.length) p.x = leaf++ * SLOT;
      else {
        const placed = kids.map((k) => place(k, depth + 1, p));
        p.x = (placed[0].x + placed[placed.length - 1].x) / 2;
      }
      return p;
    };
    place(root, 0);
  }
  const used = Math.max(leaf, 1) * SLOT;
  const width = Math.max(used, MIN_WIDTH);
  const shift = (width - used) / 2 + SLOT / 2;
  for (const o of all) o.x += shift;
  return { all, width, height: TOP + MAX_DEPTH * ROW + 60 };
}

export function RouteGraph({
  routes,
  trees,
  selected,
  onSelect,
}: {
  routes: RouteSummary[];
  trees: Record<string, TreeNode>;
  selected: string;
  onSelect: (route: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const sorted = useMemo(() => [...routes].sort((a, b) => b.totalBytes - a.totalBytes), [routes]);
  const shown = sorted.filter(
    (r) => !hidden.has(r.route) && r.route.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const roots = shown.map((r) => trees[r.route]).filter((t): t is TreeNode => Boolean(t));
  const { all, width, height } = useMemo(() => build(roots), [roots]);

  function toggle(route: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(route)) next.delete(route);
      else next.add(route);
      return next;
    });
  }

  return (
    <>
      <div className="graph-filter">
        <input
          type="search"
          placeholder="Filter pages…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter pages"
        />
        <button type="button" onClick={() => setHidden(new Set())}>
          All
        </button>
        <button type="button" onClick={() => setHidden(new Set(routes.map((r) => r.route)))}>
          None
        </button>
        <button type="button" onClick={() => setHidden(new Set(routes.map((r) => r.route).filter((r) => r !== selected)))}>
          Only selected
        </button>
        <span className="chips">
          {sorted.map((r) => (
            <button
              key={r.route}
              type="button"
              className={hidden.has(r.route) ? undefined : "active"}
              onClick={() => toggle(r.route)}
            >
              {r.route}
            </button>
          ))}
        </span>
      </div>
      <p className="hint">
        Number on each node = direct imports. Size = subtree bytes. Click a page to select it.
      </p>
      {!roots.length ? (
        <p className="empty">No pages match.</p>
      ) : (
        <div className="graph-wrap">
          <svg
            className="chart"
            viewBox={`0 0 ${width} ${height}`}
            style={{ maxWidth: width, margin: "0 auto" }}
            role="img"
            aria-label="Pages and their imports"
          >
            {all
              .filter((o) => o.parent)
              .map((o) => {
                const p = o.parent!;
                const my = (p.y + o.y) / 2;
                return (
                  <path
                    key={`l:${o.node.id}:${o.x}:${o.y}`}
                    d={`M${p.x} ${p.y}C${p.x} ${my} ${o.x} ${my} ${o.x} ${o.y}`}
                    fill="none"
                    stroke="var(--line)"
                    strokeWidth={2}
                  />
                );
              })}
            {all.map((o) => {
              const { node, depth, x, y, r } = o;
              const fill =
                depth === 0 ? "var(--accent)" : isVendor(node) ? "var(--warn)" : "var(--accent-dim)";
              const label = node.label.length > 14 ? `${node.label.slice(0, 13)}…` : node.label;
              const active = depth === 0 && node.id === selected;
              return (
                <g
                  key={`o:${node.id}:${x}:${y}`}
                  onClick={() => depth === 0 && onSelect(node.id)}
                  style={depth === 0 ? undefined : { cursor: "default" }}
                >
                  <circle
                    cx={x}
                    cy={y}
                    r={r}
                    fill={fill}
                    stroke={active ? "var(--ink)" : "var(--bg0)"}
                    strokeWidth={active ? 3 : 2}
                  >
                    <title>{`${node.path ?? node.label}\n${formatBytes(node.totalBytes)} subtree · ${formatBytes(node.selfBytes)} self\n${o.imports} direct imports · ${o.modules} modules downstream`}</title>
                  </circle>
                  {o.imports > 0 ? (
                    <g>
                      <circle cx={x + r * 0.75} cy={y - r * 0.75} r={9} fill="var(--bg0)" stroke="var(--line)" />
                      <text x={x + r * 0.75} y={y - r * 0.75 + 3.5} textAnchor="middle" className="chart-label">
                        {o.imports}
                      </text>
                    </g>
                  ) : null}
                  <text x={x} y={y + r + 15} textAnchor="middle" className="chart-label">
                    {depth === 0 ? node.label : label}
                  </text>
                  <text x={x} y={y + r + 28} textAnchor="middle" className="chart-label chart-dim">
                    {formatBytes(node.totalBytes)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </>
  );
}

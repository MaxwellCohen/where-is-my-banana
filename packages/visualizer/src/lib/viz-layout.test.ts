import { describe, expect, it } from "vitest";
import { findNode, layoutPartition, layoutTreemap, nodeColor, squarify } from "./viz-layout";
import type { TreeNode } from "./types";

const n = (id: string, totalBytes: number, children: TreeNode[] = [], path?: string): TreeNode => ({
  kind: "module",
  id,
  label: id,
  path,
  selfBytes: totalBytes,
  totalBytes,
  routeCount: 1,
  children,
});

describe("squarify", () => {
  it("tiles the rect area proportionally", () => {
    const nodes = [6, 6, 4, 3, 2, 2, 1].map((b, i) => n(`n${i}`, b));
    const rects = squarify(nodes, { x: 0, y: 0, w: 600, h: 400 });
    expect(rects).toHaveLength(nodes.length);
    const area = rects.reduce((s, r) => s + r.w * r.h, 0);
    expect(area).toBeCloseTo(600 * 400, 3);
    for (const r of rects) expect(r.w).toBeGreaterThan(0);
  });
});

describe("layouts", () => {
  const root = n("root", 100, [n("a", 60, [n("a1", 30), n("a2", 30)]), n("b", 39.8), n("tiny", 0.2)]);
  it("treemap hides tiny slices and places children inside root", () => {
    const cells = layoutTreemap(root, 1000, 500);
    const ids = cells.map((c) => c.node.id);
    expect(ids).toContain("a1");
    expect(ids).not.toContain("tiny");
    expect(cells[0]).toMatchObject({ x: 0, y: 0, w: 1000, h: 500 });
  });
  it("partition arcs are contiguous and bounded", () => {
    const arcs = layoutPartition(root, 3);
    const top = arcs.filter((a) => a.depth === 1);
    expect(top[0].a0).toBe(0);
    expect(top[0].a1).toBeCloseTo(0.6);
    expect(top[1].a0).toBeCloseTo(0.6);
  });
  it("findNode and nodeColor", () => {
    expect(findNode(root, "a2")?.id).toBe("a2");
    expect(findNode(root, "zzz")).toBeNull();
    expect(nodeColor(n("x", 1, [], "node_modules/react/index.js"))).toBe(
      nodeColor(n("y", 1, [], "node_modules/react/other.js")),
    );
  });
});

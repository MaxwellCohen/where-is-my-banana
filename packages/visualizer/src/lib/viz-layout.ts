import type { TreeNode } from "./types";

export interface Placed {
  node: TreeNode;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Arc {
  node: TreeNode;
  depth: number;
  a0: number;
  a1: number;
}

const MIN_FRACTION = 0.004;

function visibleChildren(node: TreeNode, rootTotal: number): TreeNode[] {
  return node.children
    .filter((c) => c.totalBytes / rootTotal >= MIN_FRACTION)
    .sort((a, b) => b.totalBytes - a.totalBytes);
}

/** Stable hue per top-level package/folder so related modules share a colour. */
export function nodeColor(node: TreeNode): string {
  const key = node.path?.includes("node_modules/")
    ? (node.path.split("node_modules/").pop() ?? "").split("/").slice(0, node.path.split("node_modules/").pop()!.startsWith("@") ? 2 : 1).join("/")
    : (node.path ?? node.label).split("/").slice(0, 2).join("/");
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const vendor = node.path?.includes("node_modules/");
  return `hsl(${h % 360} ${vendor ? 38 : 55}% ${vendor ? 38 : 46}%)`;
}

export function layoutTreemap(root: TreeNode, width: number, height: number, maxDepth = 3): Placed[] {
  const total = root.totalBytes || 1;
  const out: Placed[] = [];
  const pad = 3;
  const head = 16;

  function place(node: TreeNode, depth: number, x: number, y: number, w: number, h: number) {
    out.push({ node, depth, x, y, w, h });
    if (depth >= maxDepth) return;
    const kids = visibleChildren(node, total);
    if (!kids.length || w < 24 || h < 24) return;
    const inner = { x: x + pad, y: y + head, w: w - pad * 2, h: h - head - pad };
    if (inner.w <= 0 || inner.h <= 0) return;
    for (const r of squarify(kids, inner)) place(r.node, depth + 1, r.x, r.y, r.w, r.h);
  }

  place(root, 0, 0, 0, width, height);
  return out;
}

function squarify(nodes: TreeNode[], rect: { x: number; y: number; w: number; h: number }) {
  const sum = nodes.reduce((s, n) => s + n.totalBytes, 0) || 1;
  const scale = (rect.w * rect.h) / sum;
  const items = nodes.map((node) => ({ node, area: node.totalBytes * scale }));
  const out: { node: TreeNode; x: number; y: number; w: number; h: number }[] = [];
  let { x, y, w, h } = rect;
  let row: typeof items = [];

  const worst = (r: typeof items, side: number) => {
    const s = r.reduce((a, i) => a + i.area, 0);
    const max = Math.max(...r.map((i) => i.area));
    const min = Math.min(...r.map((i) => i.area));
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };

  const flush = () => {
    if (!row.length) return;
    const s = row.reduce((a, i) => a + i.area, 0);
    if (w >= h) {
      const rw = s / h;
      let cy = y;
      for (const i of row) {
        const ih = i.area / rw;
        out.push({ node: i.node, x, y: cy, w: rw, h: ih });
        cy += ih;
      }
      x += rw;
      w -= rw;
    } else {
      const rh = s / w;
      let cx = x;
      for (const i of row) {
        const iw = i.area / rh;
        out.push({ node: i.node, x: cx, y, w: iw, h: rh });
        cx += iw;
      }
      y += rh;
      h -= rh;
    }
    row = [];
  };

  for (const item of items) {
    const side = Math.min(w, h);
    if (row.length && worst([...row, item], side) > worst(row, side)) flush();
    row.push(item);
  }
  flush();
  return out;
}

/** Angular / linear partition shared by icicle and sunburst (fractions of [0,1]). */
export function layoutPartition(root: TreeNode, maxDepth: number): Arc[] {
  const total = root.totalBytes || 1;
  const out: Arc[] = [];
  function place(node: TreeNode, depth: number, a0: number, a1: number) {
    out.push({ node, depth, a0, a1 });
    if (depth >= maxDepth) return;
    let cursor = a0;
    for (const c of visibleChildren(node, total)) {
      const span = (c.totalBytes / node.totalBytes) * (a1 - a0);
      place(c, depth + 1, cursor, cursor + span);
      cursor += span;
    }
  }
  place(root, 0, 0, 1);
  return out;
}

export function findNode(root: TreeNode, id: string): TreeNode | null {
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

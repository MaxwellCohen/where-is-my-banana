"use client";

import { useMemo, useState } from "react";
import { rankImporters } from "@/lib/importers";
import { loadGraphFromFile } from "@/lib/load-graph";
import type { BundleSide, VizGraph, VizSide } from "@/lib/types";
import { formatBytes } from "@/lib/format";
import { TreeNodeRow } from "./TreeNodeRow";
import { ImporterTable } from "./ImporterTable";
import { CopyPromptButton } from "./CopyPromptButton";

type ViewMode = "importers" | "tree";

function sideBundle(graph: VizGraph, side: BundleSide): VizSide {
  if (graph.sides?.[side]) return graph.sides[side];
  // v1 payloads are client-only
  if (side === "server") return { routes: [], trees: {} };
  return { routes: graph.routes, trees: graph.trees };
}

export function VisualizerApp() {
  const [graph, setGraph] = useState<VizGraph | null>(null);
  const [side, setSide] = useState<BundleSide>("client");
  const [view, setView] = useState<ViewMode>("importers");
  const [appOnly, setAppOnly] = useState(true);
  const [selected, setSelected] = useState("/");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const bundle = useMemo(
    () => (graph ? sideBundle(graph, side) : { routes: [], trees: {} }),
    [graph, side],
  );
  const tree = bundle.trees[selected];
  const routeTotal = tree?.totalBytes ?? 0;

  const importers = useMemo(() => {
    const ranked = bundle.importersByRoute?.[selected];
    if (ranked && ranked.length > 0) {
      return appOnly ? ranked.filter((r) => r.appFile) : ranked;
    }
    // Fallback for older payloads / JSONL without precomputed import-graph ranks.
    return rankImporters(tree, { appOnly });
  }, [bundle, selected, appOnly, tree]);

  const sharedHotspots = useMemo(() => {
    const scores = new Map<
      string,
      { label: string; path: string; routeCount: number; maxBytes: number }
    >();
    for (const route of bundle.routes) {
      const root = bundle.trees[route.route];
      if (!root) continue;
      walk(root, (n) => {
        if (n.kind !== "module" || !n.path || n.routeCount < 2) return;
        const prev = scores.get(n.path);
        if (!prev || n.selfBytes > prev.maxBytes) {
          scores.set(n.path, {
            label: n.label,
            path: n.path,
            routeCount: n.routeCount,
            maxBytes: n.selfBytes,
          });
        }
      });
    }
    return [...scores.values()]
      .sort((a, b) => b.maxBytes * b.routeCount - a.maxBytes * a.routeCount)
      .slice(0, 8);
  }, [bundle]);

  function switchSide(next: BundleSide) {
    setSide(next);
    if (!graph) return;
    const nextBundle = sideBundle(graph, next);
    if (!nextBundle.trees[selected] && nextBundle.routes[0]) {
      setSelected(nextBundle.routes[0].route);
    }
  }

  async function onUpload(file: File | null) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const next = await loadGraphFromFile(file);
      setGraph(next);
      setSelected(sideBundle(next, side).routes[0]?.route ?? "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const hasServer = (graph?.sides?.server.routes.length ?? 0) > 0;

  return (
    <div className="shell">
      <header className="hero">
        <p className="brand">Where Is My Banana</p>
        <h1>Bundle forest</h1>
        <p className="lede">
          See which of <em>your</em> files pull the most into a route. Copy the agent prompt, build a
          forest locally, then open the JSON here — parsed in this browser only.
        </p>
        <div className="upload">
          <CopyPromptButton />
          <label className="upload-btn">
            {busy ? "Parsing…" : "Open local file"}
            <input
              type="file"
              accept=".jsonl,.gz,.json,.jsonl.gz"
              disabled={busy}
              onChange={(e) => void onUpload(e.target.files?.[0] ?? null)}
            />
          </label>
          <span className="meta">
            {graph
              ? `snapshot ${graph.meta.snapshotName ?? "local"} · ${bundle.routes.length} routes · ${side}`
              : "waiting for a local file"}
          </span>
        </div>
        <p className="privacy">Nothing is uploaded or stored on the server. Graphs never leave your device.</p>
        {error ? <p className="error">{error}</p> : null}

        {graph ? (
          <div className="toolbar">
            <div className="seg" role="group" aria-label="Bundle side">
              <button
                type="button"
                className={side === "client" ? "active" : undefined}
                onClick={() => switchSide("client")}
              >
                Client
              </button>
              <button
                type="button"
                className={side === "server" ? "active" : undefined}
                onClick={() => switchSide("server")}
                disabled={!hasServer && graph.schemaVersion === 1}
                title={
                  hasServer || graph.schemaVersion === 2
                    ? "Server / RSC JS attribution"
                    : "Rebuild viz graph for server side (schema v2)"
                }
              >
                Server
              </button>
            </div>
            <div className="seg" role="group" aria-label="View mode">
              <button
                type="button"
                className={view === "importers" ? "active" : undefined}
                onClick={() => setView("importers")}
              >
                Sorted files
              </button>
              <button
                type="button"
                className={view === "tree" ? "active" : undefined}
                onClick={() => setView("tree")}
              >
                Tree
              </button>
            </div>
            {view === "importers" ? (
              <label className="check">
                <input
                  type="checkbox"
                  checked={appOnly}
                  onChange={(e) => setAppOnly(e.target.checked)}
                />
                App files only
              </label>
            ) : null}
          </div>
        ) : null}
      </header>

      {!graph ? (
        <p className="empty empty-hero">
          No graph loaded. Use <strong>Copy prompt</strong> in your editor, then{" "}
          <strong>Open local file</strong> with <code>.wimb/bundle-graph.json</code>.
        </p>
      ) : (
        <div className="layout">
          <aside className="sidebar">
            <h2>Routes</h2>
            <ul className="route-list">
              {bundle.routes.map((r) => (
                <li key={r.route}>
                  <button
                    type="button"
                    className={r.route === selected ? "active" : undefined}
                    onClick={() => setSelected(r.route)}
                  >
                    <span className="route-name">{r.route}</span>
                    <span className="route-bytes">{formatBytes(r.totalBytes)}</span>
                  </button>
                </li>
              ))}
            </ul>

            {sharedHotspots.length > 0 ? (
              <>
                <h2>Shared hotspots</h2>
                <ul className="hotspots">
                  {sharedHotspots.map((h) => (
                    <li key={h.path}>
                      <strong>{h.label}</strong>
                      <span>
                        {formatBytes(h.maxBytes)} · {h.routeCount} routes
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </aside>

          <main className="main">
            {view === "importers" ? (
              <>
                <p className="hint">
                  Sorted by <strong>pulls in</strong> — import-graph closure weight on{" "}
                  <code>{selected}</code> ({side}). Expand a row to see the heaviest modules that
                  file drags in.
                </p>
                <ImporterTable rows={importers} />
              </>
            ) : (
              <>
                <div className="cols">
                  <span>Module</span>
                  <span>Self</span>
                  <span>Subtree</span>
                  <span>Routes</span>
                  <span>% of route</span>
                </div>
                {tree ? (
                  <ul className="forest">
                    <TreeNodeRow node={tree} depth={0} routeTotal={routeTotal || 1} />
                  </ul>
                ) : (
                  <p className="empty">No tree for this route on the {side} side.</p>
                )}
              </>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

function walk(node: TreeNodeLike, visit: (n: TreeNodeLike) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

interface TreeNodeLike {
  kind: string;
  label: string;
  path?: string;
  selfBytes: number;
  routeCount: number;
  children: TreeNodeLike[];
}

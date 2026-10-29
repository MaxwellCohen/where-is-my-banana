"use client";

import { useMemo, useState } from "react";
import { rankImporters } from "@/lib/importers";
import { loadGraphFromFile } from "@/lib/load-graph";
import type { BundleSide, VizGraph, VizSide } from "@/lib/types";
import { formatBytes } from "@/lib/format";
import { TreeNodeRow } from "./TreeNodeRow";
import { ImporterTable } from "./ImporterTable";
import { CopyPromptButton } from "./CopyPromptButton";
import { WinsPanel } from "./WinsPanel";
import { TreemapView } from "./charts/TreemapView";
import { IcicleView } from "./charts/IcicleView";
import { SunburstView } from "./charts/SunburstView";
import { RouteGraph } from "./charts/RouteGraph";
import { RoutesChart } from "./charts/RoutesChart";
import { findNode } from "@/lib/viz-layout";
import {
  firstLoadBytes,
  loadWinsFromFile,
  safeSavings,
  winsForRoute,
  type WinsReport,
} from "@/lib/wins";

type ViewMode = "importers" | "tree" | "treemap" | "icicle" | "sunburst" | "ornaments" | "routes";

const VIEWS: { id: ViewMode; label: string }[] = [
  { id: "importers", label: "Sorted files" },
  { id: "tree", label: "Tree" },
  { id: "treemap", label: "Treemap" },
  { id: "icicle", label: "Icicle" },
  { id: "sunburst", label: "Sunburst" },
  { id: "ornaments", label: "Graph" },
  { id: "routes", label: "Routes" },
];

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
  const [wins, setWins] = useState<WinsReport | null>(null);
  const [winId, setWinId] = useState<string | null>(null);
  const [onlyWins, setOnlyWins] = useState(false);
  const [zoomId, setZoomId] = useState<string | null>(null);

  const bundle = useMemo(
    () => (graph ? sideBundle(graph, side) : { routes: [], trees: {} }),
    [graph, side],
  );
  const tree = bundle.trees[selected];
  const routeTotal = tree?.totalBytes ?? 0;
  const zoomRoot = (tree && zoomId ? findNode(tree, zoomId) : null) ?? tree;

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

  function selectRoute(route: string) {
    setSelected(route);
    setZoomId(null);
  }

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

  async function onWins(file: File | null) {
    if (!file) return;
    setError(null);
    try {
      setWins(await loadWinsFromFile(file));
      setWinId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const routeWins = winsForRoute(wins, selected);
  const sortedWins = [...routeWins].sort((a, b) => b.totalSavedBytes - a.totalSavedBytes);
  const activeWin = wins?.wins.find((w) => w.id === winId) ?? null;
  const hl = activeWin ? { target: activeWin.edge.imported, chain: activeWin.chain } : null;
  const visibleRoutes =
    wins && onlyWins ? bundle.routes.filter((r) => winsForRoute(wins, r.route).length > 0) : bundle.routes;
  const flBytes = firstLoadBytes(wins, selected);
  const saveBytes = safeSavings(wins, selected);

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
          <label className="upload-btn">
            {wins ? `wins.json (${wins.wins.length})` : "Open wins.json"}
            <input
              type="file"
              accept=".json"
              onChange={(e) => void onWins(e.target.files?.[0] ?? null)}
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
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className={view === v.id ? "active" : undefined}
                  onClick={() => setView(v.id)}
                >
                  {v.label}
                </button>
              ))}
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
            {wins ? (
              <label className="check">
                <input
                  type="checkbox"
                  checked={onlyWins}
                  onChange={(e) => setOnlyWins(e.target.checked)}
                />
                Only routes with wins
              </label>
            ) : null}
            <ul className="route-list">
              {visibleRoutes.map((r) => (
                <li key={r.route}>
                  <button
                    type="button"
                    className={r.route === selected ? "active" : undefined}
                    onClick={() => selectRoute(r.route)}
                  >
                    <span className="route-name">{r.route}</span>
                    <span className="route-bytes">{formatBytes(r.totalBytes)}</span>
                  </button>
                </li>
              ))}
            </ul>

            {wins ? (
              <>
                <h2>Top wins{routeWins.length ? ` · ${selected}` : ""}</h2>
                <WinsPanel wins={sortedWins} selectedId={winId} onSelect={setWinId} />
              </>
            ) : null}

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
            {wins ? (
              <div className="route-head">
                <strong>{selected}</strong>
                <span>
                  first load: {flBytes !== undefined ? formatBytes(flBytes) : "n/a"}
                </span>
                <span className="save">safe savings available: {formatBytes(saveBytes)}</span>
              </div>
            ) : null}
            {view === "importers" ? (
              <>
                <p className="hint">
                  Sorted by <strong>pulls in</strong> — import-graph closure weight on{" "}
                  <code>{selected}</code> ({side}). Expand a row to see the heaviest modules that
                  file drags in.
                </p>
                <ImporterTable rows={importers} />
              </>
            ) : view === "ornaments" ? (
              <RouteGraph
                routes={visibleRoutes}
                trees={bundle.trees}
                selected={selected}
                onSelect={selectRoute}
              />
            ) : view === "routes" ? (
              <RoutesChart routes={visibleRoutes} selected={selected} onSelect={selectRoute} />
            ) : view === "treemap" || view === "icicle" || view === "sunburst" ? (
              zoomRoot ? (
                <>
                  <div className="crumbs">
                    <span>
                      {zoomRoot.label} · {formatBytes(zoomRoot.totalBytes)}
                    </span>
                    {zoomId && zoomRoot !== tree ? (
                      <button type="button" onClick={() => setZoomId(null)}>
                        Reset zoom
                      </button>
                    ) : null}
                    <span>Click a block to zoom in; hover for details. Slices under 0.4% hidden.</span>
                  </div>
                  {view === "treemap" ? (
                    <TreemapView root={zoomRoot} onZoom={(n) => setZoomId(n.id)} />
                  ) : view === "icicle" ? (
                    <IcicleView root={zoomRoot} onZoom={(n) => setZoomId(n.id)} />
                  ) : (
                    <SunburstView root={zoomRoot} onZoom={(n) => setZoomId(n.id)} />
                  )}
                </>
              ) : (
                <p className="empty">No tree for this route on the {side} side.</p>
              )
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
                    <TreeNodeRow node={tree} depth={0} routeTotal={routeTotal || 1} hl={hl} />
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

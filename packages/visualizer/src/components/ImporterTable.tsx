"use client";

import { useState } from "react";
import type { ImporterRow } from "@/lib/types";
import { formatBytes } from "@/lib/format";
import { DepInfoBadges, ImporterInfoBadges } from "./Badges";

interface Props {
  rows: ImporterRow[];
}

export function ImporterTable({ rows }: Props) {
  const [open, setOpen] = useState<string | null>(rows[0]?.path ?? null);

  if (rows.length === 0) {
    return <p className="empty">No matching files for this filter.</p>;
  }

  return (
    <div className="importer-wrap">
      <div className="importer-cols">
        <span>Your file</span>
        <span>Self</span>
        <span>Pulls in</span>
        <span>Routes</span>
      </div>
      <ul className="importer-list">
        {rows.map((row) => {
          const expanded = open === row.path;
          const hasDeps = (row.topDeps?.length ?? 0) > 0;
          return (
            <li key={row.path} className={expanded ? "expanded" : undefined}>
              <button
                type="button"
                className="importer-row"
                title={row.path}
                aria-expanded={hasDeps ? expanded : undefined}
                onClick={() => setOpen(expanded ? null : row.path)}
              >
                <span className="importer-name">
                  <span className="tree-toggle" aria-hidden>
                    {hasDeps ? (expanded ? "▾" : "▸") : "·"}
                  </span>
                  <span className="importer-label-block">
                    <span className="importer-label-line">
                      {row.label}
                      {row.appFile ? <span className="badge app">app</span> : null}
                    </span>
                    <ImporterInfoBadges
                      badges={row.badges}
                      shared={(row.badges?.routes ?? row.routeCount) > 1}
                    />
                  </span>
                </span>
                <span className="importer-metric">{formatBytes(row.selfBytes)}</span>
                <span className="importer-metric strong">{formatBytes(row.pullBytes)}</span>
                <span className="importer-metric">{row.routeCount}</span>
              </button>
              {expanded && hasDeps ? (
                <ul className="dep-list">
                  {row.topDeps!.map((dep) => (
                    <li key={dep.path} title={dep.path}>
                      <span className="dep-main">
                        <span className="dep-label">{dep.label}</span>
                        <DepInfoBadges
                          reach={dep.reach}
                          kind={dep.kind}
                          routeCount={dep.routeCount}
                        />
                      </span>
                      <span className="dep-bytes">{formatBytes(dep.bytes)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

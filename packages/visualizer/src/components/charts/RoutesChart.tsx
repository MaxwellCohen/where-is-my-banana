"use client";

import { formatBytes } from "@/lib/format";
import type { RouteSummary } from "@/lib/types";

export function RoutesChart({
  routes,
  selected,
  onSelect,
}: {
  routes: RouteSummary[];
  selected: string;
  onSelect: (route: string) => void;
}) {
  const sorted = [...routes].sort((a, b) => b.totalBytes - a.totalBytes);
  const max = sorted[0]?.totalBytes || 1;
  return (
    <ul className="bars">
      {sorted.map((r) => (
        <li key={r.route}>
          <button type="button" className={r.route === selected ? "active" : undefined} onClick={() => onSelect(r.route)}>
            <span className="bar-label">{r.route}</span>
            <span className="bar-track">
              <span className="bar-fill" style={{ width: `${(r.totalBytes / max) * 100}%` }} />
            </span>
            <span className="bar-value">
              {formatBytes(r.totalBytes)} · {r.moduleCount} mods
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

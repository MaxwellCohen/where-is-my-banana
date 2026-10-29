"use client";

import { useState } from "react";
import { formatBytes } from "@/lib/format";
import { editPrompt, type Win } from "@/lib/wins";

interface Props {
  wins: Win[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function WinsPanel({ wins, selectedId, onSelect }: Props) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(w: Win) {
    try {
      await navigator.clipboard.writeText(editPrompt(w));
      setCopied(w.id);
      setTimeout(() => setCopied((c) => (c === w.id ? null : c)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  if (wins.length === 0) return <p className="empty">No wins for this view.</p>;

  return (
    <ul className="wins-list">
      {wins.map((w) => {
        const active = w.id === selectedId;
        const routes = Object.keys(w.routes);
        return (
          <li key={w.id} className={active ? "win active" : "win"}>
            <button type="button" className="win-head" onClick={() => onSelect(active ? null : w.id)}>
              <span className="win-bytes">{formatBytes(w.totalSavedBytes)}</span>
              <span className="badge fix">{w.fixKind}</span>
              <span
                className={`badge safety ${w.safety === "safe" ? "safe" : "review"}`}
                title={w.safetyReasons.length ? w.safetyReasons.join(", ") : w.safety}
              >
                {w.safety}
              </span>
            </button>
            <div className="win-loc">
              {w.edge.importer}
              {w.loc ? `:${w.loc.line}` : ""} → {w.edge.imported}
            </div>
            <div className="win-routes" title={routes.join(", ")}>
              {routes.length} route{routes.length === 1 ? "" : "s"}: {routes.slice(0, 3).join(", ")}
              {routes.length > 3 ? "…" : ""}
            </div>
            <button type="button" className="win-copy" onClick={() => void copy(w)}>
              {copied === w.id ? "Copied" : "Copy edit"}
            </button>
            {active ? (
              <ol className="win-chain">
                {w.chain.map((c, i) => (
                  <li key={`${i}:${c}`}>{c}</li>
                ))}
              </ol>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

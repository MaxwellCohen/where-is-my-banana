"use client";

import type { DepKind, DepReach, ImporterBadges } from "@/lib/types";

export function ImporterInfoBadges({
  badges,
  shared,
}: {
  badges?: ImporterBadges;
  shared?: boolean;
}) {
  if (!badges) return null;
  return (
    <span className="badge-row">
      {badges.routes > 0 ? (
        <span className="badge use" title="Routes where this file's import closure contributes">
          {badges.routes}× use
        </span>
      ) : null}
      {shared || badges.routes > 1 ? (
        <span className="badge shared" title="Used across multiple routes">
          shared
        </span>
      ) : null}
      {badges.sync > 0 ? (
        <span className="badge sync" title="Direct sync imports">
          {badges.sync} sync
        </span>
      ) : null}
      {badges.async > 0 ? (
        <span className="badge async" title="Direct async / dynamic imports">
          {badges.async} async
        </span>
      ) : null}
      {badges.modules > 0 ? (
        <span className="badge mods" title="Attributed modules in import closure">
          {badges.modules} mods
        </span>
      ) : null}
      {badges.packages > 0 ? (
        <span className="badge pkgs" title="Unique packages in import closure">
          {badges.packages} pkgs
        </span>
      ) : null}
    </span>
  );
}

export function DepInfoBadges({
  reach,
  kind,
  routeCount,
}: {
  reach?: DepReach;
  kind?: DepKind;
  routeCount?: number;
}) {
  return (
    <span className="badge-row">
      {reach === "async" || reach === "both" ? (
        <span className="badge async" title="Reached via async/dynamic import">
          {reach === "both" ? "sync+async" : "async"}
        </span>
      ) : reach === "sync" ? (
        <span className="badge sync" title="Reached via sync import">
          sync
        </span>
      ) : null}
      {kind && kind !== "other" ? (
        <span className={`badge kind-${kind}`} title={`Dependency kind: ${kind}`}>
          {kind}
        </span>
      ) : null}
      {routeCount && routeCount > 1 ? (
        <span className="badge use" title="Routes attributing this module">
          {routeCount}× use
        </span>
      ) : null}
    </span>
  );
}

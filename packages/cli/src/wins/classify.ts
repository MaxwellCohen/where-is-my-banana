import { readFile } from "node:fs/promises";
import { isAppSourcePath } from "@wimb/graph-v1";
import { join } from "node:path";
import { loadDataTables } from "../data/index.js";
import { loadReplacements } from "../external/module-replacements.js";
import { analyzeImportUsage, moduleFacts, type ImportUsage } from "./usage-analyze.js";
import type {
  EdgeCut,
  FixKind,
  RouteAttribution,
  SafetyReason,
  UsageKind,
  Win,
  WinEdit,
} from "./types.js";

export interface ClassifyContext {
  projectRoot: string;
  byteSource: "measured" | "estimated";
}

const DROP_BELOW_BYTES = 10 * 1024;

interface Group {
  cut: EdgeCut;
  routes: Record<string, number>;
}

/**
 * Merge identical (importer, imported) edges across routes.
 * routes[route] = max uniqueBytes seen for that route; totalSavedBytes = max over routes
 * (a shared chunk is downloaded once, so fixing all routes can't save more than the largest single-route saving
 * when the chunk is shared; this is a conservative lower bound versus summing).
 */
function mergeEdges(attributions: RouteAttribution[]): Group[] {
  const groups = new Map<string, Group>();
  for (const attr of attributions) {
    for (const cut of attr.edges) {
      if (!isAppSourcePath(cut.edge.importer)) continue;
      if (cut.edge.packageName && FRAMEWORK.has(cut.edge.packageName)) continue;
      const key = `${cut.edge.importer}\0${cut.edge.imported}`;
      let g = groups.get(key);
      if (!g) {
        g = { cut, routes: {} };
        groups.set(key, g);
      } else if (cut.chain.length < g.cut.chain.length) {
        g.cut = { ...cut, loc: cut.loc ?? g.cut.loc };
      }
      g.routes[attr.route] = Math.max(g.routes[attr.route] ?? 0, cut.uniqueBytes);
    }
  }
  return dedupeChains([...groups.values()]);
}

/** Packages the app can't meaningfully cut (framework runtime). */
const FRAMEWORK = new Set(["next", "react", "react-dom", "scheduler"]);

const CHAIN_TOLERANCE = 0.05;

/**
 * Chain dedupe: if edge A (ancestor) lies on the import chain leading to edge B (descendant) in a
 * shared route, and B saves within 5% of A's bytes, cutting either saves the same thing, so keep
 * only the deepest (B) and drop A. If A saves meaningfully more than B (>5%), keep both.
 */
function dedupeChains(groups: Group[]): Group[] {
  const isPrefix = (a: string[], b: string[]) => a.length < b.length && a.every((x, i) => x === b[i]);
  const total = (g: Group) => Math.max(0, ...Object.values(g.routes));
  return groups.filter((a) => {
    const ta = total(a);
    return !groups.some(
      (b) =>
        b !== a &&
        isPrefix(a.cut.chain, b.cut.chain) &&
        Object.keys(a.routes).some((r) => r in b.routes) &&
        total(b) >= ta * (1 - CHAIN_TOLERANCE),
    );
  });
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

const isIdent = (s: string) => /^[A-Za-z_$][\w$]*$/.test(s);

function dynamicDecls(u: ImportUsage, opts: string): string[] {
  return u.bindings.map((b) => {
    const importExpr =
      b.kind === "default"
        ? `import('${u.specifier}')`
        : b.kind === "named"
          ? `import('${u.specifier}').then((m) => m.${isIdent(b.imported) ? b.imported : `["${b.imported}"]`})`
          : `import('${u.specifier}')`;
    return `const ${b.local} = dynamic(() => ${importExpr}, ${opts});`;
  });
}

function handlerImport(u: ImportUsage): string {
  return u.bindings
    .map((b) =>
      b.kind === "default"
        ? `const { default: ${b.local} } = await import('${u.specifier}');`
        : b.kind === "named"
          ? `const { ${b.imported === b.local ? b.local : `${b.imported}: ${b.local}`} } = await import('${u.specifier}');`
          : `const ${b.local} = await import('${u.specifier}');`,
    )
    .join("\n");
}

export async function classifyWins(
  attributions: RouteAttribution[],
  ctx: ClassifyContext,
): Promise<Win[]> {
  const data = loadDataTables();
  const replacements = loadReplacements();
  const groups = mergeEdges(attributions);

  // importer-independent index: imported -> set of (group key, routes) for shared-with-eager detection
  const byImported = new Map<string, Group[]>();
  for (const g of groups) {
    const arr = byImported.get(g.cut.edge.imported) ?? [];
    arr.push(g);
    byImported.set(g.cut.edge.imported, arr);
  }

  const wins: Win[] = [];
  for (const g of groups) {
    const { edge } = g.cut;
    const routeNames = Object.keys(g.routes);
    const total = Math.max(0, ...Object.values(g.routes));

    const importerAbs = join(ctx.projectRoot, edge.importer);
    const importerSrc = edge.importer.startsWith("node_modules/") ? null : await readText(importerAbs);
    const u: ImportUsage | null = importerSrc ? analyzeImportUsage(edge.importer, importerSrc, edge) : null;

    const usage: UsageKind = u?.found ? u.usage : "unknown";
    const reasons = new Set<SafetyReason>();
    const isPackage = !!edge.packageName;

    // imported-module facts (local files only)
    let facts: ReturnType<typeof moduleFacts> | null = null;
    if (!isPackage) {
      const src = await readText(join(ctx.projectRoot, edge.imported));
      if (src) {
        try {
          facts = moduleFacts(edge.imported, src);
        } catch {
          facts = null;
        }
      }
    }

    const isRemove = !!u?.found && u.unused && u.bindings.length > 0;
    const namedFromRoot =
      isPackage &&
      !!u?.found &&
      u.specifier === edge.packageName &&
      u.bindings.some((b) => b.kind === "named");
    const swapTarget = isPackage ? replacements.get(edge.packageName!) : undefined;
    const isHeavy = isPackage && data.heavyPackages.has(edge.packageName!);
    const deferredUse = usage === "conditional-render" || usage === "event-handler-only";

    let fixKind: FixKind | null = null;
    if (isRemove) fixKind = "remove";
    else if (namedFromRoot && data.barrelPackages.has(edge.packageName!)) fixKind = "deep-import";
    else if (isPackage && (isHeavy || swapTarget) && !deferredUse) fixKind = "swap-package";
    else if (
      !isPackage &&
      u?.found &&
      u.isClient &&
      facts &&
      !facts.isClient &&
      facts.signals.hooks.length === 0 &&
      facts.signals.eventHandlers.length === 0 &&
      facts.signals.browserGlobals.length === 0 &&
      (usage === "always-rendered" || usage === "unknown")
    )
      fixKind = "move-to-server";
    else if (deferredUse) fixKind = "lazy";

    const determined = fixKind !== null;
    if (!fixKind) {
      if (usage === "unknown" && total < DROP_BELOW_BYTES) continue;
      fixKind = "lazy";
    }

    // safety reasons
    if (fixKind === "lazy") {
      if (usage === "always-rendered" && u?.isPageOrLayout) reasons.add("above-the-fold");
      if (usage === "always-rendered") reasons.add("needs-ssr");
      if (u?.found && u.inSuspense) reasons.add("already-in-suspense");
      if (u?.found && u.bindings.some((b) => b.kind === "named")) reasons.add("named-export");
      if (facts && !facts.hasDefault) reasons.add("no-default-export");
    }
    if (usage === "unknown" && fixKind !== "remove") reasons.add("unresolved-usage");
    if (!determined && usage === "always-rendered" && !u?.isPageOrLayout) reasons.add("needs-ssr");
    const others = (byImported.get(edge.imported) ?? []).filter(
      (o) => o !== g && o.cut.edge.importer !== edge.importer && routeNames.some((r) => r in o.routes),
    );
    if (others.length > 0) reasons.add("shared-with-eager-route");

    const edit = buildEdit(fixKind, usage, u, edge, ctx, routeNames, swapTarget?.replacement);
    wins.push({
      id: `${fixKind}:${edge.importer}:${edge.imported}`,
      fixKind,
      safety: reasons.size === 0 ? "safe" : "needs-review",
      safetyReasons: [...reasons],
      usage,
      edge,
      loc: g.cut.loc,
      usageLoc: u?.usageLoc,
      routes: g.routes,
      totalSavedBytes: total,
      byteSource: ctx.byteSource,
      chain: g.cut.chain,
      edit,
    });
  }

  wins.sort(
    (a, b) =>
      b.totalSavedBytes - a.totalSavedBytes ||
      (a.safety === b.safety ? 0 : a.safety === "safe" ? -1 : 1) ||
      a.id.localeCompare(b.id),
  );
  return wins;
}

function buildEdit(
  fixKind: FixKind,
  usage: UsageKind,
  u: ImportUsage | null,
  edge: Win["edge"],
  ctx: ClassifyContext,
  routes: string[],
  replacement: string | undefined,
): WinEdit {
  const target = edge.packageName ?? edge.imported;
  const verify = `pnpm exec wimb wins --cwd ${JSON.stringify(ctx.projectRoot)} --compare  # rebuild + compare routes: ${routes.join(", ")}`;
  const original = u?.found ? u.originalImport : undefined;
  const file = edge.importer;
  const names = u?.bindings.map((b) => b.local).join(", ") ?? "";

  switch (fixKind) {
    case "remove":
      return {
        summary: `Remove unused import of ${target} from ${file}`,
        originalImport: original,
        steps: [`Delete the import of ${target} in ${file}.`, "Remove any now-unused dependency from package.json."],
        verify,
      };
    case "deep-import":
      return {
        summary: `Import ${names} from ${target} subpaths instead of the package root`,
        originalImport: original,
        replacementImport: `import X from '${target}/<symbol-path>'`,
        steps: [
          `In ${file}, replace the root import of ${target} with per-symbol deep imports.`,
          "Check the package's exports map for the correct subpath.",
        ],
        verify,
      };
    case "swap-package":
      return {
        summary: replacement
          ? `Replace ${target} with ${replacement}`
          : `Replace heavy package ${target} with a lighter alternative`,
        originalImport: original,
        replacementImport: replacement ? `// use ${replacement}` : undefined,
        steps: [
          replacement
            ? `Replace usages of ${target} in ${file} with ${replacement}.`
            : `Pick a lighter alternative to ${target} (or a smaller entrypoint) and update ${file}.`,
          `Remove ${target} from package.json if no other importers remain.`,
        ],
        verify,
      };
    case "move-to-server":
      return {
        summary: `Render ${edge.imported} from a Server Component instead of the "use client" file ${file}`,
        originalImport: original,
        steps: [
          `${edge.imported} uses no hooks, handlers or browser globals.`,
          `Move the render of ${names} to a parent Server Component and pass it into ${file} as children/props.`,
        ],
        verify,
      };
    case "lazy": {
      if (!u?.found || u.bindings.length === 0) {
        return {
          summary: `Defer loading of ${target} from ${file}`,
          originalImport: original,
          steps: [`Load ${target} lazily in ${file} (next/dynamic or dynamic import()).`],
          verify,
        };
      }
      if (usage === "event-handler-only") {
        return {
          summary: `Load ${target} on demand inside the handler in ${file}`,
          originalImport: original,
          replacementImport: handlerImport(u),
          steps: [
            `Remove the static import in ${file}.`,
            "Make the handler async and add the dynamic import at its start.",
            "Use the destructured bindings after the await.",
          ],
          verify,
        };
      }
      const ssrFalse = usage !== "always-rendered" && (u.isClient || !u.isPageOrLayout);
      const opts = ssrFalse ? "{ ssr: false, loading: () => null }" : "{ loading: () => null }";
      const stepsNamed = u.bindings.some((b) => b.kind === "named");
      return {
        summary: `Lazy-load ${target} with next/dynamic in ${file}`,
        originalImport: original,
        replacementImport: [`import dynamic from 'next/dynamic';`, ...dynamicDecls(u, opts)].join("\n"),
        steps: [
          `Replace the static import in ${file} with the next/dynamic form.`,
          ...(stepsNamed ? ["Named export: the .then(m => m.X) mapping selects the export."] : []),
          ssrFalse
            ? "ssr:false is safe because the component renders only conditionally."
            : "Keep SSR enabled (above-the-fold content); consider a sized loading placeholder to avoid layout shift.",
          "Confirm no layout shift when the component appears.",
        ],
        verify,
      };
    }
  }
}

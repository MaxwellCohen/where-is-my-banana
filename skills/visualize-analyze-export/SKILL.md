---
name: visualize-analyze-export
description: >-
  Capture next analyze export (graph-v1 JSONL), build a route-rooted client
  import tree with bytes and route usage counts, and open the WIMB Next.js
  bundle visualizer. Use when exploring Next 16.4+ bundle analyzer output
  as a tree instead of only flat byte maps.
---

# Visualize Analyze Export

Turn Next.js 16.4+ `next analyze export` into an interactive route → imports tree.

## Prerequisites

- Target app uses Turbopack-compatible `next experimental-analyze` / `next analyze` (no app upgrade required for the binary path).
- Optional: Next.js ≥ 16.4 for `next analyze export` JSONL (richer module-ident graph).

## Capture pipeline (no app upgrade)

Works on Next that still ships `experimental-analyze` only (e.g. early 16.4 canaries):

```bash
# In the target app — does not change package.json
pnpm exec next experimental-analyze --output
# artifacts → .next/diagnostics/analyze/data/
```

Then from WIMB:

```bash
node packages/cli/dist/index.js viz build --cwd /path/to/app -o /path/to/app/.wimb/bundle-graph.json
```

## Capture pipeline (Next 16.4+ export, optional)

When `next/analyze/graph-v1.schema.json` exists:

```bash
set -o pipefail
pnpm exec next analyze --output --snapshot "viz-$(date +%s)"
pnpm exec next analyze export --snapshot "<name>" | gzip > /tmp/bundle-graph.jsonl.gz
```

```bash
pnpm exec wimb viz build --analyze-export /tmp/bundle-graph.jsonl.gz -o .wimb/bundle-graph.json
# optional: --async to include dynamic import edges
```

- Custom `distDir`: pass `--dist-dir` on capture and on `wimb viz build`.
- Prefer **binary path** when you must not bump the app’s `next` version.

## Open the visualizer

```bash
pnpm viz                 # http://localhost:3340 (hot reload)
pnpm viz:demo            # refresh demo-graph.json from next-books / WIMB_VIZ_SOURCE
pnpm viz:watch           # also watch @wimb/graph-v1
```

Demo data loads by default. Use **Load analyze export** to upload `.jsonl`, `.jsonl.gz`, or a prebuilt `.wimb/bundle-graph.json`. Details: `packages/visualizer/README.md`.

## How to read the tree

- **Root**: normalized App Router route (e.g. `/`, `/about`).
- **Child**: static import (`module.dependencies.sync`); pass `--async` on `wimb viz build` for dynamic imports.
- **Self / Subtree**: attributed client JS bytes from `part` records (`[client-fs]/…/*.js` only).
- **Routes**: number of routes whose client attribution includes this module/path — high count + high bytes = shared “jungle” modules.

## Interpretation rules

- Join modules by **`ident`**, display **`path`** — paths are not unique keys.
- Do not treat `traced` as client bundle unless you pass `--traced`.
- Bytes ≠ gzip on the wire; use for **relative** ranking, not transfer SLAs.

## Cross-links

- Flat audit + rules: `skills/scan-client-bloat` (`wimb scan --analyze-export`).
- Next’s optimizer skill: `npx skills add vercel/next.js --skill next-bundle-optimizer` after you identify hotspots in the tree.

# @wimb/visualizer

Next.js UI for WIMB route-rooted bundle forests (client/server, sorted importers, tree).

## Dev server

From the monorepo root:

```bash
pnpm viz
```

Opens **http://localhost:3340** (bound to `0.0.0.0` for remote/T3 previews).

Hot-reloads `packages/visualizer/src/**`. The UI starts blank until you **Open local file**.

### Also rebuild `@wimb/graph-v1` while editing parsers/types

```bash
pnpm viz:watch
```

### Build a local forest to open in the UI

```bash
pnpm build
pnpm viz:demo       # writes packages/visualizer/public/demo-graph.json (local only; not deployed)
# or point at any app:
WIMB_VIZ_SOURCE=/path/to/app pnpm viz:demo
```

Then use **Open local file** on that JSON (or any `.wimb/bundle-graph.json`).

## Privacy (hosted)

The page loads with no graph. Graphs are parsed entirely in the browser — no upload API. Sample forests are excluded from Vercel deploys (`.vercelignore`).

## Deploy to Vercel

Project: **wimb-visualizer** · root directory `packages/visualizer` · production https://wimb-visualizer.vercel.app

Deploy from the **monorepo root**:

```bash
# once
cd packages/visualizer && vercel link --yes --project wimb-visualizer
vercel project update wimb-visualizer --root-directory packages/visualizer --yes

# ship
cd ../..   # repo root
vercel deploy --prod --yes --scope maxs-projects-e09fe1c2 --project wimb-visualizer
```

`vercel.json` installs from the repo root and builds `@wimb/graph-v1` before Next.

---
name: reduce-client-js
description: >-
  Cut first-load client JS in a Next.js App Router app with the `wimb wins`
  loop: build the graph, take the top safe win from .wimb/wins.json, apply its
  edit, rebuild, confirm the byte delta, repeat. Use when asked to shrink the
  client bundle, reduce first-load JS, or act on wimb output.
---

# Reduce Client JS

One loop: measure, pick the top safe win, edit, re-measure, keep or revert.

## 1. Obtain the graph

```bash
pnpm exec next analyze --output --snapshot wins   # Next 16.4+
pnpm exec next analyze export --snapshot wins > .wimb/graph.jsonl
cp .wimb/wins.json .wimb/wins.prev.json 2>/dev/null   # baseline for step 4
pnpm exec wimb wins --cwd . --analyze-export .wimb/graph.jsonl
```

- Pipe through `gzip` and pass `.jsonl.gz` if preferred. Custom `distDir`: `--dist-dir`; named snapshot: `--snapshot wins`.
- No export available: `wimb wins` falls back to estimated bytes (`byteSource: "estimated"`); treat ranking as relative only.
- No local checkout: see `skills/run-wimb-npx`.
- Optional tree view: `skills/visualize-analyze-export`.

## 2. Pick a win

Read `.wimb/wins.json` (`WinsReport`). Wins are sorted by `totalSavedBytes` desc. Take the first with `safety: "safe"`. Skip `needs-review` for now.

## 3. Apply the edit

Use `win.edit`: `originalImport` is the line to replace, `replacementImport` the new code, `steps` the ordered instructions. Open `edge.importer` at `loc.line` first.

Per `fixKind`:
- `lazy`: replace the static import with `next/dynamic` (`ssr: false` only if the component is not needed for first paint).
- `move-to-server`: remove `'use client'` or move the logic into a server component; pass data as props.
- `swap-package`: replace the dependency with the lighter one named in `steps`; update imports.
- `deep-import`: import from the subpath instead of the barrel.
- `remove`: delete the unused import and, if now unused, the dependency.

Edge cases:
- **Named exports** (`named-export`): `dynamic(() => import('./X').then(m => m.X))`.
- **No default export** (`no-default-export`): same `.then(m => m.X)` mapping; do not add a default export just for this.
- **Event-handler-only** (`usage: "event-handler-only"`): do not use `next/dynamic`; load inside the handler with `const { X } = await import('pkg')`.
- **Conditional render**: keep the condition; dynamic import goes at module top level, not inside the component.

### Never edit `needs-review` without checking `safetyReasons`

| Reason | Meaning | Check before editing |
|---|---|---|
| `above-the-fold` | Rendered unconditionally near the top of a page/layout | Lazy loading will hurt LCP/CLS. Only proceed if a `loading` placeholder keeps layout stable, or skip. |
| `needs-ssr` | Likely needed for first paint or SEO | Do not use `ssr: false`. Use `dynamic` with SSR on, or skip. |
| `named-export` | `next/dynamic` needs `.then(m => m.X)` | Mechanical; confirm the export name. |
| `no-default-export` | Module has no default export | Same mapping as above. |
| `already-in-suspense` | Already under a Suspense boundary | Likely already deferred; confirm the import is actually still sync in the graph before changing. |
| `shared-with-eager-route` | Another route imports it eagerly | Saving is partial. Check `routes` and whether those routes can change too; expect a smaller delta. |
| `unresolved-usage` | No JSX or handler usage found | Open the file and find real usages (re-exports, props, refs) by hand. If unclear, skip. |

## 4. Verify

```bash
pnpm exec next build            # then re-run the analyze/export commands from step 1
pnpm exec wimb wins --cwd . --analyze-export .wimb/graph.jsonl --compare .wimb/wins.prev.json
pnpm exec tsc --noEmit && pnpm test
```

Confirm the targeted win is gone (or smaller) and the byte delta is positive and close to `totalSavedBytes`. Also confirm no other route's `firstLoadBytes` grew and typecheck and tests pass. Run `win.edit.verify` if present.

If the delta is not realized, or anything regressed: `git checkout -- <files>` and move to the next win. Then `cp .wimb/wins.json .wimb/wins.prev.json` before the next iteration.

## 5. Stop when

- no `safety: "safe"` wins remain, or
- the top safe win saves under 5 KB (`totalSavedBytes < 5120`).

Report remaining `needs-review` wins with their `safetyReasons`; do not apply them unprompted.

## JSON cheat-sheet (`.wimb/wins.json`)

| Field | Meaning |
|---|---|
| `byteSource` | `measured` (analyze export) or `estimated` |
| `routes[]` | `{route, firstLoadBytes}` compressed first-load JS per route |
| `wins[].id` | `${fixKind}:${importer}:${imported}` |
| `fixKind` | `lazy` / `move-to-server` / `swap-package` / `deep-import` / `remove` |
| `safety`, `safetyReasons` | `safe` or `needs-review` plus why |
| `usage` | `conditional-render` / `event-handler-only` / `always-rendered` / `unknown` |
| `edge` | `{importer, imported, packageName}` the import to cut |
| `loc`, `usageLoc` | line/column of the import and of the binding's use |
| `routes` (on a win) | route to bytes saved by cutting this edge |
| `totalSavedBytes` | bytes saved if all listed routes are fixed |
| `chain` | route entry to imported module |
| `edit` | `summary`, `originalImport`, `replacementImport`, `steps`, `verify` |

Legacy source-scan findings (`wimb scan`): `skills/fix-client-bloat`.

# Where Is My Banana (WIMB)

>“… Because the problem with object-oriented languages is they’ve got all this implicit environment that they carry around with them. You wanted a banana but what you got was a gorilla holding the banana and the entire jungle. “ —Joe Armstrong, creator of Erlang progamming language

WIMB finds the import edges ("wins") that, if cut or made lazy, shrink your Next.js App Router first-load client JS the most, and tells an agent exactly how to cut them.

## Quick start (run from GitHub)

Needs Node >= 20 and a Next.js App Router app on **Next 16.4+** (Turbopack).

```bash
cd your-next-app
npx @maxwellcohen/wimb wins --cwd .
```

This runs `next analyze --output --snapshot wins` for you, then ranks the wins. Pass `--no-analyze` to reuse existing analyze data.

Outputs `.wimb/wins.json` (machine) and `.wimb/wins.md` (human). Add `.wimb/` to `.gitignore`.

Useful flags: `--top 20`, `--min-bytes 5000`, `--snapshot wins`, `--analyze-export graph.jsonl` (use a file you exported yourself: `npx next analyze export > graph.jsonl`).

Older Next (16.1-16.3): `wimb wins` needs Next 16.4+; use `wimb scan` instead.

Track progress between runs:

```bash
cp .wimb/wins.json .wimb/wins.prev.json     # before you change code
# ...apply a fix, rerun the command...
npx @maxwellcohen/wimb wins --cwd . --compare .wimb/wins.prev.json
```

### Vite apps

Auto-detected when `vite` is a dependency and `next` is not (or pass `--vite`). Runs `vite build` in-process (nothing written to `dist/`) and ranks wins from Rollup's chunk/module graph. One route per HTML entry; bytes are gzip-estimated per chunk and cover the entry's static-import closure.

```bash
npx @maxwellcohen/wimb wins --cwd . --vite
```

### From a local clone instead

```bash
git clone https://github.com/MaxwellCohen/where-is-my-banana && cd where-is-my-banana
pnpm install && pnpm build
node packages/cli/dist/index.js wins --cwd /path/to/your-next-app
```

### Maintainers: releasing

Bump `packages/cli/package.json` version on `main`, then push a matching tag (`git tag vX.Y.Z && git push origin vX.Y.Z`). The `release` workflow verifies the tag matches the version and is on `main`, runs build, tests and `lint:pkg`, then publishes `@maxwellcohen/wimb` to npm (trusted publishing).

## Sample output

| # | Fix | Safety | Edge (importer -> imported) | Saves | Routes |
|---|-----|--------|-----------------------------|-------|--------|
| 1 | lazy | safe | `app/dashboard/page.tsx` -> `components/Chart.tsx` | 84.2 KB | `/dashboard` |
| 2 | swap-package | safe | `lib/dates.ts` -> `moment` | 61.0 KB | `/`, `/dashboard` |
| 3 | deep-import | safe | `components/Icons.tsx` -> `lucide-react` | 38.5 KB | 6 routes |
| 4 | lazy | needs-review (`above-the-fold`) | `app/layout.tsx` -> `components/Chat.tsx` | 22.1 KB | all |

## Mental model

- **First-load JS per route**: compressed client bytes a visitor downloads for that route.
- **uniqueBytes**: bytes that leave a route if exactly one import edge is cut (what is reachable only through it).
- **Win**: an edge cut with a fix kind (`lazy`, `move-to-server`, `swap-package`, `deep-import`, `remove`) and a safety rating (`safe` or `needs-review` with reasons such as `above-the-fold`, `needs-ssr`).
- `totalSavedBytes` sums a win across routes; `byteSource` says `measured` or `estimated`.

## Agent loop

Give your agent `skills/reduce-client-js/SKILL.md`: pick the top safe win, apply `edit`, rebuild, run `wimb wins --compare .wimb/wins.prev.json`, keep only if the byte delta is realized.

## CI budget

```bash
npx @maxwellcohen/wimb wins --cwd . \
  --compare .wimb/wins.prev.json \
  --budget-route 250000 \
  --fail-on-safe-wins 20000
```

- `--budget-route <bytes>`: fail if any route's first-load JS exceeds the budget.
- `--fail-on-safe-wins <bytes>`: fail if unclaimed safe wins total more than this.

## Other commands

- `wimb wins` flags: `--cwd`, `--analyze-export`, `--dist-dir`, `--snapshot`, `--vite` (auto-detected), `--analyze` / `--no-analyze` (run `next analyze` first; default on), `--min-bytes`, `--top N`, `--json`, `--compare <wins.json>`, `--budget-route <bytes>`, `--fail-on-safe-wins <bytes>`. Invalid flag values exit 2.
- `wimb viz build` builds `.wimb/bundle-graph.json` for the `@wimb/visualizer` app (`skills/visualize-analyze-export`). Flags: `--analyze-export`, `--dist-dir`, `--output`, `--cwd`, `--async`, `--traced`, `--vite`.
- `wimb scan` is the legacy source scan (`.wimb/wimb-report.json`); playbooks in `skills/fix-client-bloat`. Flags: `--cwd`, `--build` (deep scan via `next analyze`), `--dist-dir`, `--snapshot`, `--analyze-export`, `--format json,md`, `--exit-threshold error|warning|info`, `--forest-compact`, `--no-ast` (alias of `--forest-compact`).

## Security notes

- `wimb` runs your project's own `next` (or Vite) binary to measure real bundle sizes. It never downloads code (`npx --no-install`) and never uses a shell on macOS/Linux.
- Child processes get an allowlisted environment: `PATH`, framework vars (`NEXT_*`, `VITE_*`, `NODE_*`, `TURBOPACK*`), `NEXT_PUBLIC_*`, and similar. Variables that look like secrets (`*TOKEN*`, `*SECRET*`, `*API_KEY*`, ...) and unrelated cloud/registry credentials are dropped.
- If your build needs other variables, set `WIMB_INHERIT_ENV=1` to pass the full environment.
- Releases are published from GitHub Actions with npm provenance, so each version links to the commit that built it.
- Static analysis tools may flag `child_process` and `process.env` use in `dist/`. That is this build step.

## Config

`wimb.config.*` supports `thresholds`, `ignores` (`files`, `rules`) and `severityOverrides`.

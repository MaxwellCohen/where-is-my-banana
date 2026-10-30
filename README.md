# Where Is My Banana (WIMB)

>“… Because the problem with object-oriented languages is they’ve got all this implicit environment that they carry around with them. You wanted a banana but what you got was a gorilla holding the banana and the entire jungle. “ —Joe Armstrong, creator of Erlang progamming language

WIMB finds the import edges ("wins") that, if cut or made lazy, shrink your Next.js App Router first-load client JS the most, and tells an agent exactly how to cut them.

## Quick start (run from GitHub)

Needs Node >= 20 and a Next.js App Router app on **Next 16.4+** (Turbopack). No clone, no npm publish.

```bash
cd your-next-app
npx --yes github:MaxwellCohen/where-is-my-banana#npx wins --cwd .
```

This runs `next analyze --output --snapshot wins` for you, then ranks the wins. Pass `--no-analyze` to reuse existing analyze data.

Outputs `.wimb/wins.json` (machine) and `.wimb/wins.md` (human). Add `.wimb/` to `.gitignore`.

Useful flags: `--top 20`, `--min-bytes 5000`, `--snapshot wins`, `--analyze-export graph.jsonl` (use a file you exported yourself: `npx next analyze export > graph.jsonl`).

Older Next (16.1-16.3): step 1 is `npx next experimental-analyze --output`; `wimb wins` reads the binary artifacts it writes.

Track progress between runs:

```bash
cp .wimb/wins.json .wimb/wins.prev.json     # before you change code
# ...apply a fix, rerun the command...
npx --yes github:MaxwellCohen/where-is-my-banana#npx wins --cwd . --compare .wimb/wins.prev.json
```

### Vite apps

Auto-detected when `vite` is a dependency and `next` is not (or pass `--vite`). Runs `vite build` in-process (nothing written to `dist/`) and ranks wins from Rollup's chunk/module graph. One route per HTML entry; bytes are gzip-estimated per chunk and cover the entry's static-import closure.

```bash
npx --yes github:MaxwellCohen/where-is-my-banana#npx wins --cwd . --vite
```

### From a local clone instead

```bash
git clone https://github.com/MaxwellCohen/where-is-my-banana && cd where-is-my-banana
pnpm install && pnpm build
node packages/cli/dist/index.js wins --cwd /path/to/your-next-app
```

### Maintainers: refresh the `npx` branch

The GitHub command runs the orphan `npx` branch, which must be rebuilt after changes:

```bash
pnpm install && pnpm pack:npx:push   # rebuilds and force-pushes origin/npx
```

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
npx --yes github:MaxwellCohen/where-is-my-banana#npx wins --cwd . \
  --compare .wimb/wins.prev.json \
  --budget-route 250000 \
  --fail-on-safe-wins 20000
```

- `--budget-route <bytes>`: fail if any route's first-load JS exceeds the budget.
- `--fail-on-safe-wins <bytes>`: fail if unclaimed safe wins total more than this.

## Other commands

- `wimb wins` flags: `--cwd`, `--analyze-export`, `--dist-dir`, `--snapshot`, `--min-bytes`, `--top N`, `--json`, `--compare`.
- `wimb viz build` builds `.wimb/bundle-graph.json` for the `@wimb/visualizer` app (`skills/visualize-analyze-export`).
- `wimb scan` is the legacy source scan (`.wimb/wimb-report.json`); playbooks in `skills/fix-client-bloat`.

## Config

`wimb.config.*` supports `thresholds`, `ignores` (`files`, `rules`) and `severityOverrides`.

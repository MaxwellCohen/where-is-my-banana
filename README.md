# Where Is My Banana (WIMB)

>“… Because the problem with object-oriented languages is they’ve got all this implicit environment that they carry around with them. You wanted a banana but what you got was a gorilla holding the banana and the entire jungle. “ —Joe Armstrong, creator of Erlang progamming language

WIMB finds the import edges ("wins") that, if cut or made lazy, shrink your Next.js App Router first-load client JS the most, and tells an agent exactly how to cut them.

## Quick start (use the prompt)

Easiest path: open **https://wimb-visualizer.vercel.app/**, copy the prompt, and paste it into your coding agent (Claude Code, Cursor, etc.) from your app's root. The agent runs WIMB and applies the fixes for you.

## Manual quick start (run from GitHub)

Needs Node >= 20 and a Next.js App Router app on **Next 16.4+** (Turbopack).

```bash
cd your-next-app
npx @maxwellcohen/wimb wins --cwd .
```

This runs `next analyze --output --snapshot wins` for you, then ranks the wins. Pass `--no-analyze` to reuse existing analyze data.

Outputs `.wimb/wins.json` (machine) and `.wimb/wins.md` (human). Add `.wimb/` to `.gitignore`.

Useful flags: `--top 20`, `--min-bytes 5000`, `--snapshot wins`, `--analyze-export graph.jsonl` (use a file you exported yourself: `npx next analyze export > graph.jsonl`).

Older Next (16.1-16.3): `wimb wins` needs Next 16.4+; use `wimb scan` instead.

Open the visualizer pre-loaded with your results (no file picking):

```bash
npx @maxwellcohen/wimb open
```

Small graphs travel gzip-compressed in the URL fragment (never sent to a server); larger ones are served once from `127.0.0.1` and fetched by the page. Use `--no-launch` to just print the URL. Safari blocks the localhost fetch; use Chrome/Firefox or the file picker.

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
- **Win**: an edge cut with a fix kind (`lazy`, `move-to-server`, `swap-package`, `deep-import`, `remove`, `stub-alias`) and a safety rating (`safe` or `needs-review` with reasons such as `above-the-fold`, `needs-ssr`).
- `predictedSavedBytes` = measured saving minus the lazy-loading runtime (about 1.5 KB for `next/dynamic` when the route doesn't already ship it); `confidence` is `high|medium|low`. `alsoReachableVia` lists other static import chains that keep the module in the route (reason `static-elsewhere`); wins predicted at under 2 KB are `net-negative-risk`. Both are demoted to `needs-review` and excluded from `--fail-on-safe-wins`. Always verify with `--compare`.
- `stub-alias` (reason `client-stub`): a node-only-looking package reached only through barrel re-exports of a `"sideEffects": false` package. The win carries a browser-only `turbopack.resolveAlias` / webpack client alias plus stub file content. Heuristic (regex over re-exports, not a full parse); check the client never calls it.
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

## Why is X in my bundle?

```bash
npx @maxwellcohen/wimb why moment --cwd .          # package, path fragment or glob (@scope/*)
```

Prints the shortest import chain from the route entry, subtree/unique bytes, and up to `--chains N` (default 3) alternative chains with distinct first hops, each with the edge to cut and whether other chains keep it alive. Flags: `--route <substr>`, `--all-routes`, `--json`, plus the `wins` data flags (`--cwd`, `--analyze-export`, `--dist-dir`, `--snapshot`, `--vite`, `--no-analyze`). Exits 1 if it is not in the client graph (says so when it is server-only).

## Other commands

- `wimb wins` flags: `--cwd`, `--analyze-export`, `--dist-dir`, `--snapshot`, `--vite` (auto-detected), `--analyze` / `--no-analyze` (run `next analyze` first; default on), `--min-bytes`, `--top N`, `--json`, `--compare <wins.json>`, `--budget-route <bytes>`, `--fail-on-safe-wins <bytes>`. Invalid flag values exit 2.
- `wimb viz build` builds `.wimb/bundle-graph.json` for the `@wimb/visualizer` app (`skills/visualize-analyze-export`). Flags: `--analyze-export`, `--dist-dir`, `--output`, `--cwd`, `--async`, `--traced`, `--vite`.
- `wimb scan` is the legacy source scan (`.wimb/wimb-report.json`); playbooks in `skills/fix-client-bloat`. Flags: `--cwd`, `--build` (deep scan via `next analyze`), `--dist-dir`, `--snapshot`, `--analyze-export`, `--format json,md`, `--exit-threshold error|warning|info`, `--forest-compact`, `--no-ast` (alias of `--forest-compact`).

## Whole-site audit

`wimb audit` is a fast, build-free static audit for Next.js App Router / CMS-driven sites. It reads source files and every workspace `package.json` (skips `node_modules`, `.next`, `dist`, `.wimb`, `.git`) and writes `.wimb/audit.json` and `.wimb/audit.md` (a "Do these first" list, then findings by severity and check, each with a concrete fix). Registry/boundary/barrel rules live in `wimb scan`.

Flags: `--cwd`, `--json` (print JSON to stdout), `--top N` (per check, default 10), `--checks a,b,c`, `--fail-on high|medium` (exit 1), `--fix`, `--fix-dry-run`, `--force`, `--baseline`, `--save-baseline`. Invalid values exit 2. Suppress one finding with `// wimb-ignore-next-line <check>`; `wimb.config.ts` `ignores.rules` / `ignores.files` are honored.

Monorepos: when `pnpm-workspace.yaml` or `package.json` `workspaces` is present, each workspace package that depends on `next` is audited separately and findings carry a `package` label. `ignores.files` accepts real globs (`*`, `**`, `?`, `{a,b}`, `[abc]`, `!negation`; a bare name matches at any depth).

Autofix: `--fix-dry-run` prints a unified diff; `--fix` writes it. Only safe mechanical edits: `strategy="lazyOnload"` on non-consent third-party `<Script>` (consent managers such as OneTrust/Cookiebot are reported, never changed), non-swap font `display` to `swap`, drop `ssr: false` where the audit flags it, add `images.formats` (avif, webp) to a plain `next.config`, `priority` on a hero-named `next/image`, and `loading="lazy" decoding="async"` on raw `<img>` outside hero/header/nav/logo files. Idempotent; ambiguous spots are skipped and listed; files with unstaged git changes are skipped unless `--force`.

Baseline: `--save-baseline [--baseline file]` records current findings (default `.wimb/audit-baseline.json`); `--baseline file` then reports and fails (`--fail-on`) only on NEW findings. Fingerprint = rule id + file + message with digits normalized (line numbers ignored); a repeated issue in the same file counts as new beyond the baselined count.

Scoring: each finding has `impactScore` (0-100 estimate, not measured: severity base 75/45/15, +5 to +10 for sitewide or LCP checks, +10 in layouts, -5 to -10 for info-like rules) and `effort` S (minutes), M (about an hour), L (a day or more). "Do these first" ranks by impact divided by effort weight (S=1, M=2, L=4), at most 2 per check on the first pass.

Checks: `third-party-script`, `raw-img`, `lcp-priority`, `image-config`, `cms-image-params`, `fonts`, `force-dynamic`, `missing-static-params`, `sequential-await`, `full-cms-payload-to-client`, `heavy-deps`, `old-browserslist`, `maps-widgets`, `middleware-scope`, `preview-code-in-prod`, `css-weight`, `use-client-inventory`, `ssr-false-misuse`, `split-candidate`. Most checks are regex heuristics; expect some false positives. `split-candidate` parses with oxc.

`split-candidate` ("files worth breaking up") clusters each file's top-level declarations by shared local helpers/state (a stateless top-level component that only composes the pieces is treated as the shell, not glue; shared imports do not link clusters since each new file can import them itself). It flags files with 2+ independent clusters that are large (`splitMinLoc`) or where one cluster alone pulls a heavy package (chart/map/editor/markdown/date/pdf libs, the `heavy-deps` list, or any package measured at `splitHeavyKb`+ in `.wimb/bundle-graph.json`, which also gives the "~N KB" and weights the score). Ids: `heavy-cluster` (high when client-reachable), `low-cohesion` (medium client / low server), `god-file` (low; long but coupled), `server-eligible` (a `"use client"` file whose static part uses no hooks/handlers/browser APIs), `registry` (many components imported only to sit in a lookup map). Each `fix` is a concrete split plan (new file names, what moves, where `"use client"` goes, which module to `next/dynamic` with SSR on and a sized placeholder, importers to update, no barrel). `audit.md` ends with a "Files worth breaking up" table. Optional `wimb.config` thresholds (numeric literals): `splitMinLoc` 250, `splitMinClusterLoc` 25, `splitGodFileLoc` 600, `splitGodFileDecls` 12, `splitGodFileImports` 25, `splitServerEligibleLoc` 80, `splitRegistryMinImports` 8, `splitHeavyKb` 30. To suppress one file put `// wimb-ignore-next-line split-candidate` above its first non-import statement.

## One command: `wimb speed`

`wimb speed` runs the static audit, `wimb wins` (skipped with a warning if the project has no `next`/`vite` dependency or the run fails), and, when URLs are given, the live audit. It merges everything into one ranked plan: `.wimb/plan.json` and `.wimb/plan.md` (headline, speed budget, quick wins, biggest risk, "Do first (code, safe)", "Needs a human decision", "Not code (GTM/CDN/CMS)", "Later", per-page-type table when live data exists, and a paste-ready agent "Handoff prompt"). Related findings are deduped (e.g. "Defer 6 third-party scripts" with every location) and a static finding corroborated by a live one becomes a single higher-scored item. Rank = impact score / effort.

```bash
npx --yes @maxwellcohen/wimb speed --url https://example.com   # --url is optional
npx --yes @maxwellcohen/wimb speed --prompt                    # only the agent prompt, to stdout
npx --yes @maxwellcohen/wimb speed --snapshot                  # save plan.json as plan.prev.json
npx --yes @maxwellcohen/wimb speed --compare                   # resolved / new / regressed vs plan.prev.json
```

Flags: `--cwd`, `--url` (repeatable or comma list), `--urls-file`, `--sitemap`, `--sample N`, `--no-wins`, `--no-live`, `--no-analyze` (passed to wins), `--top N`, `--json`, `--prompt`, `--compare`, `--snapshot`, `--fail-on high|medium` (exit 1), `--fix`, `--fix-dry-run`, `--force`, `--baseline`, `--save-baseline`. Invalid values exit 2. KB estimates are "measured" only for bundle wins; other categories use coarse per-finding heuristics and are labeled "rough".

## Live runtime audit

`wimb live <url...>` audits deployed pages over plain HTTP (Node 20 `fetch`, no browser). It GETs each page once, HEADs assets for sizes (ranged GET fallback), and writes `.wimb/live.json` and `.wimb/live.md` (detection header, per-page table, "Do these first", findings by check). Every finding carries `owner: code|gtm|cdn|cms`; a code agent can only fix `code`.

Flags: `--urls-file`, `--sitemap <url>` + `--sample 8` (spreads samples across path patterns), `--concurrency 3`, `--timeout 15000`, `--user-agent`, `--mobile`, `--max-requests 150`, `--out .wimb`, `--json`, `--fail-on high|medium`, `--lighthouse` (runs `npx --no-install lighthouse`, first 3 pages), `--lighthouse-json <file...>` (import existing reports).

Checks: `html-size`, `headers` (compression, cache, cookies, TTFB), `scripts` (+ vendor grouping), `gtm` (container size/vendors), `css`, `fonts`, `images` (+ LCP candidate), `hints`, `head`, `redirects`, `dom`, `cross-page`, `lighthouse`. These are heuristics over server-rendered HTML: client-injected resources and CSS file contents are not seen, and transfer sizes are estimated.

## Security notes

- `wimb` runs your project's own `next` (or Vite) binary to measure real bundle sizes. It never downloads code (`npm exec --no-install`) and never uses a shell on macOS/Linux.
- Releases are published from GitHub Actions with npm provenance, so each version links to the commit that built it.
- Static analysis tools may flag `child_process` use in `dist/`. That is this build step.

## Config

`wimb.config.*` supports `thresholds`, `ignores` (`files`, `rules`) and `severityOverrides`.

## Note

This is a vibe-coded proof-of-concept project. Expect rough edges.

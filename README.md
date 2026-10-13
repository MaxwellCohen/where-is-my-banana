# Where Is My Banana (WIMB)

>“… Because the problem with object-oriented languages is they’ve got all this implicit environment that they carry around with them. You wanted a banana but what you got was a gorilla holding the banana and the entire jungle. “ —Joe Armstrong, creator of Erlang progamming language

Modern TypeScript web projects make it too easy to accidentally pull far too much JavaScript into the client.
Where Is My Banana? helps make sure your project just has your banana (code) and not a bunch of extra stuff you do not need (a gorilla, and the jungle). This project starts out focused on Next.js App Router + Turbopack apps, and **leans on existing tools** (Knip, e18e, rsc-xray, `next analyze`) rather than reinventing them.

A TypeScript CLI that detects unnecessary client-side code in Next.js App Router + Turbopack apps. Because when I want a banana I only want a banana — not everything else.

## Quick start

```bash
pnpm install
pnpm build
pnpm exec wimb scan --cwd ./your-next-app
```

## Run on any machine (`npx` from GitHub)

No npm publish and no clone of this monorepo. An orphan branch `npx` holds a self-contained `@wimb/cli` package (workspace deps bundled):

```bash
npx --yes github:MaxwellCohen/where-is-my-banana#npx wimb scan --cwd /path/to/your-next-app
```

Add flags as usual (`--build`, `--format json,md,sarif`, etc.). Node **≥ 20** required.

Agent skill: `skills/run-wimb-npx/`.

### Refresh the `npx` branch (maintainers)

```bash
pnpm install
pnpm pack:npx:push   # rebuild + force-push origin/npx
```

Optional: attach `wimb-cli-*.tgz` from `pnpm pack:npx` to a GitHub Release for a pinned URL.

## Run locally (without npm)

You don't need to publish or install `@wimb/cli` from the registry. Build and run from this repo:

```bash
pnpm install   # workspace deps only — not installing wimb from npm
pnpm build
```

Then invoke the built CLI:

```bash
# Option 1 — pnpm exec (simplest)
pnpm exec wimb scan --cwd /path/to/your-next-app

# Option 2 — node directly
node packages/cli/dist/index.js scan --cwd /path/to/your-next-app

# Option 3 — from packages/cli
cd packages/cli && node dist/index.js scan --cwd /path/to/your-next-app
```

Reports are written to `.wimb/` in the **target app** directory.

Rebuild after code changes:

```bash
pnpm build
# or watch mode:
pnpm --filter @wimb/cli dev
```

## Commands

```bash
# Source scan (default — no build required; estimated bytes)
wimb scan

# Deep scan with measured bytes from next analyze
# Next 16.4+: captures a snapshot, then reads `next analyze export` JSONL
# Older Next: falls back to `next experimental-analyze` binary artifacts
wimb scan --build

# Point at pre-built analyze output (or auto-detected .next/diagnostics/analyze)
wimb scan --build --dist-dir .next
# If analyze artifacts already exist, a plain `wimb scan` will use them automatically.
# On Next 16.4+ that replay uses `next analyze export` (newest snapshot, or --snapshot <name>).

# Read a graph you already exported (`next analyze export > graph.jsonl`, or a .jsonl.gz)
wimb scan --analyze-export ./bundle-graph.jsonl

# Merge optional external analyzers
wimb scan --e18e
wimb scan --rsc-xray

# Compact forest (omit AST/JSX trees)
wimb scan --forest-compact
# alias:
wimb scan --no-ast

# SARIF output for CI
wimb scan --format json,md,sarif

# Compare against a prior report (writes .wimb/wimb-diff.json + .md)
wimb scan --baseline .wimb/wimb-report.json
wimb diff path/to/baseline-wimb-report.json path/to/current-wimb-report.json

# Route-rooted forest visualizer
# Binary path (no Next upgrade): after `next experimental-analyze --output`
wimb viz build --cwd ./your-next-app -o ./your-next-app/.wimb/bundle-graph.json
# Or Next 16.4+ JSONL:
wimb viz build --analyze-export ./bundle-graph.jsonl.gz -o .wimb/bundle-graph.json
pnpm viz        # http://localhost:3340 — hot reload; upload json/jsonl in the UI
pnpm viz:demo   # refresh visualizer demo from next-books (or WIMB_VIZ_SOURCE)
pnpm viz:watch  # visualizer + @wimb/graph-v1 watch
```

See `packages/visualizer/README.md`.

## Output

All generated output is written to `.wimb/` at the project root on every scan (existing files are overwritten):

- `.wimb/wimb-report.json` — stable schema for agents
- `.wimb/wimb-report.md` — human summary
- `.wimb/wimb-report.sarif` — code scanning integration (when `--format` includes `sarif`)
- `.wimb/forest.json` — **always** written: per-route import forest for agents (layout chains, load kinds, heavy-subtree hints, optional AST)
- `.wimb/cache.json` — measured package-size cache (name@version → bytes)
- `.wimb/wimb-diff.json` / `.wimb/wimb-diff.md` — when using `--baseline` or `wimb diff`

### Estimated vs measured bytes

| Mode | When | Byte source |
|------|------|-------------|
| **estimated** | Default source scan | Install/dist sizes + source subtree heuristics |
| **measured** | `--build`, `--dist-dir`, `--analyze-export`, or existing `.next/diagnostics/analyze` | Next 16.4+ graph-v1 JSONL from `next analyze export` (client `[client-fs]/*.js` parts). Older Next falls back to binary `experimental-analyze` artifacts. |

Findings and the report summary include a `byteSource` field (`estimated` \| `measured`).

### WIMB vs `next analyze`

| Tool | Best for |
|------|----------|
| **next analyze** | Interactive treemap of the Turbopack graph (route summary, table view, snapshot diffs). `next analyze export` streams that snapshot as JSON Lines. |
| **WIMB** | Static + CI gates, agent-oriented reports (`forest.json`), rule playbooks, unused-deps/dead client code via Knip, optional e18e / rsc-xray |
| **WIMB visualizer** | Route-rooted import tree (`wimb viz build` + `@wimb/visualizer`) with per-node bytes and shared route counts |

Add `.wimb/` to your app's `.gitignore` if you do not want reports committed:

```
.wimb/
```

## Configuration

Create `wimb.config.ts` in your project root to override thresholds, ignores, and severity.

Useful diff thresholds:

```ts
export default {
  thresholds: {
    diffBudgetBytes: 50_000,       // fail when client bytes grow more than 50KB vs baseline
    diffFailOnNewFindings: true,   // fail on new error findings in diff
  },
};
```

## CI (GitHub Actions sketch)

```yaml
name: wimb
on: pull_request
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install
      - run: pnpm exec wimb scan --cwd . --format json,md,sarif --exit-threshold warning
        # Optional: restore baseline artifact from main, then:
        # pnpm exec wimb scan --cwd . --baseline ./baseline/wimb-report.json
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: .wimb/wimb-report.sarif
```

## Skills

See `skills/run-wimb-npx/` (remote `npx`), `skills/scan-client-bloat/`, `skills/fix-client-bloat/`, and `skills/visualize-analyze-export/` for Cursor agent workflows.

## Development

```bash
pnpm test
pnpm --filter @wimb/cli dev
pnpm viz         # bundle forest UI on :3340
pnpm viz:demo    # refresh demo-graph.json
pnpm viz:watch   # UI + graph-v1 watch
```

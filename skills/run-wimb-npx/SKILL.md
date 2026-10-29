---
name: run-wimb-npx
description: >-
  Run the wimb CLI on any machine via npx from GitHub (branch #npx) — no npm
  publish, no clone of where-is-my-banana. Use when auditing Next.js client
  bloat on a machine that only has Node and the target app checkout.
---

# Run WIMB via npx (from GitHub)

Use this when the agent or user does **not** have the WIMB monorepo cloned and `@wimb/cli` is not on npm.

## Prerequisites

- Node.js **≥ 20**
- A Next.js App Router project path (`--cwd`)

## Command

```bash
npx --yes github:MaxwellCohen/where-is-my-banana#npx wins --cwd <project-root>
```

### Examples

```bash
# Ranked wins from an existing analyze export (measured bytes)
npx --yes github:MaxwellCohen/where-is-my-banana#npx wins --cwd . --analyze-export ./bundle-graph.jsonl

# Compare to a previous run, fail CI on regressions
npx --yes github:MaxwellCohen/where-is-my-banana#npx wins --cwd . --analyze-export ./bundle-graph.jsonl --compare .wimb/wins.prev.json --fail-on-safe-wins 20000

# Legacy source scan
npx --yes github:MaxwellCohen/where-is-my-banana#npx scan --cwd .
```

## After the run

Read `.wimb/wins.json` in the **target project** (not in a temp npx cache). Follow `skills/reduce-client-js/`. For legacy `wimb scan` findings, see `skills/fix-client-bloat/`.

## Maintainer: refresh GitHub `#npx`

When the CLI on `main` changes and you want other machines to pick it up:

```bash
pnpm install
pnpm pack:npx:push
```

That rebuilds a standalone package and force-pushes orphan branch `npx`.

## Why `#npx` and not `#main`?

`main` is a pnpm monorepo (no root `bin`, `workspace:*` deps). Branch `npx` is only the installable CLI snapshot.

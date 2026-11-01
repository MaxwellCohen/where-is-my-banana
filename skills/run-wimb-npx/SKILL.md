---
name: run-wimb-npx
description: >-
  Run the wimb CLI on any machine via npx (@maxwellcohen/wimb) — no clone of
  where-is-my-banana. Use when auditing Next.js client
  bloat on a machine that only has Node and the target app checkout.
---

# Run WIMB via npx

Use this when the agent or user does **not** have the WIMB monorepo cloned; the CLI is published to npm as `@maxwellcohen/wimb`.

## Prerequisites

- Node.js **≥ 20**
- A Next.js App Router project path (`--cwd`)

## Command

```bash
npx --yes @maxwellcohen/wimb wins --cwd <project-root>
```

### Examples

```bash
# Ranked wins from an existing analyze export (measured bytes)
npx --yes @maxwellcohen/wimb wins --cwd . --analyze-export ./bundle-graph.jsonl

# Compare to a previous run, fail CI on regressions
npx --yes @maxwellcohen/wimb wins --cwd . --analyze-export ./bundle-graph.jsonl --compare .wimb/wins.prev.json --fail-on-safe-wins 20000

# Legacy source scan
npx --yes @maxwellcohen/wimb scan --cwd .
```

## After the run

Read `.wimb/wins.json` in the **target project** (not in a temp npx cache). Follow `skills/reduce-client-js/`. For legacy `wimb scan` findings, see `skills/fix-client-bloat/`.

## Maintainer: release

Push a `vX.Y.Z` tag matching `packages/cli/package.json` (on `main`); the `release` workflow tests and publishes to npm.

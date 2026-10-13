---
name: scan-client-bloat
description: >-
  Run wimb scan on a Next.js App Router project, interpret .wimb/wimb-report.json,
  and prioritize findings by bytes × confidence. Use when auditing client
  bundle bloat, unnecessary use client boundaries, or before fixing findings
  with fix-client-bloat.
---

# Scan Client Bloat

Detect unnecessary client-side code in Next.js App Router + Turbopack apps using the `wimb` CLI.

## When to use

- User asks to audit, scan, or measure client bundle bloat
- Before a fix pass (pair with `fix-client-bloat`)
- CI gate for client bytes or boundary violations

## Run the scan

```bash
# Source scan (default — no build required)
pnpm exec wimb scan --cwd <project-root>

# Deep scan with real byte attribution
# Next 16.4+: `next analyze --output` then `next analyze export`
# Next 16.1–16.3: binary experimental-analyze artifacts
pnpm exec wimb scan --cwd <project-root> --build

# Or feed an export you already captured
pnpm exec wimb scan --cwd <project-root> --analyze-export ./bundle-graph.jsonl

# Point at pre-built analyze output from CI
pnpm exec wimb scan --cwd <project-root> --build --dist-dir .next

# SARIF for code scanning
pnpm exec wimb scan --cwd <project-root> --format json,md,sarif
```

No monorepo clone: use `skills/run-wimb-npx/` (`npx --yes github:MaxwellCohen/where-is-my-banana#npx wimb …`). In this repo: `pnpm exec wimb` after `pnpm build`.

## Read the report

All scan output lives in `.wimb/` at the project root.

Primary contract: `.wimb/wimb-report.json`

```json
{
  "findings": [{
    "ruleId": "heavy-client-import",
    "severity": "error",
    "confidence": "high",
    "file": "components/chart.tsx",
    "estimatedBytes": 524288,
    "evidence": { "importChain": ["app/page.tsx", "..."] },
    "fixStrategy": { "name": "...", "steps": ["..."] }
  }]
}
```

Human summary: `.wimb/wimb-report.md`

## Prioritization

Sort findings by:

1. **estimatedBytes** (higher = more impact; use build mode for real bytes)
2. **confidence** (`high` > `medium` > `low`)
3. **severity** (`error` > `warning` > `info`)

Act on `high` confidence directly. Verify `medium` before large refactors. Treat `low` as investigation leads.

## Cross-checks (optional)

- `next analyze export` — graph-v1 JSONL (wimb `--build` on Next 16.4+ wraps capture + export; `--analyze-export` reads a file)
- Route-rooted tree UI — `skills/visualize-analyze-export` (`wimb viz build` + `@wimb/visualizer`)
- `next experimental-analyze --output` — binary artifacts on Next before 16.4
- `@next/bundle-analyzer` — visual treemap
- `@rsc-xray/analyzer` — RSC flight payload inspection

## After scanning

Route each `ruleId` to `skills/fix-client-bloat/references/<rule-id>.md` for remediation playbooks.

Always re-run `wimb scan` after fixes and diff `.wimb/wimb-report.json` to confirm resolution.

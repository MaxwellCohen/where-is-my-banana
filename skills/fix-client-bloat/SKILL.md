---
name: fix-client-bloat
description: >-
  Fix wimb scan findings in Next.js App Router projects. Routes by ruleId to
  per-rule playbooks with concrete remediation steps. Use after scan-client-bloat
  or when the user shares .wimb/wimb-report.json findings.
---

# Fix Client Bloat

Remediate `wimb` findings using per-rule playbooks. Detection only — no codemods shipped.

## Workflow

1. Run or read `.wimb/wimb-report.json` (see `scan-client-bloat` skill)
2. Sort findings: `estimatedBytes × confidence × severity`
3. For each finding, open `references/<rule-id>.md` in this skill directory
4. Apply the playbook steps
5. Re-run `wimb scan` and diff the report — finding should disappear or downgrade

## Decision trees by category

### Boundary (`use client` placement)

- Unnecessary directive → remove `'use client'`, typecheck
- Too high → move directive to leaf components, pass server content via `children`
- Mixed components → split file into server + client modules

### Dependency

- Replaceable → `npx @e18e/cli migrate <pkg>` for mechanical swaps
- Heavy/barrel → deep imports or `optimizePackageImports`
- Unused → remove from `package.json`

### Misplacement (server logic in client)

- Data at render → Server Component fetch
- Mutation → server action
- Client-triggered read → route handler
- **auth-crypto-in-client** → security priority, never downgrade severity

### Loading

- Heavy/conditional components → `next/dynamic(() => import(...), { loading })`
- Handler-only libs → `await import('pkg')` inside the handler

## Playbook index

| Category | Rule IDs |
|----------|----------|
| boundary | `use-client-unnecessary`, `use-client-too-high`, `use-client-mixed-components`, `interactive-leaf-extractable`, `provider-pulls-in-tree`, `mixed-module-split`, `missing-poison-pill`, `app-barrel-reexport`, `non-serializable-props`, `rsc-payload-bloat`, `metadata-in-client-file` |
| dependency | `replaceable-dependency`, `heavy-client-import`, `barrel-import`, `obsolete-polyfill`, `duplicate-dependency-category`, `duplicate-dependency-versions`, `runtime-css-in-js`, `dev-code-in-prod`, `transitive-heavy-dependency`, `unused-dependency`, `static-icon-map`, `node-builtin-polyfill-config` |
| misplacement | `server-logic-in-client`, `auth-crypto-in-client`, `env-var-misuse`, `third-party-script-as-import`, `static-content-rendered-client`, `use-server-file-mixed-exports`, `middleware-heavy-imports` |
| loading | `missing-dynamic-import`, `on-demand-feature-eager`, `locale-data-bloat`, `syntax-highlighter-all-languages`, `client-search-index`, `large-static-data-in-client`, `inline-svg-collection`, `asset-in-bundle`, `wasm-eager-load`, `next-dynamic-misuse` |
| config | `missing-optimize-package-imports`, `legacy-browser-targets`, `route-over-budget` |

## Verification

After each fix batch:

```bash
pnpm exec wimb scan --cwd <project-root>
diff .wimb/wimb-report.json .wimb/wimb-report.json.bak  # or compare finding counts
```

Target: zero `error` severity findings at `high` confidence for the touched rules.

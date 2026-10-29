---
name: fix-client-bloat
description: >-
  Legacy reference for `wimb scan` findings (.wimb/wimb-report.json) with
  per-rule playbooks. Prefer `reduce-client-js` (`wimb wins`) for byte-driven work.
---

# Fix Client Bloat (legacy scan findings)

Secondary to `skills/reduce-client-js`. Use only when the user shares `.wimb/wimb-report.json` findings.

1. Sort findings by `estimatedBytes x confidence x severity`.
2. Open `references/<ruleId>.md` and apply the playbook.
3. Re-run `pnpm exec wimb scan --cwd <project-root>`; the finding should disappear or downgrade.

Rule IDs with playbooks: `use-client-unnecessary`, `use-client-too-high`, `replaceable-dependency`, `heavy-client-import`, `barrel-import`, `runtime-css-in-js`, `transitive-heavy-dependency`, `unused-dependency`, `static-icon-map`, `missing-dynamic-import`, `branch-exclusive-eager-import`, `static-component-map`, `on-demand-feature-eager`, `next-dynamic-misuse`.

---
name: speed-up-site
description: >-
  Make a Next.js / CMS-driven website faster end to end with WIMB. Runs the
  static `wimb audit` (third-party scripts, images, fonts, rendering/caching,
  heavy deps, client boundaries, oversized low-cohesion files to split) plus `wimb wins` (bundle edges), fixes the
  highest-impact safe items, and proves each with a before/after measurement.
  Use when asked to speed up, optimize, or improve performance of a site.
---

# Speed up a site (one prompt)

Work in this order. Keep each fix small, separate, and measured. Never upgrade `next`. Never add `ssr: false`. Never remove consent, analytics, or tracking scripts: defer them (`strategy="lazyOnload"`) and list them for the user to approve.

## 1. Plan (one command)
```bash
npx --yes @maxwellcohen/wimb speed --snapshot [--url https://staging.example.com]
```
Runs the static audit, `wins`, and (with `--url`/`--urls-file`/`--sitemap`) the live audit, then writes the merged, ranked `.wimb/plan.md` and `.wimb/plan.json`. `--snapshot` saves a baseline for later `--compare`. Add `.wimb/` to `.gitignore`. Preview safe mechanical fixes with `wimb audit --fix-dry-run`, apply with `--fix` (skips consent scripts and files with unstaged changes). On an existing repo, `wimb audit --save-baseline` once, then `--baseline <file> --fail-on high` to fail only on new findings. `wimb speed --prompt` prints a paste-ready agent prompt with the top items inlined.

## 2. Follow `.wimb/plan.md`
1. Work "Do first (code, safe)" top to bottom; each item has files, exact steps, and a verify command.
2. Do not act on "Needs a human decision" or "Not code (GTM/CDN/CMS)": summarize them for the user (the latter include exact steps for the person who owns the tool).
3. For bundle items follow `skills/reduce-client-js/SKILL.md`; for registry/CMS block items also run `wimb scan`.
4. `split-candidate` items (files worth breaking up) carry a step-by-step split plan in `fix`: create the named files, move the listed declarations/imports, put `"use client"` only where stated, load the heavy module with `next/dynamic` (SSR on, sized placeholder, never `ssr: false`), update importers directly (no barrels), then re-run `wimb wins`.

## 3. Per fix
Edit, run the repo's build, then `npx --yes @maxwellcohen/wimb speed --compare` and confirm the item moved to "resolved". Keep the change only if the build passes and the item resolved (or bytes dropped). Revert otherwise. One commit per fix with the measured delta.

For bundle items: after applying a `lazy` win the agent must verify bytes dropped (`--compare`) and revert if not. `wimb why <pkg>` explains what keeps a package in the client bundle; Fix barrel items ("Barrel X defeats lazy-loading of Y") before lazy wins: they make lazy wins save nothing. `lazy`/`guard-heavy` wins carry `testImpact` in `.wimb/wins.json`: update/run those tests. Use `wimb wins --packages` for the heaviest packages and `wimb validate` to check graph numbers against the built HTML; `lazy` wins on always-rendered components only move bytes to "preloaded". `stub-alias` items (node-only SDK pulled in by a `sideEffects: false` barrel) are `needs-review`: apply only after confirming the client never calls the package.

## 4. Do not guess
- Heuristic checks (`sequential-await`, `full-cms-payload-to-client`, `maps-widgets`, `middleware-scope`) can be false positives: read the code before editing.
- Ask the user before: removing a third-party script, changing caching/revalidate behavior, or changing CMS queries.

## 5. Finish
Report: the `--compare` summary (resolved/new/regressed), before/after first-load JS per route, items fixed vs. remaining, items needing a human decision, and suggested next checks (Lighthouse/CrUX on real URLs, GTM container audit, CDN cache-hit ratio).

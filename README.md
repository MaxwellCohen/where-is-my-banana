# Where Is My Banana (WIMB)

A TypeScript CLI that detects unnecessary client-side code in Next.js App Router + Turbopack apps. Because when I want a banana I only want a banana not everything else. 

## Quick start

```bash
pnpm install
pnpm build
pnpm exec wimb scan --cwd ./your-next-app
```

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
# Source scan (default — no build required)
wimb scan

# Deep scan with byte attribution from next experimental-analyze
wimb scan --build

# Point at pre-built analyze output
wimb scan --build --dist-dir .next

# SARIF output for CI
wimb scan --format json,md,sarif
```

## Output

All generated output is written to `.wimb/` at the project root on every scan (existing files are overwritten):

- `.wimb/wimb-report.json` — stable schema for agents
- `.wimb/wimb-report.md` — human summary
- `.wimb/wimb-report.sarif` — code scanning integration (when `--format` includes `sarif`)

Add `.wimb/` to your app's `.gitignore` if you do not want reports committed:

```
.wimb/
```

## Configuration

Create `wimb.config.ts` in your project root to override thresholds, ignores, and severity.

## Skills

See `skills/scan-client-bloat/` and `skills/fix-client-bloat/` for Cursor agent workflows.

## Development

```bash
pnpm test
pnpm --filter @wimb/cli dev
```

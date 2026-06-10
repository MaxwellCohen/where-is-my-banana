# use-client-unnecessary

## Steps

1. Delete the 'use client' directive from the flagged file
2. Run pnpm build / tsc to confirm no descendant needed the boundary
3. Re-run wimb scan

# mixed-module-split

## Steps

1. Create <name>.server.ts with import 'server-only'
2. Move server-only exports there
3. Keep client-safe exports in the original file
4. Update importers
5. Re-run wimb scan

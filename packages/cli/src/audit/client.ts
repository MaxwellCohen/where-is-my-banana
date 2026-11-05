import type { AuditContext, Finding } from "./types.js";
import { find, importsOf, isAppFile, isClient, isCode, isLayoutLike, isRootLayout, lineAt, matches, resolveImport } from "./util.js";

function bucket(path: string): string {
  const m = path.match(/^(?:.*?\/)?(?:src\/)?app\/(.*)$/);
  if (m) {
    const segs = m[1].split("/");
    const first = segs.length > 1 ? segs.find((s, i) => i < segs.length - 1 && !/^\(.*\)$/.test(s)) : undefined;
    return first ? `app/${first}` : "app";
  }
  return path.split("/").slice(0, path.split("/")[0] === "src" ? 2 : 1).join("/");
}

export function useClientInventory(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  const byPath = new Map(ctx.files.map((f) => [f.path, f]));
  const counts = new Map<string, number>();
  for (const f of ctx.files) {
    if (!isCode(f) || !isClient(f.content)) continue;
    const b = bucket(f.path);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  // Info only: a handful of client files is normal, so just flag buckets with many.
  for (const [b, n] of [...counts].sort((a, c) => c[1] - a[1])) {
    if (n < 10) continue;
    out.push(find("use-client-inventory", { id: "use-client-inventory/count", severity: "low", file: b, line: 1, message: `${n} "use client" file(s) under ${b}.`, fix: "Info only. Push \"use client\" down to small interactive leaves; run `wimb scan` for use-client-too-high." }));
  }
  for (const f of ctx.files) {
    if (!isCode(f) || !isRootLayout(f.path)) continue;
    const clients = new Map<string, number>();
    for (const i of importsOf(f.content)) {
      const t = resolveImport(f.path, i.spec, byPath);
      if (t && isClient(t.content)) clients.set(t.path, t.content.length);
    }
    if (clients.size === 0) continue;
    const top = [...clients].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const biggest = top[0][1];
    out.push(find("use-client-inventory", { id: "use-client-inventory/layout", severity: biggest > 20_000 ? "medium" : "low", file: f.path, line: 1, message: `Layout imports ${clients.size} client file(s); biggest: ${top.map(([p, n]) => `${p} (${(n / 1024).toFixed(1)} KB)`).join(", ")}.`, fix: "These ship on every route. Lazy-load (next/dynamic) anything not needed for first paint, or move it below the fold/into the routes that use it." }));
  }
  return out;
}

const ABOVE_FOLD = /hero|banner|header|nav|menu|masthead|footer|registry|component-?map|componentmap|blocks?|sections?|renderer|page-?builder|cms/i;

export function ssrFalseMisuse(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  for (const f of ctx.files) {
    if (!isCode(f)) continue;
    const c = f.content;
    if (!/\bssr\s*:\s*false\b/.test(c)) continue;
    const client = isClient(c);
    const serverFile = !client && /(?:^|\/)(?:src\/)?app\//.test(f.path);
    const hits = [...matches(c, /\bssr\s*:\s*false\b/)];
    for (const { line, m } of hits) {
      const ctxText = c.slice(Math.max(0, m.index - 300), m.index);
      const target = ctxText.match(/import\(\s*["']([^"']+)["']/g)?.pop() ?? "";
      if (serverFile) {
        out.push(find("ssr-false-misuse", { id: "ssr-false-misuse/server-component", severity: "high", file: f.path, line, message: "`ssr: false` in a Server Component is a build error in Next 15+.", fix: "Remove `ssr: false` (keep `dynamic()` with a `loading` placeholder), or move the call into a small \"use client\" wrapper file." }));
      } else if (isLayoutLike(f.path) || ABOVE_FOLD.test(f.path) || ABOVE_FOLD.test(target) || hits.length >= 3) {
        out.push(find("ssr-false-misuse", { severity: "medium", file: f.path, line, message: "`ssr: false` on a non-leaf/above-the-fold/CMS-registry component removes it from server HTML: hurts LCP, SEO and causes CLS.", fix: "Remove `ssr: false` and keep `dynamic(() => import(...), { loading: () => <Placeholder/> })` with a fixed-size placeholder. Reserve `ssr: false` for browser-only leaves (maps, editors) below the fold." }));
      }
    }
  }
  return out;
}

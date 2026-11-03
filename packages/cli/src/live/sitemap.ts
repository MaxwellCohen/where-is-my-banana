export function parseSitemap(xml: string): { urls: string[]; children: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
  if (/<sitemapindex/i.test(xml)) return { urls: [], children: locs };
  return { urls: locs, children: [] };
}

/** Group key for page "types": first path segment + depth bucket. */
export function pathType(url: string): string {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    if (!segs.length) return "/";
    return `/${segs[0]}${segs.length > 1 ? "/*" : ""}`;
  } catch {
    return "?";
  }
}

/** Pick up to n urls spread across path patterns; homepage group first. */
export function sampleUrls(urls: string[], n: number): string[] {
  const uniq = [...new Set(urls)];
  if (uniq.length <= n) return uniq;
  const groups = new Map<string, string[]>();
  for (const u of uniq) {
    const k = pathType(u);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(u);
  }
  const order = [...groups.entries()].sort((a, b) => (a[0] === "/" ? -1 : b[0] === "/" ? 1 : b[1].length - a[1].length));
  // round-robin quotas so every page type gets a slot before any gets a second
  const quota = new Map<string, number>();
  let left = n;
  while (left > 0) {
    let progressed = false;
    for (const [k, list] of order) {
      if (left <= 0) break;
      if ((quota.get(k) ?? 0) < list.length) {
        quota.set(k, (quota.get(k) ?? 0) + 1);
        left--;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  const picked: string[] = [];
  for (const [k, list] of order) {
    const q = quota.get(k) ?? 0;
    for (let i = 0; i < q; i++) picked.push(list[Math.floor(((i + 0.5) * list.length) / q)]);
  }
  return picked;
}

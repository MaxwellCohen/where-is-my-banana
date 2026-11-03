import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzePage } from "./analyze.js";
import { gtmUrl } from "./gtm.js";
import { parseLighthouse, runLighthouse, type LighthouseSummary } from "./lighthouse.js";
import { Budget, fetchPage, fetchText, headAsset, pool, type NetOpts } from "./net.js";
import { planAssetsFor } from "./plan.js";
import { buildReport, formatMarkdown, type LiveReport } from "./report.js";
import { parseSitemap, sampleUrls } from "./sitemap.js";
import type { AssetInfo, LiveOptions, PageResult } from "./types.js";

export function normalizeUrl(u: string): string {
  const s = u.trim();
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

export async function expandSitemap(sitemapUrl: string, n: number, o: NetOpts): Promise<string[]> {
  const xml = await fetchText(sitemapUrl, o);
  if (!xml) throw new Error(`could not fetch sitemap ${sitemapUrl}`);
  let urls: string[] = [];
  // index -> children (sampled evenly, <=4 per level, 2 levels) so different page types are covered
  let level = [xml];
  for (let depth = 0; depth < 3 && level.length; depth++) {
    const next: string[] = [];
    for (const doc of level) {
      const parsed = parseSitemap(doc);
      urls = urls.concat(parsed.urls);
      const c = parsed.children;
      const kids = c.length <= 4 ? c : [0, 1, 2, 3].map((i) => c[Math.floor((i * c.length) / 4)]);
      for (const k of kids) {
        const x = await fetchText(k, o);
        if (x) next.push(x);
      }
    }
    level = next;
  }
  return sampleUrls(urls, n);
}

export async function runLive(opts: LiveOptions): Promise<LiveReport> {
  const budget = new Budget(opts.maxRequests);
  const net: NetOpts = { timeoutMs: opts.timeoutMs, userAgent: opts.userAgent, budget };
  const notes: string[] = [];
  let urls = opts.urls.map(normalizeUrl);
  if (opts.urlsFile) {
    urls = urls.concat(
      readFileSync(opts.urlsFile, "utf8").split(/\r?\n/).map((l: string) => l.trim()).filter((l: string) => l && !l.startsWith("#")).map(normalizeUrl),
    );
  }
  if (opts.sitemap) urls = urls.concat(await expandSitemap(normalizeUrl(opts.sitemap), opts.sample, net));
  urls = [...new Set(urls)];

  budget.reserved = urls.length;
  const assetCache = new Map<string, Promise<AssetInfo>>();
  const gtmCache = new Map<string, Promise<string | undefined>>();
  const errors: { url: string; error: string }[] = [];

  const pages = (
    await pool(urls, opts.concurrency, async (url): Promise<PageResult | undefined> => {
      try {
        const page = await fetchPage(url, net);
        budget.reserved = Math.max(0, budget.reserved - 1);
        const plan = planAssetsFor(page);
        const infos = await Promise.all(
          plan.assets.map((a) => {
            if (!assetCache.has(a.url)) assetCache.set(a.url, headAsset(a.url, a.kind, net));
            return assetCache.get(a.url)!;
          }),
        );
        const gtm: Record<string, string> = {};
        await Promise.all(
          plan.gtmIds.map(async (id) => {
            if (!gtmCache.has(id)) gtmCache.set(id, fetchText(gtmUrl(id), net, true));
            const src = await gtmCache.get(id)!;
            if (src) gtm[id] = src;
          }),
        );
        return analyzePage(page, { assets: Object.fromEntries(infos.map((i) => [i.url, i])), gtm });
      } catch (e) {
        errors.push({ url, error: e instanceof Error ? e.message : String(e) });
        return undefined;
      }
    })
  ).filter((p): p is PageResult => !!p);

  const lighthouse: LighthouseSummary[] = [];
  for (const f of opts.lighthouseJson) {
    try {
      lighthouse.push(parseLighthouse(JSON.parse(readFileSync(f, "utf8"))));
    } catch (e) {
      errors.push({ url: f, error: `cannot import Lighthouse JSON: ${e instanceof Error ? e.message : e}` });
    }
  }
  if (opts.lighthouse) {
    for (const p of pages.slice(0, 3)) {
      const r = await runLighthouse(p.finalUrl);
      if ("error" in r) {
        notes.push(r.error);
        break;
      }
      lighthouse.push(r);
    }
  }
  if (budget.exhausted) notes.push(`Request budget (${opts.maxRequests}) exhausted; some asset sizes/GTM containers were skipped. Raise --max-requests.`);
  notes.push("Transfer sizes are estimated from HEAD content-length (x0.33 for uncompressed text). TTFB includes DNS/TLS from this machine. Heuristics read server-rendered HTML only: client-injected scripts and CSS-file contents are not seen.");

  return buildReport({
    options: { ...opts, userAgent: opts.userAgent },
    requests: budget.used,
    budgetExhausted: budget.exhausted,
    pages,
    errors,
    lighthouse,
    notes,
  });
}

export function writeLive(report: LiveReport, outDir: string): string {
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "live.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(dir, "live.md"), formatMarkdown(report));
  return dir;
}

export { formatTerminal } from "./report.js";

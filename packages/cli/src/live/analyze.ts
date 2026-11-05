import { cacheStatus, detect, domChecks, headChecks, headerChecks, htmlSize, mk } from "./checks-page.js";
import { cssChecks, hintChecks, imageChecks, scriptChecks } from "./checks-assets.js";
import { findGtmIds, gtmChecks, parseGtm } from "./gtm.js";
import { parseHtml } from "./html.js";
import type { AssetMap, GtmSummary, PageInput, PageResult } from "./types.js";

export interface AnalyzeContext {
  assets?: AssetMap;
  /** gtm container id -> fetched gtm.js source */
  gtm?: Record<string, string>;
}

/** Pure: everything derives from the supplied page, asset sizes and GTM sources. */
export function analyzePage(page: PageInput, ctx: AnalyzeContext = {}): PageResult {
  const assets = ctx.assets ?? {};
  const p = parseHtml(page.html);
  const finalUrl = page.finalUrl ?? page.url;
  const findings = [];

  if (page.status && page.status >= 400) {
    findings.push(mk(page, "fetch", "http-error", "high", "code", `HTTP ${page.status} for ${finalUrl}.`, "Fix the route or remove it from sitemap/internal links."));
  }
  const ct = page.headers["content-type"];
  if (ct && !/html/i.test(ct)) {
    findings.push(mk(page, "fetch", "not-html", "low", "code", `Content-Type is ${ct}, not HTML.`, "Check the URL."));
  }

  const detection = detect(page, p);
  const size = htmlSize(page, p);
  findings.push(...size.findings, ...headerChecks(page, size.raw), ...headChecks(page, p));
  const sc = scriptChecks(page, p, assets);
  const css = cssChecks(page, p, assets);
  const img = imageChecks(page, p, assets);
  const hints = hintChecks(page, p, img.lcp);
  const dom = domChecks(page, p);
  findings.push(...sc.findings, ...css.findings, ...img.findings, ...hints.findings, ...dom.findings);

  const gtm: GtmSummary[] = [];
  for (const id of findGtmIds(page.html)) {
    const src = ctx.gtm?.[id];
    if (!src) continue;
    const g = parseGtm(id, src);
    gtm.push(g);
    findings.push(...gtmChecks(page, g));
  }

  return {
    url: page.url,
    finalUrl,
    status: page.status ?? 200,
    detection,
    metrics: {
      ttfbMs: Math.round(page.ttfbMs),
      totalMs: Math.round(page.totalMs ?? page.ttfbMs),
      htmlRaw: size.raw,
      htmlGzip: size.gzip,
      jsCount: sc.scripts.length,
      jsTransfer: sc.jsTransfer,
      thirdPartyCount: sc.scripts.filter((s) => s.thirdParty).length,
      thirdPartyTransfer: sc.tpBytes,
      cssBlocking: css.blockingCount,
      imagesTotal: img.total,
      imagesFlagged: img.flagged,
      domNodes: p.nodeCount,
      domDepth: p.maxDepth,
      hydrationMarkers: dom.markers,
      redirectHops: page.redirects?.length ?? 0,
      cacheStatus: cacheStatus(page.headers),
    },
    scripts: sc.scripts,
    stylesheets: css.sheets,
    vendors: sc.vendors,
    lcp: img.lcp,
    gtm,
    findings,
  };
}

export { planAssetsFor } from "./plan.js";

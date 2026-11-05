import { gzipSync } from "node:zlib";
import { byName, type Parsed } from "./html.js";
import type { Detection, Finding, Owner, PageInput, Severity } from "./types.js";

export function mk(
  page: { url: string },
  check: string,
  slug: string,
  severity: Severity,
  owner: Owner,
  message: string,
  fix: string,
  evidence?: Record<string, unknown>,
): Finding {
  return { id: `${check}/${slug}`, check, severity, url: page.url, message, fix, owner, ...(evidence ? { evidence } : {}) };
}

const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`;

// ---------- 9. detection ----------
export function detect(page: PageInput, p: Parsed): Detection {
  const h = page.headers;
  const html = page.html;
  const framework: string[] = [];
  const hosting: string[] = [];
  const cms: string[] = [];
  let buildId: string | undefined;

  const nd = nextData(p);
  const appRouter = /self\.__next_f/.test(html);
  if (appRouter) framework.push("Next.js (App Router)");
  else if (nd.raw !== undefined || /\/_next\/static\//.test(html)) framework.push("Next.js (Pages Router)");
  if (/^next\.js/i.test(h["x-powered-by"] ?? "") && !framework.length) framework.push("Next.js");
  if (nd.json && typeof nd.json.buildId === "string") buildId = nd.json.buildId;
  if (!buildId) buildId = html.match(/\/_next\/static\/([A-Za-z0-9_-]{8,})\/_(?:buildManifest|ssgManifest)\.js/)?.[1];
  if (/__NUXT__|\/_nuxt\//.test(html)) framework.push("Nuxt");
  if (/astro-island|\/_astro\//.test(html)) framework.push("Astro");
  if (/\/_gatsby|___gatsby/.test(html)) framework.push("Gatsby");
  if (/data-reactroot|__remixContext/.test(html) && /__remixContext/.test(html)) framework.push("Remix");

  if (h["x-vercel-id"] || /vercel/i.test(h.server ?? "")) hosting.push("Vercel");
  if (h["x-nf-request-id"] || /netlify/i.test(h.server ?? "")) hosting.push("Netlify");
  if (h["cf-ray"] || /cloudflare/i.test(h.server ?? "")) hosting.push("Cloudflare");
  if (h["x-amz-cf-id"] || /cloudfront/i.test(h.via ?? "")) hosting.push("CloudFront");
  if (h["x-served-by"] && /cache-/i.test(h["x-served-by"])) hosting.push("Fastly");
  if (/akamai/i.test(h.server ?? "") || h["x-akamai-transformed"]) hosting.push("Akamai");
  if (h["x-azure-ref"]) hosting.push("Azure Front Door");

  const cmsRules: [string, RegExp][] = [
    ["Contentful", /ctfassets\.net|contentful\.com/i],
    ["Sanity", /cdn\.sanity\.io|sanity\.io/i],
    ["Storyblok", /storyblok\.com/i],
    ["Builder.io", /cdn\.builder\.io|builder\.io/i],
    ["Sitecore", /sitecore|\/-\/media\/|sc_lang/i],
    ["Optimizely/Episerver", /episerver|optimizely-cms|\/globalassets\//i],
    ["WordPress", /\/wp-content\/|\/wp-includes\/|wp-json|content="WordPress/i],
    ["Prismic", /prismic\.io|images\.prismic/i],
    ["Contentstack", /contentstack\.(io|com)/i],
    ["Drupal", /\/sites\/default\/files|Drupal\.settings/i],
    ["AEM", /\/etc\.clientlibs\/|\/content\/dam\//i],
    ["Shopify", /cdn\.shopify\.com/i],
    ["Webflow", /webflow\.com|data-wf-page/i],
    ["HubSpot CMS", /hs-sites|hubspotusercontent/i],
    ["Kontent.ai", /kontent\.ai|kc-usercontent/i],
  ];
  for (const [name, re] of cmsRules) if (re.test(html)) cms.push(name);
  return { framework, hosting, cms, buildId };
}

// ---------- 1. html size ----------
export function nextData(p: Parsed): { raw?: string; json?: Record<string, any> } {
  const el = p.els.find((e) => e.name === "script" && e.attrs.id === "__NEXT_DATA__");
  if (!el) return {};
  const raw = el.text ?? "";
  try {
    return { raw, json: JSON.parse(raw) };
  } catch {
    return { raw };
  }
}

function topKeys(obj: unknown, prefix = "", depth = 0, out: { key: string; bytes: number }[] = []) {
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const bytes = Buffer.byteLength(JSON.stringify(v) ?? "");
    out.push({ key: prefix + k, bytes });
    if (depth < 2 && bytes > 2048) topKeys(v, `${prefix}${k}.`, depth + 1, out);
  }
  return out;
}

export function htmlSize(page: PageInput, p: Parsed) {
  const raw = Buffer.byteLength(page.html);
  const gzip = gzipSync(page.html).length;
  const nd = nextData(p);
  const ndBytes = nd.raw ? Buffer.byteLength(nd.raw) : 0;
  const chunks = p.els
    .filter((e) => e.name === "script" && e.text && e.text.includes("__next_f.push"))
    .map((e) => ({ bytes: Buffer.byteLength(e.text!), head: e.text!.replace(/\s+/g, " ").slice(0, 90) }));
  const rscBytes = chunks.reduce((a, c) => a + c.bytes, 0);
  const topChunks = [...chunks].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  const topNdKeys = nd.json?.props ? topKeys(nd.json.props).sort((a, b) => b.bytes - a.bytes).slice(0, 5) : [];

  const findings: Finding[] = [];
  if (gzip > 100 * 1024) {
    findings.push(
      mk(page, "html-size", "html-gzip", gzip > 250 * 1024 ? "high" : "medium", "code",
        `HTML is ${kb(gzip)} gzipped (${kb(raw)} raw); every visitor downloads and parses it before first render.`,
        "Find what dominates the document (see inline data findings), pass only the fields client components render, and move below-the-fold sections to streamed/Suspense or client fetches.",
        { raw, gzip }),
    );
  }
  const embedded = ndBytes + rscBytes;
  if (embedded > 50 * 1024) {
    findings.push(
      mk(page, "html-size", "inline-data", embedded > 150 * 1024 ? "high" : "medium", "code",
        `Inline hydration data is ${kb(embedded)} (__NEXT_DATA__ ${kb(ndBytes)}, RSC flight chunks ${kb(rscBytes)}).`,
        "Pass only the fields client components render (map CMS entries to small view-models in the server component), trim GraphQL/CMS queries (no deep includes, no unused fields), and avoid passing whole CMS responses as props to 'use client' components.",
        { bytes: embedded, nextData: ndBytes, rsc: rscBytes, topKeys: topNdKeys, topChunks },
      ),
    );
  }
  return { raw, gzip, ndBytes, rscBytes, findings };
}

// ---------- 2. headers ----------
export function cacheStatus(h: Record<string, string>): "hit" | "miss" | "stale" | "bypass" | "unknown" {
  const v = (h["x-vercel-cache"] ?? h["cf-cache-status"] ?? h["x-cache"] ?? h["x-nf-cache-status"] ?? "").toLowerCase();
  if (!v) return h.age && Number(h.age) > 0 ? "hit" : "unknown";
  if (/stale|revalidat|expired/.test(v)) return "stale";
  if (/bypass|dynamic|uncacheable/.test(v)) return "bypass";
  if (/hit|prerender/.test(v)) return "hit";
  if (/miss/.test(v)) return "miss";
  return "unknown";
}

export function headerChecks(page: PageInput, rawBytes: number): Finding[] {
  const h = page.headers;
  const out: Finding[] = [];
  const enc = (h["content-encoding"] ?? "").toLowerCase();
  const cc = (h["cache-control"] ?? "").toLowerCase();
  if (!enc && rawBytes > 2048) {
    out.push(mk(page, "headers", "no-compression", "high", "cdn",
      `HTML served without compression (${kb(rawBytes)} raw).`,
      "Enable brotli/gzip for text/html at the CDN/origin (Vercel/Cloudflare do this by default, so check for proxies or custom servers stripping it)."));
  } else if (enc === "gzip" && rawBytes > 20 * 1024) {
    out.push(mk(page, "headers", "gzip-not-br", "low", "cdn", "HTML is gzip, not brotli.", "Enable brotli at the CDN for ~15-20% smaller HTML."));
  }
  const cacheable = /s-maxage=([1-9]\d*)|max-age=([1-9]\d*)/.test(cc) && !/no-store|private/.test(cc);
  if (!cc) {
    out.push(mk(page, "headers", "no-cache-control", "medium", "cdn", "No cache-control header on HTML; CDN and browser caching behavior is undefined.",
      "Set Cache-Control: public, s-maxage=<seconds>, stale-while-revalidate=<seconds> on HTML (ISR/revalidate in Next, or CDN cache rules)."));
  } else if (/no-store|private|max-age=0/.test(cc) && !/s-maxage=[1-9]/.test(cc)) {
    out.push(mk(page, "headers", "html-not-cacheable", "medium", "code", `HTML is not CDN-cacheable (cache-control: ${h["cache-control"]}).`,
      "Make the route static/ISR (remove cookies()/headers()/force-dynamic/no-store fetches from the render path) or set s-maxage + stale-while-revalidate."));
  } else if (!/s-maxage/.test(cc) && !/stale-while-revalidate/.test(cc)) {
    out.push(mk(page, "headers", "no-swr", "low", "cdn", `cache-control has no s-maxage/stale-while-revalidate (${h["cache-control"]}).`,
      "Add s-maxage and stale-while-revalidate so the CDN can serve stale HTML while revalidating."));
  }
  const status = cacheStatus(h);
  if (status === "miss" || status === "bypass") {
    out.push(mk(page, "headers", "cdn-" + status, status === "bypass" ? "medium" : "low", "cdn",
      `CDN reported ${status.toUpperCase()} for the HTML (${h["x-vercel-cache"] ?? h["cf-cache-status"] ?? h["x-cache"]}).`,
      status === "bypass"
        ? "The CDN is not caching this HTML: check cache rules (Cloudflare needs a Cache Everything rule for HTML) and remove set-cookie/vary:cookie."
        : "First request after a deploy/expiry is a miss; re-run to confirm a HIT. If it stays a MISS the response is uncacheable (cookies, vary, no-store)."));
  }
  if (h["set-cookie"]) {
    const cookieNames = h["set-cookie"].split(/\n/).map((c) => c.split("=")[0].trim()).slice(0, 5);
    out.push(mk(page, "headers", "set-cookie", cacheable ? "high" : "medium", "code",
      `set-cookie on HTML (${cookieNames.join(", ")}); most CDNs refuse to cache responses that set cookies.`,
      "Stop setting cookies on page HTML (set them from client JS or a non-cached API/edge route), or strip them for cacheable routes at the CDN.", { cookies: cookieNames }));
  }
  if (/\bcookie\b/i.test(h.vary ?? "")) {
    out.push(mk(page, "headers", "vary-cookie", "medium", "code", `Vary: ${h.vary} fragments the CDN cache per cookie.`,
      "Remove Vary: Cookie from HTML (avoid reading cookies in cached routes; keep personalization client-side) or normalize cookies at the CDN."));
  }
  if (page.ttfbMs > 800) {
    out.push(mk(page, "headers", "slow-ttfb", page.ttfbMs > 1800 ? "high" : "medium", "code",
      `TTFB ${Math.round(page.ttfbMs)}ms (cache: ${status}).`,
      status === "hit" ? "Even a cached response is slow: check the CDN region / redirect chain." : "Serve this route from the CDN cache (static/ISR) or cut sequential CMS fetches in the render path.",
      { ttfbMs: Math.round(page.ttfbMs) }));
  }
  const xr = h["x-robots-tag"];
  if (xr && /noindex/i.test(xr)) {
    out.push(mk(page, "head", "x-robots-noindex", "high", "cdn", `X-Robots-Tag: ${xr}.`, "Remove noindex from the response header unless intentional (common leftover from staging)."));
  }
  return out;
}

// ---------- 8. head hygiene + redirects ----------
export function headChecks(page: PageInput, p: Parsed): Finding[] {
  const out: Finding[] = [];
  const head = p.els.filter((e) => e.inHead);
  const metas = byName(p, "meta");
  const named = (n: string) => metas.filter((m) => (m.attrs.name ?? "").toLowerCase() === n);
  if (!named("viewport").length) {
    out.push(mk(page, "head", "no-viewport", "high", "code", "No <meta name=viewport>; mobile browsers render at desktop width.",
      'Add <meta name="viewport" content="width=device-width, initial-scale=1"> (Next: export const viewport).'));
  }
  const titles = head.filter((e) => e.name === "title");
  if (titles.length > 1) out.push(mk(page, "head", "duplicate-title", "medium", "code", `${titles.length} <title> tags in <head>.`, "Emit one title (Next metadata API; remove manual <title> in layouts/CMS SEO components)."));
  if (!titles.length && p.els.some((e) => e.name === "head")) out.push(mk(page, "head", "no-title", "medium", "cms", "No <title> found.", "Set a title from the CMS SEO fields / generateMetadata."));
  const canon = head.filter((e) => e.name === "link" && (e.attrs.rel ?? "").toLowerCase().split(/\s+/).includes("canonical"));
  if (!canon.length) out.push(mk(page, "head", "no-canonical", "low", "code", "No canonical link.", "Add alternates.canonical in metadata."));
  if (canon.length > 1) out.push(mk(page, "head", "duplicate-canonical", "medium", "code", `${canon.length} canonical links.`, "Emit a single canonical."));
  for (const n of ["description", "robots"]) {
    if (named(n).length > 1) out.push(mk(page, "head", `duplicate-meta-${n}`, "low", "code", `${named(n).length} <meta name=${n}> tags.`, `Emit one meta ${n}.`));
  }
  if (!named("description").length) out.push(mk(page, "head", "no-description", "low", "cms", "No meta description.", "Populate the meta description from the CMS SEO fields."));
  const robots = named("robots").concat(named("googlebot")).map((m) => m.attrs.content ?? "").join(",");
  if (/noindex/i.test(robots)) out.push(mk(page, "head", "noindex", "high", "code", `Page has noindex (${robots}).`, "Remove noindex unless intentional (check env-gated robots metadata leaking to production)."));
  const refresh = metas.find((m) => (m.attrs["http-equiv"] ?? "").toLowerCase() === "refresh");
  if (refresh) out.push(mk(page, "head", "meta-refresh", "medium", "code", `<meta http-equiv=refresh content="${refresh.attrs.content}">.`, "Replace with a server-side 301/308 redirect."));
  const html = p.els.find((e) => e.name === "html");
  if (html && !html.attrs.lang) out.push(mk(page, "head", "no-lang", "low", "code", "<html> has no lang attribute.", "Set lang on <html>."));

  const hops = page.redirects ?? [];
  if (hops.length) {
    const total = Math.round(hops.reduce((a, x) => a + x.ms, 0));
    const kinds = new Set<string>();
    for (const x of hops) {
      try {
        const a = new URL(x.url);
        const b = new URL(x.location ?? "", x.url);
        if (a.protocol !== b.protocol) kinds.add("http->https");
        if (a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "") && a.hostname !== b.hostname) kinds.add("www");
        if (a.pathname !== b.pathname && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "")) kinds.add("trailing-slash");
      } catch {
        /* ignore */
      }
    }
    out.push(mk(page, "redirects", "chain", hops.length >= 3 ? "high" : hops.length === 2 ? "medium" : "low", "cdn",
      `${hops.length} redirect hop(s) before the page, ${total}ms: ${hops.map((x) => `${x.status} ${x.url}`).join(" -> ")} -> ${page.finalUrl ?? ""}${kinds.size ? ` (${[...kinds].join(", ")})` : ""}.`,
      "Link internally to the final canonical URL (scheme, www, trailing slash) and collapse redirects into a single hop at the CDN/edge (next.config trailingSlash/redirects, DNS-level www handling).",
      { hops, totalMs: total }));
  }
  return out;
}

// ---------- 10. DOM weight ----------
export function domChecks(page: PageInput, p: Parsed) {
  const markers = (page.html.match(/<!--\$[!?]?-->|<!--\/\$-->|<template id="B:|data-dgst=/g) ?? []).length;
  const findings: Finding[] = [];
  if (p.nodeCount > 1500) {
    findings.push(mk(page, "dom", "dom-size", p.nodeCount > 3000 ? "high" : "medium", "code",
      `~${p.nodeCount} elements in the HTML (depth ~${p.maxDepth}, ${p.inlineStyleAttrs} inline styles, ${markers} hydration/suspense markers).`,
      "Cut rendered DOM: virtualize or paginate long lists, lazy-render below-the-fold sections and hidden mobile/desktop duplicates (render one, not both), and avoid wrapper-div-per-block CMS renderers.",
      { nodes: p.nodeCount, depth: p.maxDepth }));
  }
  if (p.maxDepth > 32) {
    findings.push(mk(page, "dom", "dom-depth", "low", "code", `Estimated DOM depth ${p.maxDepth}.`, "Flatten nested wrappers produced by CMS block renderers."));
  }
  return { markers, findings };
}

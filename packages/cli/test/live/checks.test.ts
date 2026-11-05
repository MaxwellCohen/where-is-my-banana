import { describe, expect, it } from "vitest";
import { GOOD, ids, run } from "./helpers.js";
import { parseGtm, gtmChecks, findGtmIds } from "../../src/live/gtm.js";
import { parseLighthouse } from "../../src/live/lighthouse.js";
import { sampleUrls, parseSitemap } from "../../src/live/sitemap.js";
import { crossPage } from "../../src/live/report.js";

const wrap = (head: string, body = "") => `<!doctype html><html lang="en"><head><title>T</title><meta name="viewport" content="width=device-width"><meta name="description" content="d"><link rel="canonical" href="/">${head}</head><body>${body}</body></html>`;

describe("clean page", () => {
  it("has no findings", () => expect(run(GOOD).findings).toEqual([]));
});

describe("1 html-size", () => {
  it("flags big gzip html and inline data", () => {
    const big = JSON.stringify({ props: { pageProps: { cms: Array.from({ length: 6000 }, (_, i) => ({ id: i, t: Math.random().toString(36) })), small: 1 } } });
    const r = run(wrap(`<script id="__NEXT_DATA__" type="application/json">${big}</script>`));
    expect(ids(r)).toContain("html-size/inline-data");
    const f = r.findings.find((x) => x.id === "html-size/inline-data")!;
    expect((f.evidence!.topKeys as any[]).map((k) => k.key).join()).toContain("pageProps.cms");
  });
  it("sums RSC chunks", () => {
    const chunk = `self.__next_f.push([1,"${"x".repeat(30000)}"])`;
    const r = run(wrap("", `<script>${chunk}</script><script>${chunk}</script>`));
    const f = r.findings.find((x) => x.id === "html-size/inline-data")!;
    expect(f.evidence!.rsc).toBeGreaterThan(60000);
    expect((f.evidence!.topChunks as any[]).length).toBe(2);
  });
  it("negative: small data", () => expect(ids(run(wrap(`<script id="__NEXT_DATA__">{"props":{}}</script>`)))).not.toContain("html-size/inline-data"));
});

describe("2 headers", () => {
  const h = (x: Record<string, string>) => run(GOOD, { headers: x });
  it("no compression", () => expect(ids(run("a".repeat(5000), { headers: {} }))).toContain("headers/no-compression"));
  it("no cache-control", () => expect(ids(h({ "content-encoding": "br" }))).toContain("headers/no-cache-control"));
  it("not cacheable", () => expect(ids(h({ "content-encoding": "br", "cache-control": "private, no-store" }))).toContain("headers/html-not-cacheable"));
  it("set-cookie high when cacheable", () => {
    const r = h({ "content-encoding": "br", "cache-control": "public, s-maxage=60", "set-cookie": "sid=1; Path=/" });
    expect(r.findings.find((f) => f.id === "headers/set-cookie")!.severity).toBe("high");
  });
  it("vary cookie", () => expect(ids(h({ "content-encoding": "br", "cache-control": "public, s-maxage=1, stale-while-revalidate=1", vary: "Cookie" }))).toContain("headers/vary-cookie"));
  it("cdn miss / bypass", () => {
    expect(ids(h({ "content-encoding": "br", "cache-control": "public, s-maxage=1, stale-while-revalidate=1", "x-vercel-cache": "MISS" }))).toContain("headers/cdn-miss");
    expect(ids(h({ "content-encoding": "br", "cache-control": "public, s-maxage=1, stale-while-revalidate=1", "cf-cache-status": "DYNAMIC" }))).toContain("headers/cdn-bypass");
  });
  it("hit is fine, metric reported", () => {
    const r = h({ "content-encoding": "br", "cache-control": "public, s-maxage=1, stale-while-revalidate=1", "x-vercel-cache": "HIT" });
    expect(r.findings).toEqual([]);
    expect(r.metrics.cacheStatus).toBe("hit");
  });
  it("slow ttfb", () => {
    expect(ids(run(GOOD, { ttfbMs: 2000 }))).toContain("headers/slow-ttfb");
    expect(ids(run(GOOD, { ttfbMs: 300 }))).not.toContain("headers/slow-ttfb");
  });
});

describe("3 scripts", () => {
  it("blocking head + vendor grouping + weights", () => {
    const html = wrap(`<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC123"></script><script src="/a.js" defer></script><script src="https://connect.facebook.net/en_US/fbevents.js" async></script>`);
    const r = run(html, {}, { assets: { "https://www.googletagmanager.com/gtm.js?id=GTM-ABC123": { url: "x", bytes: 200000, transferEst: 70000 }, "https://connect.facebook.net/en_US/fbevents.js": { url: "y", bytes: 90000, transferEst: 30000 } } });
    expect(ids(r)).toContain("scripts/blocking-head");
    expect(r.vendors.map((v) => v.vendor)).toEqual(["Google Tag Manager", "Meta Pixel"]);
    expect(r.scripts[1].thirdParty).toBe(false);
    expect(r.metrics.thirdPartyTransfer).toBe(100000);
  });
  it("negative: async/defer/module", () => {
    const r = run(wrap(`<script src="/a.js" async></script><script src="/b.js" defer></script><script type="module" src="/c.js"></script>`));
    expect(ids(r)).not.toContain("scripts/blocking-head");
  });
  it("third-party weight", () => {
    const html = wrap(`<script src="https://x.hotjar.com/a.js" async></script>`);
    const r = run(html, {}, { assets: { "https://x.hotjar.com/a.js": { url: "", bytes: 1, transferEst: 700 * 1024 } } });
    expect(ids(r)).toContain("scripts/third-party-weight");
    expect(r.findings.find((f) => f.id === "scripts/third-party-weight")!.owner).toBe("gtm");
  });
});

describe("4 GTM", () => {
  const src = `{"function":"__html"},{"function":"__html"},{"function":"__ua"} fbq('init') hotjar clarity.ms ` + "x".repeat(120 * 1024);
  it("finds ids and parses", () => {
    expect(findGtmIds(`<script src="https://www.googletagmanager.com/gtm.js?id=GTM-XYZ12"></script>`)).toEqual(["GTM-XYZ12"]);
    const g = parseGtm("GTM-XYZ12", src);
    expect(g.tagTypes.__html).toBe(2);
    expect(g.vendors).toEqual(expect.arrayContaining(["Meta Pixel", "Hotjar", "Microsoft Clarity"]));
    expect(gtmChecks({ url: "u" }, g).map((f) => f.id)).toContain("gtm/container-size");
  });
  it("many vendors; negative small", () => {
    const many = "fbq hotjar linkedin.com ads/ga-audiences clarity.ms tiktok bat.bing.com optimizely fullstory pintrk hubspot callrail";
    expect(gtmChecks({ url: "u" }, parseGtm("G", many)).map((f) => f.id)).toContain("gtm/many-vendors");
    expect(gtmChecks({ url: "u" }, parseGtm("G", "fbq"))).toEqual([]);
  });
  it("analyzePage wires gtm", () => {
    const r = run(wrap(`<script async src="https://www.googletagmanager.com/gtm.js?id=GTM-XYZ12"></script>`), {}, { gtm: { "GTM-XYZ12": src } });
    expect(ids(r)).toContain("gtm/container-size");
    expect(r.gtm).toHaveLength(1);
  });
});

describe("5 css/fonts", () => {
  it("many blocking css, import, google fonts, font-display, preload crossorigin", () => {
    const links = Array.from({ length: 6 }, (_, i) => `<link rel="stylesheet" href="/c${i}.css">`).join("");
    const r = run(wrap(links + `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><style>@import url(x.css);@font-face{font-family:a;src:url(/a.woff2)}</style><link rel="preload" as="font" href="/a.woff2">`));
    expect(ids(r)).toEqual(expect.arrayContaining(["css/many-blocking-css", "css/css-import", "fonts/google-fonts-link", "fonts/font-display-missing", "fonts/preload-no-crossorigin"]));
  });
  it("large css via HEAD", () => {
    const r = run(wrap(`<link rel="stylesheet" href="/big.css">`), {}, { assets: { "https://www.example.com/big.css": { url: "", bytes: 400000, transferEst: 130000 } } });
    expect(ids(r)).toContain("css/large-css");
  });
  it("negative", () => {
    const r = run(wrap(`<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/p.css" media="print"><style>@font-face{font-display:swap;src:url(/a.woff2)}</style><link rel="preload" as="font" href="/a.woff2" crossorigin>`));
    expect(r.findings).toEqual([]);
    expect(r.metrics.cssBlocking).toBe(1);
  });
});

describe("6 images", () => {
  it("lazy LCP, missing dims/alt/sizes, legacy, oversized", () => {
    const body = `<img src="/hero.jpg" loading="lazy" alt="h"><img src="/a.png" srcset="/a1.png 400w, /a2.png 800w"><img src="/b.jpg" width="10" height="10" alt="">`;
    const r = run(wrap("", body), {}, { assets: { "https://www.example.com/hero.jpg": { url: "", bytes: 900000, contentType: "image/jpeg" } } });
    expect(ids(r)).toEqual(expect.arrayContaining(["images/lcp-lazy", "images/missing-dimensions", "images/missing-alt", "images/srcset-no-sizes", "images/legacy-format", "images/oversized"]));
    expect(r.metrics.imagesFlagged).toBeGreaterThan(0);
  });
  it("lcp without priority vs preloaded vs priority", () => {
    const img = `<img src="/h.webp" width="1200" height="600" alt="">`;
    expect(ids(run(wrap("", img)))).toContain("images/lcp-no-priority");
    const pre = run(wrap(`<link rel="preload" as="image" href="/h.webp">`, img));
    expect(pre.lcp!.preloaded).toBe(true);
    expect(ids(pre)).not.toContain("images/lcp-no-priority");
    expect(ids(run(wrap("", img.replace("<img", '<img fetchpriority="high"'))))).not.toContain("images/lcp-no-priority");
  });
  it("next/image preload matched through url param", () => {
    const src = "/_next/image?url=%2Fh.jpg&w=1080&q=75";
    const r = run(wrap(`<link rel="preload" as="image" imagesrcset="${src} 1x">`, `<img src="${src}" width="1080" height="500" alt="" fetchpriority="high">`));
    expect(r.lcp!.preloaded).toBe(true);
    expect(r.findings).toEqual([]);
  });
  it("hero background candidate", () => {
    const r = run(wrap("", `<div style="background-image:url('/hero.webp')"></div>`));
    expect(ids(r)).toContain("images/lcp-no-priority");
  });
  it("ignores noscript imgs and svg/tiny", () => {
    const r = run(wrap("", `<noscript><img src="/x.jpg"></noscript><img src="/logo.svg"><img src="/dot.gif" width="1" height="1" alt="">`));
    expect(r.lcp).toBeUndefined();
  });
});

describe("7 hints", () => {
  it("unused preconnect, missing image preconnect, too many preloads", () => {
    const pre = Array.from({ length: 7 }, (_, i) => `<link rel="preload" as="script" href="/p${i}.js">`).join("");
    const r = run(wrap(`<link rel="preconnect" href="https://unused.example.net">${pre}`, `<img src="https://images.ctfassets.net/a.webp?w=1" width="800" height="400" alt="">`));
    expect(ids(r)).toEqual(expect.arrayContaining(["hints/unused-preconnect", "hints/missing-preconnect", "hints/too-many-preloads"]));
  });
  it("negative", () => {
    const r = run(wrap(`<link rel="preconnect" href="https://images.ctfassets.net"><link rel="preload" as="image" href="https://images.ctfassets.net/a.webp?w=1">`, `<img src="https://images.ctfassets.net/a.webp?w=1" width="800" height="400" alt="" fetchpriority="high">`));
    expect(r.findings.filter((f) => f.check === "hints")).toEqual([]);
  });
});

describe("8 head + redirects", () => {
  it("missing viewport, dup title, noindex, refresh", () => {
    const r = run(`<html><head><title>a</title><title>b</title><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=/x"></head><body></body></html>`);
    expect(ids(r)).toEqual(expect.arrayContaining(["head/no-viewport", "head/duplicate-title", "head/noindex", "head/meta-refresh", "head/no-canonical", "head/no-lang"]));
  });
  it("x-robots-tag", () => expect(ids(run(GOOD, { headers: { "content-encoding": "br", "cache-control": "s-maxage=5, stale-while-revalidate=1", "x-robots-tag": "noindex" } }))).toContain("head/x-robots-noindex"));
  it("redirect chain severity", () => {
    const hop = (u: string, l: string) => ({ url: u, status: 301, location: l, ms: 50 });
    const r = run(GOOD, { redirects: [hop("http://example.com/a", "https://example.com/a"), hop("https://example.com/a", "https://www.example.com/a"), hop("https://www.example.com/a", "https://www.example.com/a/")], finalUrl: "https://www.example.com/a/" });
    const f = r.findings.find((x) => x.id === "redirects/chain")!;
    expect(f.severity).toBe("high");
    expect(f.message).toMatch(/http->https/);
    expect(f.message).toMatch(/trailing-slash/);
  });
  it("no redirects negative", () => expect(ids(run(GOOD))).not.toContain("redirects/chain"));
});

describe("9 detection", () => {
  it("next app router + vercel + contentful", () => {
    const r = run(wrap("", `<img src="https://images.ctfassets.net/a.webp?w=1" width="400" height="400" alt=""><script>self.__next_f.push([1,"a"])</script>`), { headers: { "x-vercel-id": "iad1::x", "content-encoding": "br", "cache-control": "s-maxage=1, stale-while-revalidate=1" } });
    expect(r.detection.framework).toContain("Next.js (App Router)");
    expect(r.detection.hosting).toContain("Vercel");
    expect(r.detection.cms).toContain("Contentful");
  });
  it("pages router build id", () => {
    const r = run(wrap(`<script id="__NEXT_DATA__" type="application/json">{"buildId":"abc123","props":{}}</script>`));
    expect(r.detection.framework).toContain("Next.js (Pages Router)");
    expect(r.detection.buildId).toBe("abc123");
  });
});

describe("10 DOM", () => {
  it("flags >1500 nodes", () => {
    const r = run(wrap("", "<div><span>x</span></div>".repeat(900) + "<!--$--><!--/$-->"));
    expect(ids(r)).toContain("dom/dom-size");
    expect(r.metrics.hydrationMarkers).toBe(2);
  });
  it("negative", () => expect(ids(run(wrap("", "<div>x</div>".repeat(50))))).not.toContain("dom/dom-size"));
  it("depth", () => expect(ids(run(wrap("", "<div>".repeat(40))))).toContain("dom/dom-depth"));
});

describe("11 lighthouse import", () => {
  const report = {
    finalUrl: "https://www.example.com/",
    categories: { performance: { score: 0.42 } },
    audits: {
      "largest-contentful-paint": { numericValue: 4200 },
      "total-blocking-time": { numericValue: 800 },
      "cumulative-layout-shift": { numericValue: 0.2 },
      "unused-javascript": { title: "Reduce unused JavaScript", score: 0.2, description: "x [Learn more](https://a).", details: { overallSavingsMs: 900, overallSavingsBytes: 300000 } },
      "uses-optimized-images": { title: "Efficiently encode images", score: 1, details: {} },
      "third-party-summary": { title: "Reduce third-party code", score: 0.3, details: { overallSavingsMs: 400 } },
    },
  };
  it("extracts metrics and findings", () => {
    const s = parseLighthouse(report);
    expect(s.score).toBe(42);
    expect(s.metrics.lcp).toBe(4200);
    const uj = s.findings.find((f) => f.id === "lighthouse/unused-javascript")!;
    expect(uj.severity).toBe("high");
    expect(uj.message).toMatch(/900ms/);
    expect(s.findings.find((f) => f.id === "lighthouse/third-party-summary")!.owner).toBe("gtm");
    expect(s.findings.find((f) => f.id === "lighthouse/uses-optimized-images")).toBeUndefined();
  });
});

describe("12 cross-page + sampling", () => {
  const page = (url: string, extra: string) => run(wrap(`<script src="/shared.js" async></script>${extra}`), { url, finalUrl: url }, {
    assets: { "https://www.example.com/shared.js": { url: "", bytes: 1, transferEst: 100000 }, "https://www.example.com/map.js": { url: "", bytes: 1, transferEst: 400000 } },
  });
  it("highlights heavy page type", () => {
    const pages = [page("https://www.example.com/", ""), page("https://www.example.com/blog/a", ""), page("https://www.example.com/locations/x", `<script src="/map.js" async></script>`)];
    const { cross, findings } = crossPage(pages);
    expect(cross.sharedScripts.map((s) => s.url)).toEqual(["https://www.example.com/shared.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].url).toContain("/locations/");
    expect(cross.heavy[0].extraScripts[0]).toContain("map.js");
  });
  it("sampleUrls covers page types", () => {
    const urls = [...Array.from({ length: 50 }, (_, i) => `https://s.com/blog/p${i}`), ...Array.from({ length: 10 }, (_, i) => `https://s.com/locations/l${i}`), "https://s.com/", "https://s.com/about"];
    const s = sampleUrls(urls, 6);
    expect(s).toHaveLength(6);
    expect(s).toContain("https://s.com/");
    expect(s.some((u) => u.includes("/locations/"))).toBe(true);
    expect(s.some((u) => u.includes("/blog/"))).toBe(true);
  });
  it("parseSitemap index vs urlset", () => {
    expect(parseSitemap(`<sitemapindex><sitemap><loc>https://a/s1.xml</loc></sitemap></sitemapindex>`).children).toEqual(["https://a/s1.xml"]);
    expect(parseSitemap(`<urlset><url><loc>https://a/x?a=1&amp;b=2</loc></url></urlset>`).urls).toEqual(["https://a/x?a=1&b=2"]);
  });
});

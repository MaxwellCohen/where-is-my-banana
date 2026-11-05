import { byName, isThirdParty, registrable, resolveUrl, type El, type Parsed } from "./html.js";
import { mk } from "./checks-page.js";
import { vendorFor } from "./vendors.js";
import type { AssetMap, Finding, PageInput, ScriptInfo, VendorStat } from "./types.js";

const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`;

export function estimateTransfer(bytes: number, encoding: string | undefined, contentType: string | undefined): number {
  if (encoding) return bytes;
  if (/javascript|css|json|html|svg|xml|text\//i.test(contentType ?? "")) return Math.round(bytes * 0.33);
  return bytes;
}

const rels = (e: El) => (e.attrs.rel ?? "").toLowerCase().split(/\s+/);

// ---------- 3. scripts ----------
export function scriptChecks(page: PageInput, p: Parsed, assets: AssetMap) {
  const base = page.finalUrl ?? page.url;
  const scripts: ScriptInfo[] = [];
  for (const e of byName(p, "script")) {
    if (!e.attrs.src) continue;
    const url = resolveUrl(e.attrs.src, base);
    if (!url) continue;
    if ("nomodule" in e.attrs) continue;
    const mode = "async" in e.attrs ? "async" : e.attrs.type === "module" ? "module" : "defer" in e.attrs ? "defer" : "blocking";
    const a = assets[url];
    scripts.push({
      url,
      host: new URL(url).hostname,
      thirdParty: isThirdParty(url, base),
      vendor: vendorFor(url),
      mode,
      inHead: e.inHead,
      bytes: a?.bytes,
      transferEst: a?.transferEst,
    });
  }
  const findings: Finding[] = [];
  const blockingHead = scripts.filter((s) => s.inHead && s.mode === "blocking");
  if (blockingHead.length) {
    const tp = blockingHead.filter((s) => s.thirdParty);
    findings.push(mk(page, "scripts", "blocking-head", "high", "code",
      `${blockingHead.length} parser-blocking script(s) in <head> (${tp.length} third-party): ${blockingHead.slice(0, 4).map((s) => s.url).join(", ")}.`,
      "Add async or defer (next/script strategy=\"afterInteractive\"/\"lazyOnload\"; plain <script src> in a layout/CMS head field should become next/script). For tags injected from the CMS or GTM, move them into GTM with a non-blocking trigger.",
      { scripts: blockingHead.map((s) => s.url) }));
  }
  const blockingBody = scripts.filter((s) => !s.inHead && s.mode === "blocking" && s.thirdParty);
  if (blockingBody.length) {
    findings.push(mk(page, "scripts", "blocking-body-third-party", "medium", "code",
      `${blockingBody.length} synchronous third-party script(s) in <body>: ${blockingBody.slice(0, 4).map((s) => s.url).join(", ")}.`,
      "Load with async/defer or next/script strategy lazyOnload.", { scripts: blockingBody.map((s) => s.url) }));
  }
  if (scripts.length > 25) {
    findings.push(mk(page, "scripts", "script-count", scripts.length > 40 ? "medium" : "low", "code",
      `${scripts.length} external <script> tags.`,
      "Reduce route-level chunks: dynamic-import heavy client components, remove unused client dependencies (run `wimb wins` for a ranked list)."));
  }

  // vendor grouping
  const vm = new Map<string, VendorStat>();
  for (const s of scripts.filter((x) => x.thirdParty)) {
    const v = s.vendor ?? registrable(s.host);
    const cur = vm.get(v) ?? { vendor: v, count: 0, bytes: 0 };
    cur.count++;
    cur.bytes += s.transferEst ?? 0;
    vm.set(v, cur);
  }
  // vendors referenced only in inline scripts (dynamically injected)
  const inlineText = byName(p, "script").filter((e) => !e.attrs.src).map((e) => e.text ?? "").join("\n").toLowerCase();
  for (const name of new Set(
    [...inlineText.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'`)]*/g)].map((m) => vendorFor(m[0])).filter((x): x is string => !!x),
  )) {
    if (!vm.has(name)) vm.set(name, { vendor: name, count: 0, bytes: 0 });
  }
  const vendors = [...vm.values()].sort((a, b) => b.bytes - a.bytes || b.count - a.count);
  const tpBytes = scripts.filter((s) => s.thirdParty).reduce((a, s) => a + (s.transferEst ?? 0), 0);
  if (tpBytes > 300 * 1024 || vendors.filter((v) => v.bytes > 0).length > 12) {
    const top = vendors.slice(0, 5).map((v) => `${v.vendor} ${kb(v.bytes)}`).join(", ");
    findings.push(mk(page, "scripts", "third-party-weight", tpBytes > 600 * 1024 ? "high" : "medium", "gtm",
      `Third-party scripts weigh ~${kb(tpBytes)} (est. transfer) across ${vendors.length} vendors. Top: ${top}.`,
      "Remove unused vendors, load the rest after interaction/idle (GTM trigger on Window Loaded / consent, or next/script lazyOnload), and consider Partytown for analytics. Biggest offenders first.",
      { bytes: tpBytes, vendors: vendors.slice(0, 8) }));
  }
  const firstBytes = scripts.filter((s) => !s.thirdParty).reduce((a, s) => a + (s.transferEst ?? 0), 0);
  if (firstBytes > 350 * 1024) {
    findings.push(mk(page, "scripts", "first-party-js", firstBytes > 600 * 1024 ? "high" : "medium", "code",
      `First-party JS is ~${kb(firstBytes)} (est. transfer, ${scripts.filter((s) => !s.thirdParty).length} files).`,
      "Run `wimb wins` against the source repo to find import edges to cut or make lazy; dynamic-import below-the-fold and modal/widget components.", { bytes: firstBytes }));
  }
  return { scripts, vendors, findings, jsTransfer: scripts.reduce((a, s) => a + (s.transferEst ?? 0), 0), tpBytes };
}

// ---------- 5. CSS + fonts ----------
export function cssChecks(page: PageInput, p: Parsed, assets: AssetMap) {
  const base = page.finalUrl ?? page.url;
  const findings: Finding[] = [];
  const links = byName(p, "link");
  const sheets = links
    .filter((e) => rels(e).includes("stylesheet") && e.attrs.href)
    .map((e) => ({ el: e, url: resolveUrl(e.attrs.href, base)! }))
    .filter((s) => s.url);
  const blocking = sheets.filter((s) => s.el.inHead && !/^print$/i.test(s.el.attrs.media ?? "") && s.el.attrs.media !== "x" && !("disabled" in s.el.attrs));
  const sheetInfo = sheets.map((s) => ({ url: s.url, bytes: assets[s.url]?.bytes }));
  if (blocking.length > 4) {
    findings.push(mk(page, "css", "many-blocking-css", blocking.length > 8 ? "high" : "medium", "code",
      `${blocking.length} render-blocking stylesheets in <head>.`,
      "Merge CSS (Tailwind/CSS Modules chunking, Next `experimental.cssChunking`), inline critical CSS, and load non-critical sheets with media=print onload swap.", { urls: blocking.map((s) => s.url) }));
  }
  for (const s of sheets) {
    const a = assets[s.url];
    const size = a?.bytes ?? 0;
    const transfer = a?.transferEst ?? 0;
    if (transfer > 100 * 1024 || (a && !a.encoding && size > 250 * 1024)) {
      findings.push(mk(page, "css", "large-css", "medium", "code", `Stylesheet ${s.url} is ~${kb(Math.max(transfer, 0))} transfer (${kb(size)} reported).`,
        "Purge unused CSS (Tailwind content globs, remove legacy global sheets/CMS theme CSS), split per route.", { url: s.url, bytes: size }));
    }
  }
  const inlineCss = byName(p, "style").map((e) => e.text ?? "");
  const importHit = inlineCss.some((t) => /@import\s/i.test(t));
  if (importHit) findings.push(mk(page, "css", "css-import", "medium", "code", "@import in inline <style> creates a serial CSS request chain.", "Replace @import with <link> tags or bundle the CSS."));
  const inlineBytes = inlineCss.reduce((a, t) => a + Buffer.byteLength(t), 0);
  if (inlineBytes > 80 * 1024) {
    findings.push(mk(page, "css", "large-inline-css", "low", "code", `${kb(inlineBytes)} of inline <style> CSS in the HTML.`, "Inline only critical CSS; the rest should be a cacheable file.", { bytes: inlineBytes }));
  }

  // fonts
  const cssText = inlineCss.join("\n");
  const fontUrls = new Set<string>();
  for (const m of cssText.matchAll(/url\(\s*["']?([^"')]+\.(?:woff2?|ttf|otf))(?:\?[^"')]*)?["']?\s*\)/gi)) {
    const u = resolveUrl(m[1], base);
    if (u) fontUrls.add(u);
  }
  const fontPreloads = links.filter((e) => rels(e).includes("preload") && (e.attrs.as ?? "").toLowerCase() === "font");
  for (const e of fontPreloads) {
    const u = resolveUrl(e.attrs.href ?? "", base);
    if (u) fontUrls.add(u);
  }
  const google = links.filter((e) => /fonts\.googleapis\.com\/(css|icon)/.test(e.attrs.href ?? ""));
  if (google.length) {
    const noSwap = google.filter((e) => !/display=(swap|optional|fallback)/.test(e.attrs.href));
    findings.push(mk(page, "fonts", "google-fonts-link", noSwap.length ? "medium" : "low", "code",
      `Google Fonts loaded via <link> (${google.length})${noSwap.length ? " without display=swap" : ""}: adds two cross-origin connections and a blocking CSS request.`,
      "Self-host with next/font (zero layout shift, no third-party round trip) or at least add &display=swap and preconnect to fonts.gstatic.com.", { urls: google.map((e) => e.attrs.href) }));
  }
  const faces = (cssText.match(/@font-face\s*\{[^}]*\}/gi) ?? []);
  const noDisplay = faces.filter((f) => !/font-display/i.test(f));
  if (noDisplay.length) {
    findings.push(mk(page, "fonts", "font-display-missing", "medium", "code", `${noDisplay.length}/${faces.length} inline @font-face rules lack font-display.`, "Add font-display: swap (or optional) to every @font-face; next/font does this by default."));
  }
  for (const e of fontPreloads) {
    if (!("crossorigin" in e.attrs)) {
      findings.push(mk(page, "fonts", "preload-no-crossorigin", "medium", "code", `Font preload ${e.attrs.href} lacks crossorigin; the browser fetches the font twice.`, "Add crossorigin (anonymous) to font preload links."));
      break;
    }
  }
  const woff = [...fontUrls].filter((u) => /\.woff2?($|\?)/.test(u));
  if (woff.length > 6) {
    findings.push(mk(page, "fonts", "many-fonts", "medium", "code", `${woff.length} woff/woff2 font files referenced; each weight/style is a request.`, "Use a variable font or cut unused weights/styles.", { urls: woff.slice(0, 10) }));
  }
  const preloadedFonts = new Set(fontPreloads.map((e) => resolveUrl(e.attrs.href ?? "", base)));
  const unpreloaded = woff.filter((u) => !preloadedFonts.has(u));
  if (woff.length && !fontPreloads.length && unpreloaded.length && !google.length) {
    findings.push(mk(page, "fonts", "no-font-preload", "low", "code", `${woff.length} font file(s) referenced in CSS with no <link rel=preload as=font>.`, "Preload the one or two above-the-fold fonts (next/font does this automatically).", { urls: unpreloaded.slice(0, 5) }));
  }
  return { findings, blockingCount: blocking.length, sheets: sheetInfo, fontCount: woff.length };
}

// ---------- 6. images + LCP ----------
const IMG_CDN = /ctfassets\.net|cdn\.sanity\.io|cdn\.builder\.io|cloudinary\.com|imgix\.net|cdn\.shopify\.com|imagekit\.io|a\.storyblok\.com|images\.prismic\.io|images\.contentstack\.io|assets\.|\/cdn-cgi\/image\//i;
const OPT_PARAM = /[?&](w|width|h|height|q|quality|fm|format|auto|fit|dpr)=|\/(f_auto|w_\d+|q_auto)|\/cdn-cgi\/image\//i;
const LEGACY_EXT = /\.(jpe?g|png|gif)($|\?|#)/i;

interface ImgCand {
  src: string;
  srcset?: string;
  sizes?: string;
  el: El;
  fromPicture: boolean;
  modern: boolean;
  bg: boolean;
}

export function firstSrcsetUrl(srcset: string | undefined): string | undefined {
  return srcset?.split(",")[0]?.trim().split(/\s+/)[0];
}

function underlying(u: string): string {
  try {
    const x = new URL(u, "http://x");
    const inner = x.searchParams.get("url");
    return inner ? decodeURIComponent(inner) : x.pathname + (x.pathname.startsWith("/_next/image") ? "" : "");
  } catch {
    return u;
  }
}

export function imageChecks(page: PageInput, p: Parsed, assets: AssetMap) {
  const base = page.finalUrl ?? page.url;
  const findings: Finding[] = [];
  const cands: ImgCand[] = [];
  // picture <source> modern formats
  const pictureModern = new Map<number, boolean>();
  let lastPicture: number | undefined;
  for (const e of p.els) {
    if (e.name === "picture") lastPicture = e.pos;
    if (e.name === "source" && lastPicture !== undefined && /webp|avif/.test(e.attrs.type ?? "")) pictureModern.set(lastPicture, true);
    if (e.name === "img") {
      const src = e.attrs.src || e.attrs["data-src"] || firstSrcsetUrl(e.attrs.srcset) || "";
      cands.push({ src, srcset: e.attrs.srcset, sizes: e.attrs.sizes, el: e, fromPicture: false, modern: false, bg: false });
      const last = cands[cands.length - 1];
      if (lastPicture !== undefined && pictureModern.get(lastPicture) && e.pos - lastPicture < 2000) last.modern = true;
    }
    if (e.attrs.style) {
      const m = e.attrs.style.match(/background(?:-image)?\s*:[^;]*url\(\s*["']?([^"')]+)["']?\s*\)/i);
      if (m) cands.push({ src: m[1], el: e, fromPicture: false, modern: false, bg: true });
    }
  }
  const imgs = cands.filter((c) => !c.bg && c.src && !/^data:/.test(c.src));
  const resolved = (c: ImgCand) => resolveUrl(c.src, base) ?? c.src;
  const flagged = new Set<string>();
  const sample = (list: ImgCand[]) => list.slice(0, 5).map((c) => c.src.slice(0, 140));
  const flag = (list: ImgCand[]) => list.forEach((c) => flagged.add(c.src));

  const dimsKnown = (c: ImgCand) => (c.el.attrs.width && c.el.attrs.height) || /aspect-ratio|height\s*:/.test(c.el.attrs.style ?? "") || /fill|absolute/.test(c.el.attrs["data-nimg"] ?? "");
  const noDims = imgs.filter((c) => !dimsKnown(c) && !/\.svg($|\?)/i.test(c.src) && c.el.attrs["data-nimg"] !== "fill");
  if (noDims.length) {
    flag(noDims);
    findings.push(mk(page, "images", "missing-dimensions", noDims.length > 3 ? "medium" : "low", "code", `${noDims.length} <img> without width/height (layout shift).`,
      "Set width and height (or aspect-ratio/next/image fill with a sized parent) on every image; map them from CMS asset metadata.", { count: noDims.length, sample: sample(noDims) }));
  }
  const noAlt = imgs.filter((c) => !("alt" in c.el.attrs));
  if (noAlt.length) {
    findings.push(mk(page, "images", "missing-alt", "low", "cms", `${noAlt.length} <img> without alt attribute.`, "Require alt text in the CMS image field; use alt=\"\" for decorative images.", { count: noAlt.length, sample: sample(noAlt) }));
  }
  const noSizes = imgs.filter((c) => c.srcset && /\s\d+w/.test(c.srcset) && !c.sizes);
  if (noSizes.length) {
    flag(noSizes);
    findings.push(mk(page, "images", "srcset-no-sizes", "medium", "code", `${noSizes.length} <img srcset> with w descriptors but no sizes (browser assumes 100vw and downloads oversized files).`,
      "Add an accurate sizes attribute (next/image sizes prop).", { count: noSizes.length, sample: sample(noSizes) }));
  }

  // legacy format / not optimized
  const legacy = imgs.filter((c) => {
    const u = resolved(c);
    const a = assets[u];
    if (/\/_next\/image/.test(u)) return false;
    if (c.modern) return false;
    if (a?.contentType) return /image\/(jpeg|png|gif)/.test(a.contentType) && !OPT_PARAM.test(u);
    return LEGACY_EXT.test(u) && !/[?&](fm|format)=(webp|avif)|auto=format|f_auto|[?&]fm=/i.test(u);
  });
  if (legacy.length) {
    flag(legacy);
    findings.push(mk(page, "images", "legacy-format", legacy.length > 3 ? "medium" : "low", "code", `${legacy.length} image(s) served as jpg/png/gif without modern-format negotiation.`,
      "Route images through next/image (images.formats: avif, webp) or add CDN params (Contentful fm=webp, Sanity auto=format, Cloudinary f_auto, imgix auto=format).", { count: legacy.length, sample: sample(legacy) }));
  }
  const unoptimized = imgs.filter((c) => {
    const u = resolved(c);
    return !/\/_next\/image/.test(u) && !c.modern && !/\.svg($|\?)/i.test(u) && !OPT_PARAM.test(u) && !(IMG_CDN.test(u) && /[?&]/.test(u)) && !legacy.includes(c);
  });
  if (unoptimized.length > 2) {
    flag(unoptimized);
    findings.push(mk(page, "images", "not-optimized-pipeline", "low", "code", `${unoptimized.length} image(s) bypass /_next/image and carry no CDN resize/format params.`,
      "Use next/image (or add w/q/format params on the image CDN) so each viewport gets a right-sized file.", { count: unoptimized.length, sample: sample(unoptimized) }));
  }

  // oversized (HEAD)
  const big = imgs.map((c) => ({ c, a: assets[resolved(c)] })).filter((x) => (x.a?.bytes ?? 0) > 200 * 1024);
  if (big.length) {
    big.forEach((x) => flagged.add(x.c.src));
    findings.push(mk(page, "images", "oversized", big.some((x) => x.a!.bytes! > 500 * 1024) ? "high" : "medium", "cms",
      `${big.length} image(s) over 200KB: ${big.slice(0, 3).map((x) => `${x.c.src.slice(0, 80)} (${kb(x.a!.bytes!)})`).join("; ")}.`,
      "Resize/compress at the source (CMS upload limits, image CDN w/q params) and serve responsive widths; avoid full-resolution originals in cards and heroes.",
      { items: big.slice(0, 8).map((x) => ({ src: x.c.src, bytes: x.a!.bytes })) }));
  }

  // LCP candidate: first sizeable image (DOM order) or hero background
  const sizeable = (c: ImgCand) => {
    if (c.bg) return true;
    if (!c.src || /^data:/.test(c.src) || /\.svg($|\?)/i.test(c.src)) return false;
    if (/facebook\.com\/tr|doubleclick|pixel|beacon/i.test(c.src)) return false;
    if (!c.bg && /logo|icon|avatar|sprite|badge|favicon/i.test(`${c.src} ${c.el.attrs.alt ?? ""} ${c.el.attrs.class ?? ""} ${c.el.attrs.id ?? ""}`)) return false;
    const w = Number(c.el.attrs.width);
    const h = Number(c.el.attrs.height);
    if ((w && w < 200) || (h && h < 100)) return false;
    return true;
  };
  const lcpEl = cands.find(sizeable);
  let lcp: { src: string; preloaded: boolean; lazy: boolean; priority: boolean } | undefined;
  if (lcpEl) {
    const preloads = byName(p, "link").filter((e) => rels(e).includes("preload") && (e.attrs.as ?? "").toLowerCase() === "image");
    const key = underlying(lcpEl.src);
    const preloaded = preloads.some(
      (e) =>
        (e.attrs.href && (e.attrs.href === lcpEl.src || underlying(e.attrs.href) === key)) ||
        (e.attrs.imagesrcset && ((lcpEl.srcset && e.attrs.imagesrcset === lcpEl.srcset) || underlying(firstSrcsetUrl(e.attrs.imagesrcset) ?? "") === key)),
    );
    const lazy = !lcpEl.bg && (lcpEl.el.attrs.loading ?? "").toLowerCase() === "lazy";
    const priority = (lcpEl.el.attrs.fetchpriority ?? "").toLowerCase() === "high";
    lcp = { src: lcpEl.src, preloaded, lazy, priority };
    if (lazy) {
      flagged.add(lcpEl.src);
      findings.push(mk(page, "images", "lcp-lazy", "high", "code", `Likely LCP image is loading="lazy": ${lcpEl.src.slice(0, 120)}.`,
        "Remove loading=lazy on the first hero image and add priority (next/image) / fetchpriority=\"high\"; keep lazy only below the fold.", { src: lcpEl.src }));
    } else if (!priority && !preloaded) {
      flagged.add(lcpEl.src);
      findings.push(mk(page, "images", "lcp-no-priority", "medium", "code",
        `Likely LCP ${lcpEl.bg ? "background image" : "image"} has no fetchpriority=high and is not preloaded: ${lcpEl.src.slice(0, 120)}.`,
        lcpEl.bg
          ? "Hero CSS backgrounds are discovered late: render it as <img> (next/image priority) or add <link rel=preload as=image fetchpriority=high>."
          : "Add priority to the hero next/image (emits fetchpriority=high plus preload).", { src: lcpEl.src }));
    }
  }
  return { findings, lcp, total: imgs.length, flagged: flagged.size, urlsForHead: imgs.map(resolved) };
}

// ---------- 7. resource hints ----------
export function hintChecks(page: PageInput, p: Parsed, lcp?: { src: string }) {
  const base = page.finalUrl ?? page.url;
  const findings: Finding[] = [];
  const links = byName(p, "link");
  const hinted = (kind: string) =>
    links.filter((e) => rels(e).includes(kind) && e.attrs.href).map((e) => resolveUrl(e.attrs.href, base)).filter((x): x is string => !!x).map((u) => new URL(u).origin);
  const preconnects = hinted("preconnect");
  const dns = hinted("dns-prefetch");
  // origins actually used
  const used = new Map<string, number>();
  const bump = (u?: string) => {
    if (!u) return;
    const r = resolveUrl(u, base);
    if (r) used.set(new URL(r).origin, (used.get(new URL(r).origin) ?? 0) + 1);
  };
  for (const e of p.els) {
    if (e.name === "script") bump(e.attrs.src);
    if (e.name === "img" || e.name === "source" || e.name === "iframe" || e.name === "video") {
      bump(e.attrs.src);
      (e.attrs.srcset ?? "").split(",").forEach((s) => bump(s.trim().split(/\s+/)[0]));
    }
    if (e.name === "link" && !rels(e).includes("preconnect") && !rels(e).includes("dns-prefetch")) bump(e.attrs.href);
    for (const m of (e.attrs.style ?? "").matchAll(/url\(\s*["']?([^"')]+)/g)) bump(m[1]);
    if (e.name === "style") for (const m of (e.text ?? "").matchAll(/url\(\s*["']?([^"')]+)/g)) bump(m[1]);
  }
  const hasGoogleFonts = [...used.keys()].some((o) => o.includes("fonts.googleapis.com"));
  const unused = [...new Set(preconnects)].filter((o) => {
    if (used.has(o)) return false;
    if (hasGoogleFonts && o.includes("fonts.gstatic.com")) return false;
    // GTM/analytics preconnects are used by dynamically-injected code
    if (/googletagmanager|google-analytics|doubleclick/.test(o) && [...used.keys()].some((u) => /googletagmanager/.test(u))) return false;
    return true;
  });
  if (unused.length) {
    findings.push(mk(page, "hints", "unused-preconnect", "low", "code", `preconnect to origin(s) the HTML never references: ${unused.join(", ")} (they may be used by late-injected code).`,
      "Remove preconnects that nothing loads early; each costs a DNS+TLS handshake competing with critical requests.", { origins: unused }));
  }
  // missing preconnect for main third-party/CMS image origin
  const pageOrigin = new URL(base).origin;
  const tpImg = new Map<string, number>();
  for (const e of p.els.filter((x) => x.name === "img")) {
    const r = resolveUrl(e.attrs.src ?? firstSrcsetUrl(e.attrs.srcset) ?? "", base);
    if (r && new URL(r).origin !== pageOrigin) tpImg.set(new URL(r).origin, (tpImg.get(new URL(r).origin) ?? 0) + 1);
  }
  const top = [...tpImg.entries()].sort((a, b) => b[1] - a[1])[0];
  const lcpOrigin = lcp?.src ? (() => { const r = resolveUrl(lcp.src, base); return r ? new URL(r).origin : undefined; })() : undefined;
  const target = lcpOrigin && lcpOrigin !== pageOrigin ? lcpOrigin : top && top[1] >= 2 ? top[0] : undefined;
  if (target && !preconnects.includes(target) && !dns.includes(target)) {
    findings.push(mk(page, "hints", "missing-preconnect", target === lcpOrigin ? "medium" : "low", "code",
      `Main image origin ${target} has no preconnect/dns-prefetch.`, `Add <link rel="preconnect" href="${target}" crossorigin> (Next: in layout head or via the preload of the LCP image).`, { origin: target }));
  }
  const preloads = links.filter((e) => rels(e).includes("preload"));
  if (preloads.length > 6) {
    findings.push(mk(page, "hints", "too-many-preloads", "medium", "code", `${preloads.length} <link rel=preload> tags compete for bandwidth with the LCP resource.`,
      "Keep preloads to the LCP image and 1-2 critical fonts; remove the rest.", { hrefs: preloads.slice(0, 10).map((e) => e.attrs.href) }));
  }
  if (new Set(preconnects).size > 4) {
    findings.push(mk(page, "hints", "too-many-preconnects", "low", "code", `${new Set(preconnects).size} preconnect origins (browsers only benefit from ~4).`, "Keep preconnect for critical origins; use dns-prefetch for the rest."));
  }
  return { findings, preloadCount: preloads.length };
}

// ---------- asset planning ----------
export interface AssetPlan {
  url: string;
  kind: "script" | "css" | "image" | "font";
}

export function planAssets(page: PageInput, p: Parsed, imageUrls: string[], opts: { maxScripts?: number; maxImages?: number } = {}): AssetPlan[] {
  const base = page.finalUrl ?? page.url;
  const plan: AssetPlan[] = [];
  const seen = new Set<string>();
  const add = (url: string | undefined, kind: AssetPlan["kind"]) => {
    if (!url || seen.has(url) || !/^https?:/.test(url)) return;
    seen.add(url);
    plan.push({ url, kind });
  };
  let n = 0;
  for (const e of byName(p, "script")) {
    if (e.attrs.src && n < (opts.maxScripts ?? 40)) {
      const u = resolveUrl(e.attrs.src, base);
      if (u && !seen.has(u)) n++;
      add(u, "script");
    }
  }
  for (const e of byName(p, "link")) {
    if (rels(e).includes("stylesheet")) add(resolveUrl(e.attrs.href ?? "", base), "css");
  }
  imageUrls.slice(0, opts.maxImages ?? 12).forEach((u) => add(u, "image"));
  return plan;
}

import type { AuditContext, Finding } from "./types.js";
import { find, importsOf, isCode, isLayoutLike, isTestFile, JSX_RE, lineAt, matches } from "./util.js";

const THIRD_PARTY =
  /googletagmanager|google-analytics|gtag|analytics\.js|segment\.(?:com|io)|cdn\.segment|hotjar|fullstory|optimizely|onetrust|cookiebot|cookielaw|intercom|drift\.com|driftt|livechat|calendly|connect\.facebook|facebook\.net|fbevents|tiktok|clarity\.ms|dataLayer/i;
const CONSENT = /onetrust|cookiebot|cookielaw|consent/i;

function fixFor(snippet: string): string {
  const base =
    'Set `strategy="lazyOnload"` (or "afterInteractive" for analytics that must fire early) on <Script>. For GTM/GA use `@next/third-parties` (<GoogleTagManager/>, <GoogleAnalytics/>); for heavy tags consider Partytown.';
  return CONSENT.test(snippet)
    ? base + " This looks like a consent/CMP script: do NOT remove it or defer it without confirming with the owner (legal/compliance)."
    : base;
}

export function thirdPartyScript(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  for (const f of ctx.files) {
    if (!isCode(f) || !JSX_RE.test(f.path)) continue;
    const c = f.content;
    const usesNextScript = importsOf(c).some((i) => i.spec === "next/script");
    if (usesNextScript) {
      for (const { m, line } of matches(c, /<Script\b((?:[^>]|=>)*)>/)) {
        const tail = c.slice(m.index, m.index + m[0].length + 600);
        if (!THIRD_PARTY.test(tail)) continue;
        const strat = m[1].match(/strategy\s*=\s*\{?\s*["'](\w+)["']/)?.[1];
        if (strat === "lazyOnload" || strat === "worker") continue;
        if (strat === "beforeInteractive") {
          out.push(
            find("third-party-script", {
              id: "third-party-script/before-interactive",
              severity: "high",
              file: f.path,
              line,
              message: 'Third-party <Script strategy="beforeInteractive"> blocks hydration and delays LCP/INP.',
              fix: fixFor(tail),
            }),
          );
        } else if (!strat) {
          out.push(
            find("third-party-script", {
              id: "third-party-script/no-strategy",
              severity: "medium",
              file: f.path,
              line,
              message: "Third-party <Script> has no explicit strategy (defaults to afterInteractive, competes with hydration).",
              fix: fixFor(tail),
            }),
          );
        }
      }
    }
    if (isLayoutLike(f.path)) {
      for (const { m, line } of matches(c, /<script\b((?:[^>]|=>)*)>/)) {
        const attrs = m[1];
        const tail = c.slice(m.index, m.index + m[0].length + 600);
        if (/\bsrc\s*=/.test(attrs) || THIRD_PARTY.test(tail)) {
          if (/type\s*=\s*["']application\/(?:ld\+)?json/.test(attrs)) continue;
          out.push(
            find("third-party-script", {
              id: "third-party-script/raw-script",
              severity: "high",
              file: f.path,
              line,
              message: "Raw <script> in layout/head runs on every page and blocks parsing unless async/defer.",
              fix: fixFor(tail).replace("on <Script>", "on next/script <Script> (replace this raw <script>)"),
            }),
          );
        }
      }
    }
  }
  return out;
}

const PREVIEW_SPEC =
  /^(?:@builder\.io\/[\w-]*(?:preview|visual|editing)[\w-/]*|@storyblok\/[\w-]*(?:bridge|preview)[\w-/]*|storyblok-?bridge|@sitecore[\w-]*\/[\w-/]*editing[\w-/]*|@contentful\/live-preview[\w-/]*|@sanity\/(?:visual-editing|preview-kit)[\w-/]*|next-sanity\/(?:visual-editing|preview)[\w-/]*|@prismicio\/[\w-]*preview[\w-/]*|@vercel\/toolbar[\w-/]*|@stackbit\/[\w-/]*)$/;

const SHARED_DIR = /(?:^|\/)(?:components?\/(?:layout|shared|common|global|ui)|layout|shared|common|header|footer|nav(?:igation)?)\//i;

export function previewCodeInProd(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  for (const f of ctx.files) {
    if (!isCode(f)) continue;
    if (!isLayoutLike(f.path) && !SHARED_DIR.test(f.path)) continue;
    if (/\bdraftMode\b|\bisDraftMode\b|\bisEnabled\b|process\.env\.\w*(?:PREVIEW|DRAFT|EDIT)\w*|isPreview|inEditor/i.test(f.content)) continue;
    const re = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g;
    for (const { m, line } of matches(f.content, re)) {
      if (!PREVIEW_SPEC.test(m[1])) continue;
      out.push(
        find("preview-code-in-prod", {
          severity: isLayoutLike(f.path) ? "high" : "medium",
          file: f.path,
          line,
          message: `Editing/preview SDK \`${m[1]}\` is imported in a shared/layout file with no draft-mode guard; it ships to all visitors.`,
          fix: 'Render it only when `(await draftMode()).isEnabled` (server) and load it with `dynamic(() => import("..."))` inside that branch, so production visitors never download it.',
        }),
      );
    }
  }
  return out;
}

const WIDGETS: { re: RegExp; name: string }[] = [
  { name: "Google Maps", re: /^(?:@react-google-maps\/api|@googlemaps\/[\w-]+|google-map-react|use-places-autocomplete|@vis\.gl\/react-google-maps)$/ },
  { name: "Mapbox", re: /^(?:mapbox-gl|react-map-gl(?:\/.*)?|@mapbox\/[\w-]+)$/ },
  { name: "Leaflet", re: /^(?:leaflet|react-leaflet)$/ },
  { name: "Calendly", re: /^(?:react-calendly|@calendly\/[\w-]+)$/ },
  { name: "video player", re: /^(?:react-player(?:\/.*)?|video\.js|videojs|plyr(?:-react)?|@vimeo\/player|react-youtube|@mux\/mux-player(?:-react)?|@wistia\/[\w-]+|react-lite-youtube-embed)$/ },
];
const DEDICATED = /map|locator|location|find-?a|store-?finder|calendar|booking|schedul|appointment|video|player|widget/i;
const SCRIPT_URL =
  /maps\.googleapis\.com\/maps\/api\/js|api\.mapbox\.com\/mapbox-gl|assets\.calendly\.com|player\.vimeo\.com\/api|youtube\.com\/iframe_api|fast\.wistia/;

export function mapsWidgets(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  const byWidget = new Map<string, { path: string; line: number; spec: string }[]>();
  for (const f of ctx.files) {
    if (!isCode(f)) continue;
    for (const i of importsOf(f.content)) {
      const w = WIDGETS.find((x) => x.re.test(i.spec));
      if (!w) continue;
      const arr = byWidget.get(w.name) ?? [];
      arr.push({ path: f.path, line: i.line, spec: i.spec });
      byWidget.set(w.name, arr);
    }
    if (isLayoutLike(f.path)) {
      for (const { line } of matches(f.content, new RegExp(SCRIPT_URL.source, "g"))) {
        out.push(
          find("maps-widgets", {
            id: "maps-widgets/layout-script",
            severity: "high",
            file: f.path,
            line,
            message: "Map/scheduler/video loader script referenced in layout/head: loads on every page.",
            fix: "Load the widget only on the route that needs it, and defer it until visible/clicked (IntersectionObserver or click-to-load facade).",
          }),
        );
      }
    }
    if (/\.[jt]sx$/.test(f.path)) {
      for (const { m, line } of matches(f.content, /<iframe\b((?:[^>]|=>)*)>/)) {
        if (/youtube\.com|youtube-nocookie|vimeo\.com|google\.com\/maps|calendly\.com/.test(m[1]) && !/loading\s*=\s*["']lazy/.test(m[1])) {
          out.push(
            find("maps-widgets", {
              id: "maps-widgets/iframe",
              severity: "low",
              file: f.path,
              line,
              message: "Embedded video/map/scheduler <iframe> without loading=\"lazy\".",
              fix: 'Add loading="lazy", or use a click-to-load facade (thumbnail + load iframe on click).',
            }),
          );
        }
      }
    }
  }
  for (const [name, uses] of byWidget) {
    const many = new Set(uses.map((u) => u.path)).size > 3;
    for (const u of uses) {
      const layoutish = isLayoutLike(u.path) || SHARED_DIR.test(u.path);
      if (!layoutish && !(many && !DEDICATED.test(u.path))) continue;
      out.push(
        find("maps-widgets", {
          severity: layoutish && isLayoutLike(u.path) ? "high" : "medium",
          file: u.path,
          line: u.line,
          message: layoutish
            ? `${name} (\`${u.spec}\`) imported from a layout/shared component; it loads on pages that never show it.`
            : `${name} (\`${u.spec}\`) is imported by ${new Set(uses.map((x) => x.path)).size} files, not just a dedicated route/component.`,
          fix: `Move the ${name} import into one dedicated component and load it with next/dynamic when it scrolls into view or on click (IntersectionObserver / click-to-load).`,
        }),
      );
    }
  }
  return out;
}

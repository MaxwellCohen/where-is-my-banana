import { mk } from "./checks-page.js";
import { GTM_SIGNATURES } from "./vendors.js";
import type { Finding, GtmSummary } from "./types.js";

export function findGtmIds(html: string): string[] {
  const ids = new Set<string>();
  for (const m of html.matchAll(/googletagmanager\.com\/(?:gtm\.js|ns\.html)\?(?:[^"'\s>]*?&(?:amp;)?)?id=(GTM-[A-Z0-9]+)/gi)) ids.add(m[1]);
  for (const m of html.matchAll(/['"](GTM-[A-Z0-9]{4,})['"]/g)) ids.add(m[1]);
  return [...ids];
}

export function gtmUrl(id: string): string {
  return `https://www.googletagmanager.com/gtm.js?id=${id}`;
}

export function parseGtm(id: string, src: string): GtmSummary {
  const bytes = Buffer.byteLength(src);
  const vendors = GTM_SIGNATURES.filter((v) => v.test.test(src)).map((v) => v.name);
  const tagTypes: Record<string, number> = {};
  for (const m of src.matchAll(/"function"\s*:\s*"(__[a-zA-Z0-9_]+)"/g)) tagTypes[m[1]] = (tagTypes[m[1]] ?? 0) + 1;
  return { id, bytes, vendors, tagTypes };
}

export function gtmChecks(page: { url: string }, g: GtmSummary): Finding[] {
  const out: Finding[] = [];
  const kb = (g.bytes / 1024).toFixed(1);
  const top = Object.entries(g.tagTypes).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}x${v}`).join(", ");
  if (g.bytes > 100 * 1024) {
    out.push(mk(page, "gtm", "container-size", g.bytes > 200 * 1024 ? "high" : "medium", "gtm",
      `GTM container ${g.id} is ${kb}KB (uncompressed). Macro/tag types: ${top || "n/a"}.`,
      "In GTM: delete paused/unused tags, triggers and variables, replace custom HTML tags with templates, and split rarely-used tags into a second container loaded on interaction. Publish a smaller version.",
      { id: g.id, bytes: g.bytes, tagTypes: g.tagTypes, vendors: g.vendors }));
  }
  if (g.vendors.length > 10) {
    out.push(mk(page, "gtm", "many-vendors", "medium", "gtm",
      `GTM container ${g.id} loads ${g.vendors.length} vendors: ${g.vendors.join(", ")}.`,
      "Audit each vendor with its owner; remove unused pixels, fire the rest after consent/idle (Window Loaded trigger, not All Pages/Page View), and use server-side GTM for ad pixels.",
      { id: g.id, vendors: g.vendors }));
  }
  return out;
}

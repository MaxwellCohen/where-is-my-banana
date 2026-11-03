import { analyzePage } from "../../src/live/analyze.js";
import type { AssetMap, PageInput } from "../../src/live/types.js";

export function run(html: string, over: Partial<PageInput> = {}, ctx: { assets?: AssetMap; gtm?: Record<string, string> } = {}) {
  return analyzePage(
    { url: "https://www.example.com/", html, headers: { "content-encoding": "br", "cache-control": "public, s-maxage=60, stale-while-revalidate=600", "content-type": "text/html" }, ttfbMs: 100, status: 200, ...over },
    ctx,
  );
}
export const ids = (r: { findings: { id: string }[] }) => r.findings.map((f) => f.id);
export const GOOD = `<!doctype html><html lang="en"><head><title>T</title><meta name="viewport" content="width=device-width"><meta name="description" content="d"><link rel="canonical" href="https://www.example.com/"></head><body><h1>Hi</h1></body></html>`;

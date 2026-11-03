import { execFile } from "node:child_process";
import { mk } from "./checks-page.js";
import type { Finding, Owner, Severity } from "./types.js";

export interface LighthouseSummary {
  url: string;
  score?: number;
  metrics: { lcp?: number; tbt?: number; inp?: number; cls?: number; fcp?: number; ttfb?: number };
  findings: Finding[];
}

const OWNER: Record<string, Owner> = {
  "third-party-summary": "gtm",
  "uses-text-compression": "cdn",
  "server-response-time": "cdn",
  "uses-long-cache-ttl": "cdn",
  redirects: "cdn",
  "image-size-responsive": "cms",
  "uses-optimized-images": "cms",
};

const DIAG = new Set([
  "unused-javascript", "render-blocking-resources", "third-party-summary", "unsized-images", "uses-optimized-images", "uses-responsive-images",
  "unused-css-rules", "offscreen-images", "modern-image-formats", "legacy-javascript", "uses-text-compression", "server-response-time", "redirects",
  "dom-size", "bootup-time", "font-display", "lcp-lazy-loaded", "prioritize-lcp-image", "long-tasks", "uses-long-cache-ttl", "total-byte-weight",
  "mainthread-work-breakdown", "network-dependency-tree-insight", "lcp-discovery-insight",
]);

export function parseLighthouse(report: any, urlOverride?: string): LighthouseSummary {
  const url: string = urlOverride ?? report.finalDisplayedUrl ?? report.finalUrl ?? report.requestedUrl ?? "unknown";
  const a = report.audits ?? {};
  const num = (id: string): number | undefined => (typeof a[id]?.numericValue === "number" ? a[id].numericValue : undefined);
  const score = typeof report.categories?.performance?.score === "number" ? Math.round(report.categories.performance.score * 100) : undefined;
  const metrics = {
    lcp: num("largest-contentful-paint"),
    tbt: num("total-blocking-time"),
    inp: num("interaction-to-next-paint"),
    cls: num("cumulative-layout-shift"),
    fcp: num("first-contentful-paint"),
    ttfb: num("server-response-time"),
  };
  const findings: Finding[] = [];
  for (const [id, au] of Object.entries<any>(a)) {
    if (!au || au.scoreDisplayMode === "notApplicable" || au.scoreDisplayMode === "informative" && !DIAG.has(id)) continue;
    const ms = au.details?.overallSavingsMs ?? au.metricSavings?.LCP ?? undefined;
    const bytes = au.details?.overallSavingsBytes;
    const low = typeof au.score === "number" && au.score < 0.9;
    const isDiag = DIAG.has(id) && (low || au.score === null);
    const significant = (ms ?? 0) >= 100 || (bytes ?? 0) >= 20 * 1024;
    if (!((low && significant) || (isDiag && (significant || (typeof au.score === "number" && au.score < 0.5))))) continue;
    const sev: Severity = (ms ?? 0) >= 500 || (bytes ?? 0) >= 150 * 1024 || au.score === 0 ? "high" : (ms ?? 0) >= 100 || (bytes ?? 0) >= 50 * 1024 ? "medium" : "low";
    const saves = [ms ? `${Math.round(ms)}ms` : "", bytes ? `${(bytes / 1024).toFixed(0)}KB` : ""].filter(Boolean).join(" / ");
    findings.push(
      mk({ url }, "lighthouse", id, sev, OWNER[id] ?? "code",
        `${au.title}${saves ? ` (potential savings ${saves})` : ""}${au.displayValue ? `: ${au.displayValue}` : ""}.`,
        String(au.description ?? "See Lighthouse docs").replace(/\s*\[Learn more\]\([^)]*\)\.?/g, "").trim() || "See Lighthouse report.",
        { savingsMs: ms, savingsBytes: bytes, bytes, score: au.score }),
    );
  }
  return { url, score, metrics, findings };
}

export function runLighthouse(url: string, timeoutMs = 180_000): Promise<LighthouseSummary | { error: string }> {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["--no-install", "lighthouse", url, "--output=json", "--only-categories=performance", "--form-factor=mobile", "--quiet", "--chrome-flags=--headless"],
      { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout) => {
        if (err || !stdout) {
          resolve({ error: "Lighthouse not available. Install it (npm i -D lighthouse) and Chrome, or run `npx lighthouse <url> --output=json --output-path=lh.json` and pass `--lighthouse-json lh.json`." });
          return;
        }
        try {
          resolve(parseLighthouse(JSON.parse(stdout), url));
        } catch {
          resolve({ error: "Could not parse Lighthouse JSON output." });
        }
      },
    );
  });
}

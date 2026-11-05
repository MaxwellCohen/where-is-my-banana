import { pathType } from "./sitemap.js";
import type { Finding, Owner, PageResult, Severity } from "./types.js";
import type { LighthouseSummary } from "./lighthouse.js";
import { mk } from "./checks-page.js";

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${(n / 1024).toFixed(0)}KB`);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const weight = (p: PageResult) => p.metrics.htmlGzip + p.metrics.jsTransfer;
const scriptKey = (u: string) => u.split("?")[0];

export interface CrossPage {
  sharedScripts: { url: string; bytes: number }[];
  sharedVendors: string[];
  sharedBytes: number;
  types: { type: string; pages: number; medianWeight: number }[];
  heavy: { url: string; type: string; weight: number; medianWeight: number; extraScripts: string[]; extraVendors: string[]; domNodes: number; images: number }[];
}

export function crossPage(pages: PageResult[]): { cross: CrossPage; findings: Finding[] } {
  const cross: CrossPage = { sharedScripts: [], sharedVendors: [], sharedBytes: 0, types: [], heavy: [] };
  if (pages.length < 2) return { cross, findings: [] };
  const sets = pages.map((p) => new Map(p.scripts.map((s) => [scriptKey(s.url), s.transferEst ?? 0])));
  const sharedKeys = [...sets[0].keys()].filter((k) => sets.every((m) => m.has(k)));
  cross.sharedScripts = sharedKeys.map((url) => ({ url, bytes: sets[0].get(url) ?? 0 })).sort((a, b) => b.bytes - a.bytes);
  cross.sharedBytes = cross.sharedScripts.reduce((a, s) => a + s.bytes, 0);
  cross.sharedVendors = pages[0].vendors.map((v) => v.vendor).filter((v) => pages.every((p) => p.vendors.some((x) => x.vendor === v)));

  const byType = new Map<string, PageResult[]>();
  for (const p of pages) (byType.get(pathType(p.finalUrl)) ?? byType.set(pathType(p.finalUrl), []).get(pathType(p.finalUrl))!).push(p);
  cross.types = [...byType.entries()].map(([type, ps]) => ({ type, pages: ps.length, medianWeight: median(ps.map(weight)) }));
  const med = median(pages.map(weight));
  const findings: Finding[] = [];
  const sharedSet = new Set(sharedKeys);
  const vendorShared = new Set(cross.sharedVendors);
  for (const p of pages) {
    const w = weight(p);
    if (med > 0 && w > med * 1.25 && w - med > 50 * 1024) {
      const extra = p.scripts.filter((s) => !sharedSet.has(scriptKey(s.url))).sort((a, b) => (b.transferEst ?? 0) - (a.transferEst ?? 0));
      const row = {
        url: p.url,
        type: pathType(p.finalUrl),
        weight: w,
        medianWeight: med,
        extraScripts: extra.slice(0, 5).map((s) => `${scriptKey(s.url)} (${kb(s.transferEst ?? 0)})`),
        extraVendors: p.vendors.map((v) => v.vendor).filter((v) => !vendorShared.has(v)),
        domNodes: p.metrics.domNodes,
        images: p.metrics.imagesTotal,
      };
      cross.heavy.push(row);
      findings.push(
        mk(p, "cross-page", "heavy-page-type", w > med * 1.5 ? "medium" : "low", "code",
          `${row.type} page is ${kb(w)} (HTML gz + JS) vs median ${kb(med)}; page-specific scripts: ${row.extraScripts.join(", ") || "none"}${row.extraVendors.length ? `; extra vendors: ${row.extraVendors.join(", ")}` : ""}.`,
          "Lazy-load the page-type-specific widgets/scripts listed (maps, review widgets, schedulers) behind interaction or intersection; keep the shared shell lean.",
          { weight: w, median: med, bytes: w - med }),
      );
    }
  }
  return { cross, findings };
}

export interface Group {
  id: string;
  check: string;
  severity: Severity;
  owner: Owner;
  message: string;
  fix: string;
  urls: string[];
  score: number;
  bytes: number;
}

const SEV: Record<Severity, number> = { high: 300, medium: 200, low: 100 };

export function groupFindings(findings: Finding[]): Group[] {
  const m = new Map<string, Group>();
  for (const f of findings) {
    const b = Number((f.evidence as any)?.bytes ?? (f.evidence as any)?.savingsBytes ?? (f.evidence as any)?.gzip ?? 0) || 0;
    const g = m.get(f.id);
    if (!g) m.set(f.id, { id: f.id, check: f.check, severity: f.severity, owner: f.owner, message: f.message, fix: f.fix, urls: [f.url], score: 0, bytes: b });
    else {
      if (!g.urls.includes(f.url)) g.urls.push(f.url);
      if (SEV[f.severity] > SEV[g.severity]) g.severity = f.severity;
      g.bytes = Math.max(g.bytes, b);
    }
  }
  for (const g of m.values()) g.score = SEV[g.severity] + Math.min(g.urls.length, 10) * 8 + Math.log2(g.bytes / 1024 + 1) * 5;
  return [...m.values()].sort((a, b) => b.score - a.score);
}

export interface LiveReport {
  generatedAt: string;
  options: Record<string, unknown>;
  requests: number;
  budgetExhausted: boolean;
  pages: PageResult[];
  errors: { url: string; error: string }[];
  cross: CrossPage;
  lighthouse: LighthouseSummary[];
  findings: Finding[];
  groups: Group[];
  notes: string[];
}

export function buildReport(args: {
  options: Record<string, unknown>;
  requests: number;
  budgetExhausted: boolean;
  pages: PageResult[];
  errors: { url: string; error: string }[];
  lighthouse: LighthouseSummary[];
  notes?: string[];
}): LiveReport {
  const { cross, findings: crossFindings } = crossPage(args.pages);
  const findings = [...args.pages.flatMap((p) => p.findings), ...crossFindings, ...args.lighthouse.flatMap((l) => l.findings)];
  return {
    generatedAt: new Date().toISOString(),
    options: args.options,
    requests: args.requests,
    budgetExhausted: args.budgetExhausted,
    pages: args.pages,
    errors: args.errors,
    cross,
    lighthouse: args.lighthouse,
    findings,
    groups: groupFindings(findings),
    notes: args.notes ?? [],
  };
}

const path = (u: string) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search || "/";
  } catch {
    return u;
  }
};

export function formatMarkdown(r: LiveReport): string {
  const L: string[] = [];
  L.push(`# wimb live report`, ``, `Generated ${r.generatedAt}. ${r.pages.length} page(s), ${r.requests} requests${r.budgetExhausted ? " (request budget exhausted, some asset sizes missing)" : ""}.`, ``);
  const det = new Map<string, Set<string>>();
  for (const p of r.pages) for (const [k, v] of Object.entries(p.detection)) if (Array.isArray(v)) v.forEach((x) => (det.get(k) ?? det.set(k, new Set()).get(k)!).add(x));
  const bid = r.pages.map((p) => p.detection.buildId).find(Boolean);
  L.push(`**Detected**: framework ${[...(det.get("framework") ?? [])].join(", ") || "unknown"}; hosting ${[...(det.get("hosting") ?? [])].join(", ") || "unknown"}; CMS hints ${[...(det.get("cms") ?? [])].join(", ") || "none"}${bid ? `; build id ${bid}` : ""}.`, ``);
  if (r.pages.length) {
    L.push(`## Pages`, ``, `| Page | TTFB | Cache | HTML gz | JS files / est. bytes | 3rd-party bytes | Images flagged | DOM nodes |`, `|---|---|---|---|---|---|---|---|`);
    for (const p of r.pages) {
      const m = p.metrics;
      L.push(`| ${path(p.finalUrl)} | ${m.ttfbMs}ms | ${m.cacheStatus} | ${kb(m.htmlGzip)} | ${m.jsCount} / ${kb(m.jsTransfer)} | ${m.thirdPartyCount} / ${kb(m.thirdPartyTransfer)} | ${m.imagesFlagged}/${m.imagesTotal} | ${m.domNodes} |`);
    }
    L.push(``);
  }
  for (const e of r.errors) L.push(`> Failed: ${e.url}: ${e.error}`);
  if (r.errors.length) L.push(``);

  L.push(`## Do these first`, ``, `Ranked by severity, pages affected and bytes. \`owner\` says who can fix it: \`code\` (repo), \`gtm\` (Tag Manager UI), \`cdn\` (CDN/hosting config), \`cms\` (content/CMS config). A code agent can only act on \`code\`; hand the rest to a human.`, ``);
  r.groups.slice(0, 10).forEach((g, i) => L.push(`${i + 1}. **[${g.severity}] [owner: ${g.owner}] ${g.id}** (${g.urls.length} page${g.urls.length > 1 ? "s" : ""}): ${g.message}`, `   - Fix: ${g.fix}`));
  L.push(``);

  if (r.cross.sharedScripts.length || r.cross.heavy.length) {
    L.push(`## Cross-page`, ``, `- Shared by all pages: ${r.cross.sharedScripts.length} scripts (~${kb(r.cross.sharedBytes)}); shared vendors: ${r.cross.sharedVendors.join(", ") || "none"}.`);
    for (const t of r.cross.types) L.push(`- Type \`${t.type}\`: ${t.pages} page(s), median weight ${kb(t.medianWeight)}`);
    for (const h of r.cross.heavy) L.push(`- Heavier than median: ${path(h.url)} (${kb(h.weight)} vs ${kb(h.medianWeight)}); specific: ${h.extraScripts.join(", ") || "n/a"}${h.extraVendors.length ? `; vendors: ${h.extraVendors.join(", ")}` : ""}`);
    L.push(``);
  }

  const lcps = r.pages.filter((p) => p.lcp);
  if (lcps.length) {
    L.push(`## LCP candidates`, ``);
    for (const p of lcps) L.push(`- ${path(p.finalUrl)}: ${p.lcp!.src.slice(0, 100)} (preloaded: ${p.lcp!.preloaded}, lazy: ${p.lcp!.lazy}, fetchpriority high: ${p.lcp!.priority})`);
    L.push(``);
  }
  const gt = r.pages.flatMap((p) => p.gtm);
  if (gt.length) {
    L.push(`## GTM containers`, ``);
    for (const g of new Map(gt.map((x) => [x.id, x])).values()) L.push(`- ${g.id}: ${kb(g.bytes)}, vendors (${g.vendors.length}): ${g.vendors.join(", ") || "none detected"}`);
    L.push(``);
  }
  if (r.lighthouse.length) {
    L.push(`## Lighthouse`, ``);
    for (const l of r.lighthouse) {
      const m = l.metrics;
      L.push(`- ${l.url}: score ${l.score ?? "n/a"}, LCP ${Math.round(m.lcp ?? 0)}ms, TBT ${Math.round(m.tbt ?? 0)}ms, CLS ${(m.cls ?? 0).toFixed(3)}, FCP ${Math.round(m.fcp ?? 0)}ms, TTFB ${Math.round(m.ttfb ?? 0)}ms`);
    }
    L.push(``);
  }

  L.push(`## Findings by check`, ``);
  const byCheck = new Map<string, Group[]>();
  for (const g of r.groups) (byCheck.get(g.check) ?? byCheck.set(g.check, []).get(g.check)!).push(g);
  for (const [check, gs] of byCheck) {
    L.push(`### ${check}`, ``);
    for (const g of gs) {
      L.push(`- **[${g.severity}] [owner: ${g.owner}] ${g.id}**: ${g.message}`, `  - Pages: ${g.urls.slice(0, 5).map(path).join(", ")}${g.urls.length > 5 ? ` (+${g.urls.length - 5})` : ""}`, `  - Fix: ${g.fix}`);
    }
    L.push(``);
  }
  if (r.notes.length) L.push(`## Notes`, ``, ...r.notes.map((n) => `- ${n}`), ``);
  return L.join("\n");
}

export function formatTerminal(r: LiveReport, outDir: string): string {
  const L: string[] = [];
  for (const p of r.pages) {
    const m = p.metrics;
    L.push(`${path(p.finalUrl).slice(0, 40).padEnd(40)} TTFB ${String(m.ttfbMs).padStart(5)}ms  HTML ${kb(m.htmlGzip).padStart(6)}  JS ${String(m.jsCount).padStart(3)}/${kb(m.jsTransfer).padStart(6)}  3p ${kb(m.thirdPartyTransfer).padStart(6)}  img ${m.imagesFlagged}/${m.imagesTotal}`);
  }
  for (const e of r.errors) L.push(`FAILED ${e.url}: ${e.error}`);
  const c = (s: Severity) => r.findings.filter((f) => f.severity === s).length;
  L.push(`${c("high")} high, ${c("medium")} medium, ${c("low")} low findings. Top:`);
  r.groups.slice(0, 5).forEach((g, i) => L.push(` ${i + 1}. [${g.severity}/${g.owner}] ${g.id} (${g.urls.length}p): ${g.message.slice(0, 110)}`));
  L.push(`Wrote ${outDir}/live.json and live.md (${r.requests} requests).`);
  return L.join("\n");
}

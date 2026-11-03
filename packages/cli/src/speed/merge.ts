import type {
  Effort, PageTypeRow, PlanCompare, PlanInputs, PlanItem, PlanOwner, PlanRisk, PlanSeverity, PlanSource,
  RawFinding, RawWin, Theme,
} from "./types.js";

const SEV: Record<PlanSeverity, number> = { high: 3, medium: 2, low: 1 };
const EFFORT_WEIGHT: Record<Effort, number> = { S: 1, M: 1.8, L: 3 };
const BASE_SCORE: Record<PlanSeverity, number> = { high: 60, medium: 32, low: 10 };
const OWNERS: PlanOwner[] = ["code", "gtm", "cdn", "cms", "human-decision"];
const MAX_LOCATIONS = 12;

interface CheckMeta {
  theme: Theme;
  impact: string;
  effort: Effort;
  risk: PlanRisk;
  owner: PlanOwner;
  /** Rough KB saved per finding; heuristic only. */
  kbEach?: number;
  title: (n: number) => string;
}
const s = (n: number) => (n === 1 ? "" : "s");

const CHECK_META: Record<string, CheckMeta> = {
  "third-party-script": { theme: "Third parties", impact: "INP, LCP, bytes", effort: "S", risk: "safe", owner: "code", kbEach: 20, title: (n) => `Defer ${n} third-party script${s(n)}` },
  "maps-widgets": { theme: "Third parties", impact: "LCP, INP, bytes", effort: "M", risk: "needs-review", owner: "human-decision", kbEach: 100, title: (n) => `Lazy-load ${n} map/widget embed${s(n)}` },
  "raw-img": { theme: "Images", impact: "LCP, CLS, bytes", effort: "S", risk: "safe", owner: "code", kbEach: 40, title: (n) => `Replace ${n} raw <img> with next/image` },
  "lcp-priority": { theme: "Images", impact: "LCP", effort: "S", risk: "safe", owner: "code", title: (n) => `Prioritize the LCP image (${n} location${s(n)})` },
  "image-config": { theme: "Images", impact: "LCP, bytes", effort: "S", risk: "safe", owner: "code", kbEach: 30, title: (n) => `Fix next/image configuration (${n} issue${s(n)})` },
  "cms-image-params": { theme: "Images", impact: "LCP, bytes", effort: "S", risk: "safe", owner: "code", kbEach: 50, title: (n) => `Add size/format params to ${n} CMS image URL${s(n)}` },
  fonts: { theme: "Fonts", impact: "LCP, CLS", effort: "S", risk: "safe", owner: "code", kbEach: 30, title: (n) => `Fix font loading (${n} issue${s(n)})` },
  "force-dynamic": { theme: "Rendering/caching", impact: "TTFB, LCP", effort: "M", risk: "needs-review", owner: "human-decision", title: (n) => `Restore static/ISR rendering on ${n} route${s(n)}` },
  "missing-static-params": { theme: "Rendering/caching", impact: "TTFB, LCP", effort: "M", risk: "needs-review", owner: "code", title: (n) => `Add generateStaticParams to ${n} dynamic route${s(n)}` },
  "sequential-await": { theme: "Rendering/caching", impact: "TTFB, LCP", effort: "S", risk: "needs-review", owner: "code", title: (n) => `Parallelize ${n} sequential await chain${s(n)}` },
  "middleware-scope": { theme: "Rendering/caching", impact: "TTFB", effort: "S", risk: "needs-review", owner: "human-decision", title: (n) => `Narrow middleware matcher (${n} issue${s(n)})` },
  "full-cms-payload-to-client": { theme: "Payload", impact: "INP, bytes", effort: "M", risk: "needs-review", owner: "code", kbEach: 50, title: (n) => `Trim CMS payload sent to ${n} client component${s(n)}` },
  "heavy-deps": { theme: "Dependencies", impact: "INP, bytes", effort: "M", risk: "needs-review", owner: "human-decision", kbEach: 30, title: (n) => `Replace/trim ${n} heavy dependenc${n === 1 ? "y" : "ies"}` },
  "old-browserslist": { theme: "Dependencies", impact: "bytes, INP", effort: "S", risk: "needs-review", owner: "human-decision", kbEach: 20, title: (n) => `Modernize browserslist/polyfills (${n} issue${s(n)})` },
  "preview-code-in-prod": { theme: "CMS blocks/registry", impact: "bytes, INP", effort: "S", risk: "needs-review", owner: "code", kbEach: 30, title: (n) => `Remove CMS preview code from production bundles (${n})` },
  "css-weight": { theme: "CSS", impact: "LCP, bytes", effort: "M", risk: "needs-review", owner: "code", kbEach: 20, title: (n) => `Reduce CSS weight (${n} issue${s(n)})` },
  "use-client-inventory": { theme: "JS bundle", impact: "INP, bytes", effort: "M", risk: "needs-review", owner: "code", title: (n) => `Push "use client" boundaries down (${n} issue${s(n)})` },
  "ssr-false-misuse": { theme: "JS bundle", impact: "LCP, INP", effort: "S", risk: "needs-review", owner: "code", title: (n) => `Fix ${n} ssr:false misuse${s(n)} in server components` },
};

const THEME_TEXT: [RegExp, Theme][] = [
  [/third|script|tag|gtm|vendor|analytics|pixel|widget/i, "Third parties"],
  [/image|img|lcp|picture/i, "Images"],
  [/font/i, "Fonts"],
  [/payload|transfer|compress|gzip|brotli/i, "Payload"],
  [/css|style/i, "CSS"],
  [/cache|ttfb|cdn|header|dynamic|isr|static|revalidate|render/i, "Rendering/caching"],
  [/bundle|js|long-task|tbt|inp|main-thread/i, "JS bundle"],
];
const IMPACT: Record<Theme, string> = {
  "Third parties": "INP, LCP, bytes",
  "Rendering/caching": "TTFB, LCP",
  "CMS blocks/registry": "INP, bytes",
  Images: "LCP, CLS, bytes",
  Fonts: "LCP, CLS",
  "JS bundle": "INP, LCP, bytes",
  Payload: "bytes, TTFB",
  Dependencies: "INP, bytes",
  CSS: "LCP, bytes",
};
export const THEME_ORDER: Theme[] = [
  "Third parties", "Rendering/caching", "CMS blocks/registry", "Images", "Fonts", "JS bundle", "Payload", "Dependencies", "CSS",
];

const VENDORS: [RegExp, string][] = [
  [/googletagmanager|gtm\b/i, "Google Tag Manager"],
  [/google-analytics|gtag|\bga4?\b/i, "Google Analytics"],
  [/facebook|fbevents|meta pixel/i, "Meta Pixel"],
  [/hotjar/i, "Hotjar"],
  [/intercom/i, "Intercom"],
  [/hubspot|hs-scripts/i, "HubSpot"],
  [/segment\.(com|io)|analytics\.js/i, "Segment"],
  [/drift/i, "Drift"],
  [/onetrust|cookiebot|osano|consent/i, "Consent manager"],
  [/clarity\.ms/i, "Microsoft Clarity"],
  [/tiktok/i, "TikTok"],
  [/linkedin|licdn/i, "LinkedIn"],
  [/youtube|ytimg/i, "YouTube"],
  [/maps\.google|googleapis\.com\/maps|mapbox/i, "Maps"],
  [/calendly/i, "Calendly"],
  [/zendesk|zdassets/i, "Zendesk"],
  [/optimizely|vwo|abtasty/i, "A/B testing"],
];

function vendorsOf(text: string): string[] {
  return VENDORS.filter(([re]) => re.test(text)).map(([, n]) => n);
}

function sev(x: unknown): PlanSeverity {
  return x === "high" || x === "medium" || x === "low" ? x : "low";
}
function effortOf(x: unknown): Effort | undefined {
  const v = String(x ?? "").toUpperCase();
  return v === "S" || v === "M" || v === "L" ? (v as Effort) : undefined;
}
function owner(x: unknown, fallback: PlanOwner): PlanOwner {
  return OWNERS.includes(x as PlanOwner) ? (x as PlanOwner) : fallback;
}
const uniq = <T>(a: T[]): T[] => [...new Set(a)];
const maxSev = (a: PlanSeverity[]): PlanSeverity => a.reduce((m, x) => (SEV[x] > SEV[m] ? x : m), "low" as PlanSeverity);
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
function evidenceText(e: unknown): string {
  if (e == null) return "";
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return ""; }
}
function groupBy<T>(a: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of a) {
    const k = key(x);
    const l = m.get(k);
    if (l) l.push(x); else m.set(k, [x]);
  }
  return m;
}
function loc(f: RawFinding): string {
  return f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : (f.url ?? "?");
}

// ---- audit -> items --------------------------------------------------------

function auditItems(findings: RawFinding[]): { item: PlanItem; vendors: string[] }[] {
  const valid = findings.filter((f) => f && (f.check || f.id));
  const groups = groupBy(valid, (f) => {
    const check = f.check ?? String(f.id).split("/")[0];
    return check === "heavy-deps" ? (f.id ?? check) : check;
  });
  const out: { item: PlanItem; vendors: string[] }[] = [];
  for (const [gkey, list] of groups) {
    const check = list[0].check ?? String(list[0].id).split("/")[0];
    const meta = CHECK_META[check];
    const n = list.length;
    const theme = meta?.theme ?? themeFromText(`${check} ${list[0].message ?? ""}`);
    const severity = maxSev(list.map((f) => sev(f.severity)));
    const given = list.map((f) => f.impactScore).filter((x): x is number => typeof x === "number");
    const score = given.length
      ? clamp(given.reduce((a, b) => a + b, 0) / given.length + Math.min(15, (n - 1) * 3))
      : clamp(BASE_SCORE[severity] + Math.min(20, (n - 1) * 3));
    const effs = list.map((f) => effortOf(f.effort)).filter((x): x is Effort => !!x);
    let effort: Effort = effs.length === n ? (["L", "M", "S"] as Effort[]).find((e) => effs.includes(e))! : (meta?.effort ?? "M");
    if (effort === "S" && n > 8 && !effs.length) effort = "M";
    let risk: PlanRisk = meta?.risk ?? "needs-review";
    if (list.some((f) => /before-interactive/.test(f.id ?? ""))) risk = "needs-review";
    const files = uniq(list.map((f) => f.file).filter((x): x is string => !!x)).slice(0, 50);
    const steps = [`Apply the fix at each of the ${n} location${s(n)} below, then rebuild.`];
    const shown = list.slice(0, MAX_LOCATIONS);
    for (const f of shown) steps.push(`${loc(f)}: ${f.fix ?? f.message ?? "see finding"}`);
    if (n > shown.length) steps.push(`... and ${n - shown.length} more (see .wimb/audit.json, check "${check}")`);
    const vendors = uniq(list.flatMap((f) => vendorsOf(`${f.message ?? ""} ${f.fix ?? ""} ${f.file ?? ""}`)));
    const kb = meta?.kbEach ? meta.kbEach * n : undefined;
    out.push({
      vendors,
      item: {
        key: `audit:${gkey}`,
        rank: 0,
        source: "audit",
        sources: ["audit"],
        corroborated: false,
        theme,
        title: meta ? meta.title(n) : `${check}: ${n} finding${s(n)}`,
        why: list[0].message ?? `${check} flagged by static audit`,
        impact: meta?.impact ?? IMPACT[theme],
        impactScore: score,
        effort,
        owner: owner(meta?.owner, "code"),
        severity,
        count: n,
        files,
        exactInstructions: steps,
        verify: `npx --yes @maxwellcohen/wimb audit --checks ${check}   # expect 0 findings for this check`,
        risk,
        ...(kb ? { estKB: kb, kbBasis: "rough" as const } : {}),
      },
    });
  }
  return out;
}

function themeFromText(t: string): Theme {
  for (const [re, th] of THEME_TEXT) if (re.test(t)) return th;
  return "Rendering/caching";
}

// ---- wins -> items ---------------------------------------------------------

function winItems(wins: RawWin[]): PlanItem[] {
  const out: PlanItem[] = [];
  for (const w of wins) {
    const bytes = w.predictedSavedBytes ?? w.totalSavedBytes ?? 0;
    if (!w.edge || bytes <= 0) continue;
    const kb = bytes / 1024;
    const importer = w.edge.importer ?? "?";
    const imported = w.edge.imported ?? "?";
    const isPkg = !!w.edge.packageName;
    const kind = w.fixKind ?? "lazy";
    const theme: Theme = /block|registry|cms/i.test(`${importer} ${imported}`)
      ? "CMS blocks/registry"
      : kind === "stub-alias" ? "JS bundle" : isPkg || kind === "swap-package" ? "Dependencies" : "JS bundle";
    const score = clamp(15 + kb * 1.5);
    const edit = w.edit ?? {};
    const steps = [...(edit.steps ?? [])];
    const elsewhere = w.alsoReachableVia?.[0];
    if (elsewhere) steps.unshift(`Also statically reachable via ${elsewhere.join(" -> ")}: cutting this edge alone may save nothing. Verify with --compare and revert if bytes do not drop.`);
    if (edit.originalImport && edit.replacementImport) steps.unshift(`Replace \`${edit.originalImport}\` with \`${edit.replacementImport}\``);
    if (!steps.length) steps.push(edit.summary ?? `${kind} ${imported} from ${importer}`);
    const routes = Object.keys(w.routes ?? {});
    out.push({
      key: `wins:${w.id ?? `${kind}:${importer}:${imported}`}`,
      rank: 0,
      source: "wins",
      sources: ["wins"],
      corroborated: false,
      theme,
      title: edit.summary ?? `${kind}: ${imported} in ${importer}`,
      why: `Removes ~${kb.toFixed(1)} KB (${w.byteSource ?? "estimated"}) from first-load JS${routes.length ? ` on ${routes.length} route${s(routes.length)}` : ""}.`,
      impact: IMPACT[theme],
      impactScore: score,
      effort: kind === "swap-package" || kind === "move-to-server" ? "M" : "S",
      owner: "code",
      severity: kb >= 50 ? "high" : kb >= 10 ? "medium" : "low",
      count: 1,
      files: uniq([importer, isPkg ? "" : imported].filter(Boolean)),
      exactInstructions: steps,
      verify: edit.verify ?? "npx --yes @maxwellcohen/wimb wins --compare .wimb/wins.json",
      risk: w.safety === "safe" ? "safe" : "needs-review",
      estKB: Math.round(kb * 10) / 10,
      kbBasis: w.byteSource === "measured" ? "measured" : "estimated",
    });
  }
  return out;
}

// ---- live -> items ---------------------------------------------------------

const OWNER_PREFACE: Record<string, string> = {
  gtm: "In Google Tag Manager (tagmanager.google.com): open the container, then Workspace.",
  cdn: "In your CDN/edge dashboard (Cloudflare, Fastly, CloudFront, Vercel...):",
  cms: "In the CMS admin/editor settings:",
};

function liveItems(findings: RawFinding[]): { item: PlanItem; vendors: string[] }[] {
  const valid = findings.filter((f) => f && (f.check || f.id));
  const groups = groupBy(valid, (f) => `${f.check ?? f.id}|${owner(f.owner, "code")}`);
  const out: { item: PlanItem; vendors: string[] }[] = [];
  for (const [gkey, list] of groups) {
    const first = list[0];
    const check = first.check ?? String(first.id);
    const own = owner(first.owner, "code");
    const urls = uniq(list.map((f) => f.url).filter((x): x is string => !!x));
    const severity = maxSev(list.map((f) => sev(f.severity)));
    const score = clamp(BASE_SCORE[severity] + 5 + Math.min(15, (urls.length - 1) * 5));
    const theme = themeFromText(`${check} ${first.message ?? ""}`);
    const steps: string[] = [];
    if (OWNER_PREFACE[own]) steps.push(OWNER_PREFACE[own]);
    steps.push(first.fix ?? first.message ?? "See .wimb/live.md");
    for (const f of list.slice(0, MAX_LOCATIONS)) {
      const ev = evidenceText(f.evidence);
      if (f.url || ev) steps.push(`Seen on ${f.url ?? "?"}${ev ? `: ${ev.slice(0, 160)}` : ""}`);
    }
    const vendors = uniq(list.flatMap((f) => vendorsOf(`${f.message ?? ""} ${f.url ?? ""} ${evidenceText(f.evidence)}`)));
    const n = list.length;
    out.push({
      vendors,
      item: {
        key: `live:${gkey}`,
        rank: 0,
        source: "live",
        sources: ["live"],
        corroborated: false,
        theme,
        title: n === 1 ? (first.message ?? check) : `${check} on ${urls.length || n} page${s(urls.length || n)}`,
        why: first.message ?? `${check} measured on the live site`,
        impact: IMPACT[theme],
        impactScore: score,
        effort: own === "code" ? "M" : "S",
        owner: own,
        severity,
        count: n,
        files: [],
        urls,
        exactInstructions: steps,
        verify: `npx --yes @maxwellcohen/wimb live ${urls[0] ?? "<url>"}   # expect "${check}" to clear`,
        risk: own === "code" ? "needs-review" : "safe",
      },
    });
  }
  return out;
}

// ---- merge + rank ----------------------------------------------------------

export function priority(i: Pick<PlanItem, "impactScore" | "effort">): number {
  return i.impactScore / EFFORT_WEIGHT[i.effort];
}

export function buildItems(inputs: PlanInputs): PlanItem[] {
  const audit = auditItems(inputs.audit?.findings ?? []);
  const wins = winItems(inputs.wins?.wins ?? []);
  const live = liveItems(inputs.live?.findings ?? []);
  const items: PlanItem[] = [...audit.map((a) => a.item), ...wins];
  const vendorMap = new Map(audit.map((a) => [a.item, a.vendors]));

  for (const l of live) {
    const candidates = l.item.owner === "code" ? audit.filter((a) => a.item.theme === l.item.theme) : [];
    const target =
      candidates.find((a) => a.vendors.some((v) => l.vendors.includes(v))) ??
      (l.vendors.length === 0 ? candidates[0] : candidates.find((a) => a.vendors.length === 0));
    if (!target) {
      items.push(l.item);
      continue;
    }
    const t = target.item;
    t.sources = uniq([...t.sources, "live" as PlanSource]);
    t.corroborated = true;
    t.impactScore = clamp(Math.max(t.impactScore, l.item.impactScore) * 1.25);
    t.severity = maxSev([t.severity, l.item.severity]);
    t.urls = uniq([...(t.urls ?? []), ...(l.item.urls ?? [])]);
    t.why = `${t.why} Confirmed live: ${l.item.why}${l.vendors.length ? ` (${l.vendors.join(", ")})` : ""}.`;
    t.exactInstructions.push(`Live confirmation (${l.item.count} finding${s(l.item.count)}): ${l.item.exactInstructions.filter((x) => !x.startsWith("Seen on")).join(" ")}`);
    t.verify += `; then ${l.item.verify}`;
    vendorMap.set(t, uniq([...(vendorMap.get(t) ?? []), ...l.vendors]));
  }
  return rank(items);
}

export function rank(items: PlanItem[]): PlanItem[] {
  items.sort((a, b) => priority(b) - priority(a) || b.impactScore - a.impactScore || a.key.localeCompare(b.key));
  items.forEach((i, idx) => (i.rank = idx + 1));
  return items;
}

// ---- sections / derived views ---------------------------------------------

export const isNotCode = (i: PlanItem) => i.owner === "gtm" || i.owner === "cdn" || i.owner === "cms";
export const isDecision = (i: PlanItem) => i.owner === "human-decision" || (i.owner === "code" && i.risk === "needs-review");
export const isDoFirst = (i: PlanItem) => i.owner === "code" && i.risk === "safe" && i.impactScore >= 15;
const isQuick = (i: PlanItem) => isDoFirst(i) && i.effort === "S";

export interface Sections {
  doFirst: PlanItem[];
  decision: PlanItem[];
  notCode: PlanItem[];
  later: PlanItem[];
  quickWins: PlanItem[];
}
export function sectionize(items: PlanItem[], top: number): Sections {
  const safe = items.filter(isDoFirst);
  const doFirst = safe.slice(0, top);
  const placed = new Set(doFirst);
  const decision = items.filter((i) => !placed.has(i) && !isNotCode(i) && !isDoFirst(i) && isDecision(i) && i.impactScore >= 15);
  const notCode = items.filter(isNotCode);
  const shown = new Set([...doFirst, ...decision, ...notCode]);
  const later = items.filter((i) => !shown.has(i));
  return { doFirst, decision, notCode, later, quickWins: items.filter(isQuick).slice(0, 5) };
}

export function speedBudget(items: PlanItem[]): { theme: string; kb: number; basis: "measured" | "rough" | "mixed" }[] {
  const m = new Map<string, { kb: number; bases: Set<string> }>();
  for (const i of items) {
    if (!i.estKB) continue;
    const e = m.get(i.theme) ?? { kb: 0, bases: new Set<string>() };
    e.kb += i.estKB;
    e.bases.add(i.kbBasis === "rough" ? "rough" : "measured");
    m.set(i.theme, e);
  }
  return [...m.entries()]
    .map(([theme, e]) => ({ theme, kb: Math.round(e.kb), basis: (e.bases.size > 1 ? "mixed" : [...e.bases][0]) as "measured" | "rough" | "mixed" }))
    .sort((a, b) => b.kb - a.kb);
}

export function headline(items: PlanItem[], sec: Sections): string {
  if (!items.length) return "No findings: nothing to fix from the inputs provided.";
  const kbQuick = sec.doFirst.reduce((n, i) => n + (i.estKB ?? 0), 0);
  const parts = [
    `${items.length} items`,
    `${sec.quickWins.length} quick win${s(sec.quickWins.length)} (<30 min, safe)`,
    `${sec.doFirst.length} safe code fix${sec.doFirst.length === 1 ? "" : "es"}${kbQuick ? ` worth ~${Math.round(kbQuick)} KB` : ""}`,
    `${sec.decision.length} need a decision`,
    `${sec.notCode.length} not code`,
  ];
  return parts.join(" · ");
}

export function biggestRisk(items: PlanItem[]): string | undefined {
  const r = items.filter((i) => i.risk === "needs-review" && i.owner !== "gtm" && i.owner !== "cdn" && i.owner !== "cms").sort((a, b) => b.impactScore - a.impactScore)[0];
  return r ? `#${r.rank} ${r.title}: high payoff (score ${r.impactScore}) but can change behavior; review before merging and test affected pages.` : undefined;
}

export function pageTypeOf(url: string): string {
  let path = url;
  try { path = new URL(url).pathname; } catch { /* keep raw */ }
  const segs = path.split("/").filter(Boolean);
  if (segs.length === 0) return "home (/)";
  return segs.length === 1 ? `/${segs[0]}` : `/${segs[0]}/*`;
}

export function pageTypes(live: RawFinding[]): PageTypeRow[] {
  const rows = new Map<string, { urls: Set<string>; c: Record<PlanSeverity, number>; issues: Map<string, number> }>();
  for (const f of live) {
    if (!f?.url) continue;
    const t = pageTypeOf(f.url);
    const r = rows.get(t) ?? { urls: new Set(), c: { high: 0, medium: 0, low: 0 }, issues: new Map() };
    r.urls.add(f.url);
    r.c[sev(f.severity)]++;
    const k = f.check ?? f.id ?? "?";
    r.issues.set(k, (r.issues.get(k) ?? 0) + SEV[sev(f.severity)]);
    rows.set(t, r);
  }
  return [...rows.entries()]
    .map(([type, r]) => ({
      type, urls: r.urls.size, ...r.c,
      topIssue: [...r.issues.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
    }))
    .sort((a, b) => b.high - a.high || b.medium - a.medium || a.type.localeCompare(b.type));
}

// ---- compare ---------------------------------------------------------------

export function comparePlans(prev: { items?: Partial<PlanItem>[] } | null | undefined, cur: PlanItem[]): PlanCompare {
  const before = new Map((prev?.items ?? []).filter((i) => i.key).map((i) => [i.key as string, i]));
  const now = new Map(cur.map((i) => [i.key, i]));
  const resolved = [...before.values()]
    .filter((p) => !now.has(p.key as string))
    .map((p) => ({ key: p.key as string, title: p.title ?? p.key!, theme: (p.theme ?? "JS bundle") as Theme }));
  const added = cur.filter((i) => !before.has(i.key)).map((i) => ({ key: i.key, title: i.title, theme: i.theme, impactScore: i.impactScore }));
  const regressed: PlanCompare["regressed"] = [];
  let unchanged = 0;
  for (const i of cur) {
    const p = before.get(i.key);
    if (!p) continue;
    const from = p.impactScore ?? 0;
    if (i.impactScore - from >= 10) regressed.push({ key: i.key, title: i.title, from, to: i.impactScore, reason: "impact score increased" });
    else if ((p.count ?? 0) > 0 && i.count > (p.count ?? 0)) regressed.push({ key: i.key, title: i.title, from, to: i.impactScore, reason: `more locations (${p.count} -> ${i.count})` });
    else unchanged++;
  }
  return { resolved, new: added, regressed, unchanged };
}

import { estimateTransfer } from "./checks-assets.js";
import type { AssetInfo, Hop, PageInput } from "./types.js";

export const DEFAULT_UA = "wimb-live/1 (+https://github.com/MaxwellCohen/where-is-my-banana; performance audit)";
export const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 wimb-live/1";

export class Budget {
  used = 0;
  exhausted = false;
  constructor(readonly max: number) {}
  /** requests held back for pages not yet fetched; optional (asset) requests cannot dip into it */
  reserved = 0;
  take(optional = false): boolean {
    if (this.used >= this.max - (optional ? this.reserved : 0)) {
      this.exhausted = true;
      return false;
    }
    this.used++;
    return true;
  }
}

export interface NetOpts {
  timeoutMs: number;
  userAgent: string;
  budget: Budget;
}

function lowerHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k.toLowerCase()] = v));
  const sc = (h as any).getSetCookie?.() as string[] | undefined;
  if (sc?.length) out["set-cookie"] = sc.join("\n");
  return out;
}

async function timedFetch(url: string, init: RequestInit, o: NetOpts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), o.timeoutMs);
  const start = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { "user-agent": o.userAgent, "accept-language": "en-US,en;q=0.9", ...(init.headers as any) } });
    return { res, headersMs: performance.now() - start, start, clear: () => clearTimeout(t) };
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

/** GET the HTML once, following up to 5 redirects manually. */
export async function fetchPage(url: string, o: NetOpts): Promise<PageInput> {
  const hops: Hop[] = [];
  let cur = url;
  const t0 = performance.now();
  for (let i = 0; i <= 5; i++) {
    if (!o.budget.take()) throw new Error("request budget exhausted");
    const { res, headersMs, clear } = await timedFetch(cur, { redirect: "manual", headers: { accept: "text/html,application/xhtml+xml" } }, o);
    const headers = lowerHeaders(res.headers);
    if (res.status >= 300 && res.status < 400 && headers.location) {
      await res.body?.cancel().catch(() => {});
      clear();
      const next = new URL(headers.location, cur).href;
      hops.push({ url: cur, status: res.status, location: next, ms: headersMs });
      cur = next;
      continue;
    }
    try {
      const html = await res.text();
      return { url, finalUrl: cur, status: res.status, html, headers, ttfbMs: headersMs, totalMs: performance.now() - t0, redirects: hops };
    } finally {
      clear();
    }
  }
  throw new Error("too many redirects (>5)");
}

export async function fetchText(url: string, o: NetOpts, optional = false): Promise<string | undefined> {
  if (!o.budget.take(optional)) return undefined;
  try {
    const { res, clear } = await timedFetch(url, {}, o);
    try {
      return res.ok ? await res.text() : undefined;
    } finally {
      clear();
    }
  } catch {
    return undefined;
  }
}

/** HEAD for size; falls back to a 1-byte ranged GET (content-range total). */
export async function headAsset(url: string, kind: string, o: NetOpts): Promise<AssetInfo> {
  const accept: Record<string, string> = kind === "image" ? { accept: "image/avif,image/webp,image/*,*/*;q=0.8" } : {};
  const info: AssetInfo = { url };
  const read = (res: Response, h: Record<string, string>) => {
    info.status = res.status;
    info.encoding = h["content-encoding"];
    info.contentType = h["content-type"];
    const cr = h["content-range"]?.match(/\/(\d+)$/);
    const len = cr ? Number(cr[1]) : h["content-length"] ? Number(h["content-length"]) : undefined;
    if (len !== undefined && Number.isFinite(len)) {
      info.bytes = len;
      info.transferEst = estimateTransfer(len, cr ? undefined : info.encoding, info.contentType);
    }
  };
  try {
    if (!o.budget.take(true)) return info;
    const a = await timedFetch(url, { method: "HEAD", headers: accept }, o);
    a.clear();
    read(a.res, lowerHeaders(a.res.headers));
    if (info.bytes !== undefined && a.res.ok) return info;
    if (!o.budget.take(true)) return info;
    const b = await timedFetch(url, { headers: { ...accept, range: "bytes=0-0" } }, o);
    await b.res.body?.cancel().catch(() => {});
    b.clear();
    read(b.res, lowerHeaders(b.res.headers));
  } catch {
    /* leave info partial */
  }
  return info;
}

export async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

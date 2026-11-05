export interface El {
  name: string;
  attrs: Record<string, string>;
  /** body text for script/style/noscript */
  text?: string;
  pos: number;
  inHead: boolean;
  depth: number;
}

export interface Parsed {
  els: El[];
  nodeCount: number;
  maxDepth: number;
  inlineStyleAttrs: number;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

const RE =
  /<!--[\s\S]*?-->|<(script|style|noscript)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/\1\s*>|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
const ATTR_RE = /([^\s=\/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(src))) {
    const k = m[1].toLowerCase();
    if (k in out) continue;
    out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** Tolerant, regex-based tokenizer; good enough for audit heuristics. */
export function parseHtml(html: string): Parsed {
  const els: El[] = [];
  const stack: string[] = [];
  let inHead = false;
  let maxDepth = 0;
  let inlineStyleAttrs = 0;
  RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(html))) {
    if (m[0].startsWith("<!--")) continue;
    if (m[1]) {
      const name = m[1].toLowerCase();
      els.push({ name, attrs: parseAttrs(m[2]), text: m[3], pos: m.index, inHead, depth: stack.length + 1 });
      maxDepth = Math.max(maxDepth, stack.length + 1);
      continue;
    }
    const closing = m[4] === "/";
    const name = m[5].toLowerCase();
    if (closing) {
      if (name === "head") inHead = false;
      const i = stack.lastIndexOf(name);
      if (i >= 0) stack.length = i;
      continue;
    }
    if (name === "head") inHead = true;
    if (name === "body") inHead = false;
    const attrs = parseAttrs(m[6]);
    if (attrs.style) inlineStyleAttrs++;
    els.push({ name, attrs, pos: m.index, inHead, depth: stack.length + 1 });
    maxDepth = Math.max(maxDepth, stack.length + 1);
    if (!VOID.has(name) && !m[6].trimEnd().endsWith("/")) stack.push(name);
  }
  return { els, nodeCount: els.length, maxDepth, inlineStyleAttrs };
}

export function byName(p: Parsed, name: string): El[] {
  return p.els.filter((e) => e.name === name);
}

export function resolveUrl(href: string, base: string): string | undefined {
  try {
    if (/^(data|blob|javascript|mailto|tel):/i.test(href.trim())) return undefined;
    return new URL(href.trim(), base).href;
  } catch {
    return undefined;
  }
}

/** Crude registrable domain (handles common 2-level TLDs). */
export function registrable(host: string): string {
  const parts = host.toLowerCase().split(".");
  if (parts.length <= 2) return host.toLowerCase();
  const last2 = parts.slice(-2).join(".");
  if (/^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(last2)) return parts.slice(-3).join(".");
  return last2;
}

export function isThirdParty(url: string, pageUrl: string): boolean {
  try {
    return registrable(new URL(url).hostname) !== registrable(new URL(pageUrl).hostname);
  } catch {
    return false;
  }
}

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Finding } from "./types.js";
import { matches } from "./util.js";

export interface FixChange {
  file: string;
  line: number;
  fixer: string;
  description: string;
}
export interface FixSkip {
  file: string;
  line?: number;
  reason: string;
}
export interface FileEdit {
  file: string;
  before: string;
  after: string;
}
export interface FixResult {
  changes: FixChange[];
  skipped: FixSkip[];
  edits: FileEdit[];
}

interface Replacement {
  start: number;
  end: number;
  text: string;
  change: FixChange;
}

const THIRD_PARTY =
  /googletagmanager|google-analytics|gtag|analytics\.js|segment\.(?:com|io)|cdn\.segment|hotjar|fullstory|optimizely|onetrust|cookiebot|cookielaw|intercom|drift\.com|driftt|livechat|calendly|connect\.facebook|facebook\.net|fbevents|tiktok|clarity\.ms|dataLayer/i;
const CONSENT = /onetrust|cookiebot|cookielaw|consent/i;
const ABOVE_FOLD_PATH = /hero|banner|masthead|header|nav|logo/i;

const bySuffix = (findings: Finding[], ids: string[]) => findings.filter((f) => ids.includes(f.id));

/** Opening `<Name ...>` tags (including their full text) that start on `line`. */
function tagsOnLine(content: string, name: string, line: number) {
  const re = new RegExp(`<${name}\\b((?:[^>]|=>)*)>`, "g");
  return [...matches(content, re)].filter((t) => t.line === line);
}

function scriptBody(content: string, tagEnd: number, selfClosing: boolean): string {
  if (selfClosing) return "";
  const close = content.indexOf("</Script>", tagEnd);
  return close < 0 ? "" : content.slice(tagEnd, close);
}

function fixScripts(file: string, c: string, findings: Finding[], reps: Replacement[], skipped: FixSkip[]) {
  for (const fd of bySuffix(findings, ["third-party-script/no-strategy", "third-party-script/before-interactive"])) {
    const tags = tagsOnLine(c, "Script", fd.line);
    if (tags.length !== 1) {
      skipped.push({ file, line: fd.line, reason: "ambiguous <Script> location" });
      continue;
    }
    const { m } = tags[0];
    const text = m[0];
    const end = m.index + text.length;
    const snippet = text + scriptBody(c, end, /\/>$/.test(text));
    if (CONSENT.test(snippet)) {
      skipped.push({ file, line: fd.line, reason: "consent manager script: reported, not changed (confirm with legal/owner)" });
      continue;
    }
    if (!THIRD_PARTY.test(snippet)) {
      skipped.push({ file, line: fd.line, reason: "could not confirm third-party script from the tag itself" });
      continue;
    }
    if (/\{\s*\.\.\./.test(m[1])) {
      skipped.push({ file, line: fd.line, reason: "<Script> spreads props; strategy may come from them" });
      continue;
    }
    const strat = m[1].match(/strategy\s*=\s*(\{?\s*["'])(\w+)(["'])/);
    if (!strat && /strategy\s*=/.test(m[1])) {
      skipped.push({ file, line: fd.line, reason: "dynamic strategy expression" });
      continue;
    }
    if (strat) {
      const at = m.index + text.indexOf(strat[0]) + strat[0].lastIndexOf(strat[2]);
      reps.push({ start: at, end: at + strat[2].length, text: "lazyOnload", change: { file, line: fd.line, fixer: "script-strategy", description: `strategy="${strat[2]}" -> "lazyOnload"` } });
    } else {
      const at = m.index + "<Script".length;
      reps.push({ start: at, end: at, text: ' strategy="lazyOnload"', change: { file, line: fd.line, fixer: "script-strategy", description: 'added strategy="lazyOnload"' } });
    }
  }
}

function fixFontDisplay(file: string, c: string, findings: Finding[], reps: Replacement[], skipped: FixSkip[]) {
  for (const fd of bySuffix(findings, ["fonts/display"])) {
    const lines = c.split("\n");
    const lineStart = lines.slice(0, fd.line - 1).reduce((n, l) => n + l.length + 1, 0);
    // The finding points at the `= Font({` statement; the display value is inside that call.
    const rest = c.slice(lineStart);
    const call = rest.match(/=\s*[A-Z][\w]*\(\s*\{([\s\S]*?)\}\s*\)/);
    const d = call && call[1].match(/\bdisplay\s*:\s*(["'])(\w+)\1/);
    if (!call || !d || d.index === undefined) {
      skipped.push({ file, line: fd.line, reason: "could not locate font `display` option" });
      continue;
    }
    const valueAt = lineStart + call.index! + call[0].indexOf(call[1]) + d.index + d[0].indexOf(d[2], d[0].indexOf(d[1]) + 1);
    reps.push({ start: valueAt, end: valueAt + d[2].length, text: "swap", change: { file, line: fd.line, fixer: "font-display", description: `display "${d[2]}" -> "swap"` } });
  }
}

function fixSsrFalse(file: string, c: string, findings: Finding[], reps: Replacement[], skipped: FixSkip[]) {
  const done = new Set<number>();
  for (const fd of findings.filter((f) => f.check === "ssr-false-misuse")) {
    if (done.has(fd.line)) continue;
    done.add(fd.line);
    const lineStart = c.split("\n").slice(0, fd.line - 1).reduce((n, l) => n + l.length + 1, 0);
    const tok = c.slice(lineStart).match(/\bssr\s*:\s*false\b/);
    if (!tok || tok.index === undefined) {
      skipped.push({ file, line: fd.line, reason: "could not locate `ssr: false`" });
      continue;
    }
    const at = lineStart + tok.index;
    // Widen to the surrounding option object so we can drop an object that becomes empty.
    const before = c.slice(0, at);
    const after = c.slice(at + tok[0].length);
    const whole = before.match(/,\s*\{\s*$/) && after.match(/^\s*,?\s*\}/);
    let start = at;
    let end = at + tok[0].length;
    if (whole) {
      start = before.search(/,\s*\{\s*$/);
      end = at + tok[0].length + after.match(/^\s*,?\s*\}/)![0].length;
    } else {
      const trailing = after.match(/^[ \t]*,[ \t]*\n?/);
      const leading = before.match(/,\s*$/);
      const ownLine = before.match(/\n[ \t]*$/) && /^[ \t]*,?[ \t]*\n/.test(after);
      if (ownLine && trailing) {
        start = at - before.match(/[ \t]*$/)![0].length;
        end = at + tok[0].length + trailing[0].length;
      } else if (trailing) {
        end += after.match(/^[ \t]*,[ \t]*/)![0].length;
      } else if (leading) {
        start = before.search(/,\s*$/);
      } else {
        skipped.push({ file, line: fd.line, reason: "ambiguous `ssr: false` position" });
        continue;
      }
    }
    reps.push({ start, end, text: "", change: { file, line: fd.line, fixer: "ssr-false", description: "removed `ssr: false` from dynamic() options" } });
  }
}

function fixImageFormats(file: string, c: string, findings: Finding[], reps: Replacement[], skipped: FixSkip[]) {
  if (!bySuffix(findings, ["image-config/formats"]).length) return;
  const line = findings.find((f) => f.id === "image-config/formats")!.line;
  if (/\bformats\s*:/.test(c)) return;
  const decl = [...c.matchAll(/(?:module\.exports\s*=|export\s+default|const\s+\w*[cC]onfig(?:\s*:\s*[\w.]+)?\s*=)\s*\{/g)];
  const imagesKey = [...c.matchAll(/\bimages\s*:\s*(\{)?/g)];
  if (imagesKey.length > 1) return void skipped.push({ file, line, reason: "multiple `images` keys" });
  const val = "formats: [\"image/avif\", \"image/webp\"]";
  if (imagesKey.length === 1) {
    if (!imagesKey[0][1]) return void skipped.push({ file, line, reason: "`images` is not an inline object" });
    const at = imagesKey[0].index! + imagesKey[0][0].length;
    const nextLine = c.slice(at).match(/^[ \t]*\n([ \t]*)\S/);
    const text = nextLine ? `\n${nextLine[1]}${val},` : ` ${val},`;
    reps.push({ start: at, end: at, text, change: { file, line, fixer: "image-formats", description: "added images.formats avif+webp" } });
    return;
  }
  if (decl.length !== 1) return void skipped.push({ file, line, reason: "next.config shape is not a single plain config object" });
  const at = decl[0].index! + decl[0][0].length;
  const nl = c.slice(at).match(/^[ \t]*\n([ \t]*)\S/);
  const ind = nl ? nl[1] : "  ";
  const text = nl ? `\n${ind}images: { ${val} },` : ` images: { ${val} },`;
  reps.push({ start: at, end: at, text, change: { file, line, fixer: "image-formats", description: "added images.formats avif+webp" } });
}

function fixHeroPriority(file: string, c: string, findings: Finding[], reps: Replacement[], skipped: FixSkip[]) {
  const fd = findings.find((f) => f.check === "lcp-priority");
  if (!fd) return;
  const tags = tagsOnLine(c, "Image", fd.line);
  if (tags.length < 1) return void skipped.push({ file, line: fd.line, reason: "could not locate hero <Image>" });
  const { m } = tags[0];
  const around = c.slice(Math.max(0, m.index - 300), m.index);
  if (/\.map\s*\(/.test(around)) return void skipped.push({ file, line: fd.line, reason: "hero <Image> is rendered in a list/carousel; pick the LCP slide by hand" });
  if (/\bloading\s*=/.test(m[1]) || /\{\s*\.\.\./.test(m[1])) return void skipped.push({ file, line: fd.line, reason: "hero <Image> has loading/spread props; priority could conflict" });
  const at = m.index + "<Image".length;
  reps.push({ start: at, end: at, text: " priority", change: { file, line: fd.line, fixer: "hero-priority", description: "added `priority` to hero <Image>" } });
}

function fixRawImg(file: string, c: string, findings: Finding[], reps: Replacement[], skipped: FixSkip[]) {
  const fds = findings.filter((f) => f.check === "raw-img");
  if (!fds.length) return;
  if (ABOVE_FOLD_PATH.test(file)) return void skipped.push({ file, reason: "above-the-fold file (hero/header/nav/logo): <img> left alone" });
  const lines = new Set(fds.map((f) => f.line));
  for (const { m, line } of matches(c, /<img\b((?:[^>]|=>)*)>/)) {
    if (!lines.has(line)) continue;
    const attrs = m[1];
    if (/\{\s*\.\.\./.test(attrs)) {
      skipped.push({ file, line, reason: "<img> spreads props" });
      continue;
    }
    if (/fetchPriority|loading\s*=\s*["']eager|logo/i.test(attrs)) {
      skipped.push({ file, line, reason: "<img> looks above-the-fold (eager/high priority/logo)" });
      continue;
    }
    let add = "";
    if (!/\bloading\s*=/.test(attrs)) add += ' loading="lazy"';
    if (!/\bdecoding\s*=/.test(attrs)) add += ' decoding="async"';
    if (!add) continue;
    const at = m.index + "<img".length;
    reps.push({ start: at, end: at, text: add, change: { file, line, fixer: "img-lazy", description: `added${add}` } });
  }
}

/** Pure: compute fixes for files given the findings from an audit run. */
export function computeFixes(files: { path: string; content: string }[], findings: Finding[]): FixResult {
  const result: FixResult = { changes: [], skipped: [], edits: [] };
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  for (const src of files) {
    const fs = byFile.get(src.path);
    if (!fs) continue;
    const reps: Replacement[] = [];
    const c = src.content;
    fixScripts(src.path, c, fs, reps, result.skipped);
    fixFontDisplay(src.path, c, fs, reps, result.skipped);
    fixSsrFalse(src.path, c, fs, reps, result.skipped);
    fixImageFormats(src.path, c, fs, reps, result.skipped);
    fixHeroPriority(src.path, c, fs, reps, result.skipped);
    fixRawImg(src.path, c, fs, reps, result.skipped);
    if (!reps.length) continue;
    reps.sort((a, b) => b.start - a.start);
    // drop overlapping edits (keep the later-in-file one first, skip anything that collides)
    const kept: Replacement[] = [];
    for (const r of reps) {
      if (kept.length && r.end > kept[kept.length - 1].start) {
        result.skipped.push({ file: src.path, line: r.change.line, reason: "overlaps another fix; re-run" });
        continue;
      }
      kept.push(r);
    }
    let out = c;
    for (const r of kept) out = out.slice(0, r.start) + r.text + out.slice(r.end);
    result.changes.push(...kept.map((r) => r.change).reverse());
    result.edits.push({ file: src.path, before: c, after: out });
  }
  return result;
}

/** Paths (posix, relative to `root`) with unstaged/untracked changes, or null when `root` is not in a git repo. */
export function dirtyFiles(root: string): Set<string> | null {
  try {
    const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const out = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const rootAbs = realpathSync(resolve(root));
    const dirty = new Set<string>();
    const parts = out.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (e.length < 4) continue;
      const x = e[0];
      const y = e[1];
      const path = e.slice(3);
      if (x === "R" || x === "C") i++; // skip the rename source
      if (y === " ") continue; // fully staged: nothing unstaged to lose
      const abs = resolve(top, path);
      if (abs.startsWith(rootAbs + "/")) dirty.add(abs.slice(rootAbs.length + 1));
    }
    return dirty;
  } catch {
    return null;
  }
}

export interface ApplyOptions {
  dryRun?: boolean;
  force?: boolean;
}

export interface ApplyResult extends FixResult {
  /** Unified diff of all edits (always populated, even when written). */
  diff: string;
}

/** Compute fixes from findings, drop git-dirty files unless forced, optionally write. */
export function applyFixes(root: string, findings: Finding[], opts: ApplyOptions = {}): ApplyResult {
  const paths = [...new Set(findings.map((f) => f.file))];
  const files: { path: string; content: string }[] = [];
  for (const p of paths) {
    try {
      files.push({ path: p, content: readFileSync(join(root, p), "utf-8") });
    } catch {
      /* not a readable file */
    }
  }
  const res = computeFixes(files, findings);
  const dirty = opts.force ? null : dirtyFiles(root);
  if (dirty && dirty.size) {
    const blocked = new Set(res.edits.filter((e) => dirty.has(e.file)).map((e) => e.file));
    for (const b of blocked) res.skipped.push({ file: b, reason: "has unstaged changes (commit/stash them or pass --force)" });
    res.edits = res.edits.filter((e) => !blocked.has(e.file));
    res.changes = res.changes.filter((c) => !blocked.has(c.file));
  }
  if (!opts.dryRun) for (const e of res.edits) writeFileSync(join(root, e.file), e.after);
  return { ...res, diff: res.edits.map((e) => unifiedDiff(e.file, e.before, e.after)).join("") };
}

export function formatFixSummary(res: FixResult, dryRun: boolean): string {
  const L = [`wimb audit: ${dryRun ? "would change" : "changed"} ${res.changes.length} place(s) in ${res.edits.length} file(s)`];
  for (const c of res.changes) L.push(`  [${c.fixer}] ${c.file}:${c.line}  ${c.description}`);
  for (const s of res.skipped) L.push(`  skipped ${s.file}${s.line ? ":" + s.line : ""}  ${s.reason}`);
  return L.join("\n");
}

/** Minimal unified diff (3 lines context) between two texts. */
export function unifiedDiff(file: string, before: string, after: string): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  type Op = { t: " " | "-" | "+"; s: string };
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: " ", s: a[i] });
  if (am.length * bm.length > 4_000_000) {
    am.forEach((s) => ops.push({ t: "-", s }));
    bm.forEach((s) => ops.push({ t: "+", s }));
  } else {
    const n = am.length;
    const m = bm.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        ops.push({ t: " ", s: am[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: "-", s: am[i++] });
      else ops.push({ t: "+", s: bm[j++] });
    }
    while (i < n) ops.push({ t: "-", s: am[i++] });
    while (j < m) ops.push({ t: "+", s: bm[j++] });
  }
  for (let i = a.length - suf; i < a.length; i++) ops.push({ t: " ", s: a[i] });
  const CTX = 3;
  const out = [`--- a/${file}`, `+++ b/${file}`];
  const changed = ops.map((o, i) => (o.t === " " ? -1 : i)).filter((i) => i >= 0);
  let k = 0;
  while (k < changed.length) {
    let lo = Math.max(0, changed[k] - CTX);
    let hi = changed[k];
    while (k < changed.length && changed[k] - hi <= 2 * CTX + 1) hi = changed[k++];
    hi = Math.min(ops.length - 1, hi + CTX);
    let aStart = 1;
    let bStart = 1;
    for (let i = 0; i < lo; i++) {
      if (ops[i].t !== "+") aStart++;
      if (ops[i].t !== "-") bStart++;
    }
    const slice = ops.slice(lo, hi + 1);
    const aLen = slice.filter((o) => o.t !== "+").length;
    const bLen = slice.filter((o) => o.t !== "-").length;
    out.push(`@@ -${aLen ? aStart : aStart - 1},${aLen} +${bLen ? bStart : bStart - 1},${bLen} @@`);
    for (const o of slice) out.push(o.t + o.s);
  }
  return out.join("\n") + "\n";
}

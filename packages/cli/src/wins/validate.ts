import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { resolveDistDir } from "../build/analyze.js";
import type { ValidationReport, ValidationRoute, WinsReport } from "./types.js";

export interface ValidateOptions {
  projectRoot: string;
  distDir?: string;
  htmlDir?: string;
  url?: string;
  tolerance?: number;
  report: WinsReport;
  fetchFn?: typeof fetch;
  delayMs?: number;
}

interface ParsedHtml {
  scripts: string[];
  preloads: string[];
  nomodule: number;
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const body = tag.replace(/^<\s*[a-zA-Z]+/, "");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

export function parseHtmlAssets(html: string): ParsedHtml {
  const scripts: string[] = [];
  const preloads: string[] = [];
  let nomodule = 0;
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (!a.src) continue;
    if ("nomodule" in a) {
      nomodule++;
      continue;
    }
    scripts.push(a.src);
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (!a.href) continue;
    const rel = (a.rel ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("modulepreload") || (rel.includes("preload") && (a.as ?? "").toLowerCase() === "script")) {
      preloads.push(a.href);
    }
  }
  return { scripts, preloads, nomodule };
}

function routeFile(route: string): string {
  const r = route.replace(/^\/+|\/+$/g, "");
  return r === "" ? "index.html" : `${r}.html`;
}

function findHtmlFile(route: string, distDir: string, htmlDir?: string): string | null {
  const cands: string[] = [];
  if (htmlDir) {
    const r = route.replace(/^\/+|\/+$/g, "");
    cands.push(join(htmlDir, routeFile(route)), join(htmlDir, r, "index.html"));
  } else {
    cands.push(join(distDir, "server", "app", routeFile(route)), join(distDir, "server", "pages", routeFile(route)));
  }
  return cands.find((c) => existsSync(c)) ?? null;
}

function staticRel(href: string): string | null {
  const i = href.indexOf("_next/static/");
  if (i < 0) return null;
  const rest = href.slice(i + "_next/".length).split(/[?#]/)[0]!;
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runValidate(opts: ValidateOptions): Promise<ValidationReport> {
  const tolerance = opts.tolerance ?? 0.15;
  const distDir = opts.distDir ? (opts.distDir.startsWith("/") ? opts.distDir : join(opts.projectRoot, opts.distDir)) : resolveDistDir(opts.projectRoot);
  const fetchFn = opts.fetchFn ?? fetch;
  const delayMs = opts.delayMs ?? 150;
  const base = opts.url?.replace(/\/+$/, "");
  const useUrl = !!base && !opts.htmlDir;
  const headers = { "User-Agent": "wimb-validate" };
  let first = true;

  const wait = async () => {
    if (!first && delayMs > 0) await sleep(delayMs);
    first = false;
  };
  const getBytes = async (u: string): Promise<Buffer | null> => {
    await wait();
    try {
      const res = await fetchFn(u, { headers });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  };

  const routes: ValidationRoute[] = [];
  for (const r of opts.report.routes) {
    const base0: ValidationRoute = {
      route: r.route,
      status: "no-html",
      graphFirstLoadBytes: r.firstLoadBytes,
      ...(r.preloadedBytes !== undefined ? { graphPreloadedBytes: r.preloadedBytes } : {}),
      htmlScriptRawBytes: 0,
      htmlScriptGzipBytes: 0,
      htmlPreloadGzipBytes: 0,
      scriptCount: 0,
      preloadCount: 0,
      diff: null,
      reasons: [],
      missing: [],
    };
    const noHtml = () => {
      base0.reasons.push("route not prerendered (dynamic/ISR on demand) or html not found");
      routes.push(base0);
    };

    let html: string | null = null;
    if (useUrl) {
      if (r.route.includes("[")) {
        noHtml();
        continue;
      }
      const buf = await getBytes(base + (r.route === "/" ? "/" : r.route));
      if (buf) {
        html = buf.toString("utf8");
        base0.source = "url";
        base0.htmlPath = base + r.route;
      }
    } else {
      const f = findHtmlFile(r.route, distDir, opts.htmlDir);
      if (f) {
        html = readFileSync(f, "utf8");
        base0.source = "file";
        base0.htmlPath = f;
      }
    }
    if (html === null) {
      noHtml();
      continue;
    }

    const parsed = parseHtmlAssets(html);
    const scriptSet = new Set(parsed.scripts);
    const preloadOnly = [...new Set(parsed.preloads)].filter((p) => !scriptSet.has(p));

    const load = async (href: string): Promise<Buffer | null> => {
      if (useUrl) {
        const abs = /^https?:\/\//.test(href) ? href : new URL(href, base + "/").toString();
        return getBytes(abs);
      }
      const rel = staticRel(href);
      if (!rel) return null;
      const p = join(distDir, rel);
      return existsSync(p) ? readFileSync(p) : null;
    };

    for (const href of [...new Set(parsed.scripts)]) {
      const buf = await load(href);
      if (!buf) {
        base0.missing.push(href);
        continue;
      }
      base0.htmlScriptRawBytes += buf.length;
      base0.htmlScriptGzipBytes += gzipSync(buf, { level: 9 }).length;
      base0.scriptCount++;
    }
    for (const href of preloadOnly) {
      const buf = await load(href);
      if (!buf) {
        base0.missing.push(href);
        continue;
      }
      base0.htmlPreloadGzipBytes += gzipSync(buf, { level: 9 }).length;
      base0.preloadCount++;
    }

    const g = r.firstLoadBytes;
    base0.diff = g > 0 ? (base0.htmlScriptGzipBytes - g) / g : null;
    base0.status = base0.diff !== null && Math.abs(base0.diff) > tolerance ? "flagged" : "ok";
    if (base0.status === "flagged") {
      if (base0.diff! > 0) base0.reasons.push("framework/runtime chunks (main, webpack, polyfills) not attributed to route modules");
      else
        base0.reasons.push(
          "graph counts chunks not referenced in HTML (dynamic chunks, or compression mismatch: graph uses measured compressed sizes, HTML sizes are gzip -9)",
        );
    }
    if (base0.preloadCount > 0) base0.reasons.push(`${base0.preloadCount} dynamic chunks preloaded in HTML (see preloadedBytes)`);
    if (base0.missing.length) base0.reasons.push(`${base0.missing.length} asset(s) could not be resolved: ${base0.missing.slice(0, 3).join(", ")}`);
    if (parsed.nomodule) base0.reasons.push("polyfills (nomodule) excluded");
    routes.push(base0);
  }
  return { tolerance, routes, flagged: routes.filter((x) => x.status === "flagged").length };
}

const kb = (n: number) => (n / 1024).toFixed(1);
const pct = (d: number | null) => (d === null ? "-" : `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}%`);

export function formatValidationMarkdown(v: ValidationReport): string[] {
  const lines = [
    "## Validation",
    "",
    `Graph first-load vs gzip -9 sizes of scripts in prerendered HTML (tolerance ${(v.tolerance * 100).toFixed(0)}%). ${v.flagged} flagged.`,
    "",
    "| Route | Graph KB | HTML gzip KB | HTML raw KB | Preload KB | Diff | Status |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const r of v.routes) {
    lines.push(
      `| \`${r.route}\` | ${kb(r.graphFirstLoadBytes)} | ${kb(r.htmlScriptGzipBytes)} | ${kb(r.htmlScriptRawBytes)} | ${kb(r.htmlPreloadGzipBytes)} | ${pct(r.diff)} | ${r.status} |`,
    );
  }
  const flagged = v.routes.filter((r) => r.status === "flagged");
  if (flagged.length) {
    lines.push("");
    for (const r of flagged) {
      lines.push(`- \`${r.route}\` (${pct(r.diff)}):`);
      for (const why of r.reasons) lines.push(`  - ${why}`);
    }
  }
  lines.push("");
  return lines;
}

export function formatValidationTerminal(v: ValidationReport): string {
  const out = [`validation: ${v.routes.length} routes, ${v.flagged} flagged (tolerance ${(v.tolerance * 100).toFixed(0)}%)`];
  for (const r of v.routes) {
    if (r.status === "no-html") out.push(`  ${r.route.padEnd(28)} no-html`);
    else out.push(`  ${r.route.padEnd(28)} graph ${kb(r.graphFirstLoadBytes)} KB  html ${kb(r.htmlScriptGzipBytes)} KB gz  ${pct(r.diff)}  ${r.status}`);
    if (r.status === "flagged") for (const why of r.reasons) out.push(`      - ${why}`);
  }
  return out.join("\n");
}

export function writeValidation(root: string, v: ValidationReport): string {
  const dir = join(root, ".wimb");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "validation.json");
  writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
  return p;
}

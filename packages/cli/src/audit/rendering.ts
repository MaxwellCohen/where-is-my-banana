import type { AuditContext, Finding, SourceFile } from "./types.js";
import { find, importsOf, isAppFile, isClient, isCode, isTestFile, lineAt, matches, resolveImport } from "./util.js";

const isRouteHandler = (p: string) => /(?:^|\/)route\.[cm]?[jt]s$/.test(p) || /(?:^|\/)api\//.test(p);
const isLayout = (p: string) => isAppFile(p, "layout") || isAppFile(p, "template");

export function forceDynamic(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  const note = " CMS-driven content pages should be static/ISR (generateStaticParams + `revalidate` or on-demand revalidateTag).";
  for (const f of ctx.files) {
    if (!isCode(f) || isRouteHandler(f.path) || !/(?:^|\/)(?:app|pages|src)\//.test(f.path)) continue;
    const layout = isLayout(f.path);
    const sev = layout ? "high" : "medium";
    const c = f.content;
    for (const { line } of matches(c, /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/)) {
      out.push(
        find("force-dynamic", {
          id: "force-dynamic/segment-config",
          severity: sev,
          file: f.path,
          line,
          message: `\`dynamic = "force-dynamic"\` opts ${layout ? "the whole subtree" : "this route"} out of static rendering and the full-route cache.`,
          fix: 'Remove it. If request data is truly needed, read it in a small component under <Suspense> instead.' + note,
        }),
      );
    }
    for (const { line } of matches(c, /export\s+const\s+revalidate\s*=\s*0\b/)) {
      out.push(
        find("force-dynamic", {
          id: "force-dynamic/revalidate-0",
          severity: sev,
          file: f.path,
          line,
          message: "`revalidate = 0` makes the route render on every request.",
          fix: "Use a positive revalidate (e.g. 60-3600) or on-demand revalidation (revalidateTag/Path from a CMS webhook)." + note,
        }),
      );
    }
    for (const { line } of matches(c, /cache\s*:\s*["']no-store["']|\b(?:unstable_)?noStore\s*\(\s*\)/)) {
      out.push(
        find("force-dynamic", {
          id: "force-dynamic/no-store",
          severity: sev,
          file: f.path,
          line,
          message: "`cache: \"no-store\"` / noStore() on a fetch makes the whole route dynamic.",
          fix: "Use `next: { revalidate: N, tags: [...] }` on the fetch and revalidate on CMS publish." + note,
        }),
      );
    }
    if (layout) {
      for (const { line } of matches(c, /\b(?:cookies|headers)\s*\(\s*\)|\bsearchParams\b/)) {
        out.push(
          find("force-dynamic", {
            id: "force-dynamic/layout-request-api",
            severity: "high",
            file: f.path,
            line,
            message: "cookies()/headers()/searchParams in a layout makes every route beneath it dynamic.",
            fix: "Move request-dependent reads into a leaf component wrapped in <Suspense>, or into middleware / client code, so the layout stays static.",
          }),
        );
      }
    }
  }
  return out;
}

const DYN_SEG = /\[\[?\.{0,3}[\w-]+\]?\]/;

export function missingStaticParams(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  const byPath = new Map(ctx.files.map((f) => [f.path, f]));
  for (const f of ctx.files) {
    if (!isCode(f) || !isAppFile(f.path, "page")) continue;
    const m = f.path.match(/(?:^|\/)app\/(.*)\/page\.[cm]?[jt]sx?$/);
    if (!m || !DYN_SEG.test(m[1])) continue;
    if (isClient(f.content) || /\bgenerateStaticParams\b/.test(f.content)) continue;
    // generateStaticParams may live on a layout between the first dynamic segment and the page
    const segs = m[1].split("/");
    const firstDyn = segs.findIndex((s) => DYN_SEG.test(s));
    const base = f.path.slice(0, f.path.indexOf("app/") + 4);
    let covered = false;
    for (let i = firstDyn; i < segs.length && !covered; i++) {
      const dir = base + segs.slice(0, i + 1).join("/") + "/";
      for (const ext of ["tsx", "ts", "jsx", "js"]) {
        if (byPath.get(dir + "layout." + ext)?.content.includes("generateStaticParams")) covered = true;
      }
    }
    if (covered) continue;
    const route = "/" + segs.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@")).join("/");
    const slugLike = /slug|path|uid|url|alias|\.\.\./i.test(segs[firstDyn]);
    out.push(
      find("missing-static-params", {
        severity: slugLike ? "high" : "medium",
        file: f.path,
        line: 1,
        message: `Dynamic route ${route} has no generateStaticParams; pages render on demand instead of being prebuilt/cached.`,
        fix: `Export \`generateStaticParams\` from this page returning the known slugs (e.g. fetch all location/service/page slugs from the CMS), and set \`revalidate\` for ISR. Keep \`dynamicParams = true\` for new pages.`,
      }),
    );
  }
  return out;
}

interface Stmt {
  line: number;
  indent: number;
  bound: string[];
  text: string;
}

const AWAIT_START = /^(\s*)(?:(?:const|let|var)\s+([\s\S]+?)\s*=\s*)?await\s+/;
const FETCHY = /\bfetch\w*\s*\(|\bget\w*\s*\(|\bload\w*\s*\(|\bquery\w*\s*\(|\bfind\w*\s*\(|\bread\w*\s*\(|\brequest\w*\s*\(|\bsearch\w*\s*\(|\blist\w*\s*\(|\.get\w*\(|client\.|cms|api/i;
const SIDE_EFFECT = /\.(?:post|put|patch|delete)\(|revalidate|redirect|notFound|mutate|create\w*\(|update\w*\(|save\w*\(|send\w*\(/i;

function parseStmts(content: string): Stmt[] {
  const lines = content.split("\n");
  const out: Stmt[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(AWAIT_START);
    if (!m) continue;
    let depth = 0;
    let text = "";
    let j = i;
    for (; j < lines.length; j++) {
      const l = lines[j].replace(/(^|\s)\/\/.*$/, "$1");
      text += l + "\n";
      for (const ch of l) {
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
      }
      if (depth <= 0 && !/[=,(+&|?:]\s*$/.test(l.trimEnd())) break;
    }
    const bound = m[2] ? (m[2].match(/[A-Za-z_$][\w$]*/g) ?? []) : [];
    out.push({ line: i + 1, indent: m[1].length, bound, text });
    i = Math.min(j, lines.length - 1);
    // record end for adjacency
    (out[out.length - 1] as Stmt & { end?: number }).end = j + 1;
  }
  return out;
}

export function sequentialAwait(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  for (const f of ctx.files) {
    if (!isCode(f) || isClient(f.content) || !/(?:^|\/)(?:app|pages|components)\//.test(f.path)) continue;
    if ((f.content.match(/\bawait\b/g) ?? []).length < 2) continue;
    const lines = f.content.split("\n");
    const stmts = parseStmts(f.content) as (Stmt & { end?: number })[];
    let run: (Stmt & { end?: number })[] = [];
    const flush = () => {
      if (run.length >= 2) {
        out.push(
          find("sequential-await", {
            severity: run.length >= 3 ? "high" : "medium",
            file: f.path,
            line: run[0].line,
            message: `${run.length} consecutive independent awaits run sequentially (request waterfall).`,
            fix: "Start them together: `const [a, b] = await Promise.all([fetchA(), fetchB()])`, or move the slower one into a child server component under <Suspense> so it streams.",
          }),
        );
      }
      run = [];
    };
    for (const s of stmts) {
      const prev = run[run.length - 1];
      const eligible = FETCHY.test(s.text) && !SIDE_EFFECT.test(s.text) && !/Promise\.all/.test(s.text);
      if (!eligible) {
        flush();
        continue;
      }
      if (prev) {
        const gap = lines.slice(prev.end!, s.line - 1).filter((l) => l.trim() && !/^\s*(?:\/\/|\/\*|\*)/.test(l));
        const dependent = run.some((r) => r.bound.some((b) => new RegExp(`(?<![\\w$.])${b.replace(/\$/g, "\\$")}(?![\\w$])`).test(s.text)));
        if (gap.length || s.indent !== prev.indent || dependent) flush();
      }
      run.push(s);
    }
    flush();
  }
  return out;
}

const CMS_SPEC = /contentful|sanity|storyblok|@builder\.io|sitecore|prismic|graphql-request|@apollo\/client|(?:^|\/)(?:lib|utils|services?)\/(?:cms|api)|\/cms(?:\/|$)/i;

export function fullCmsPayloadToClient(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  const byPath = new Map(ctx.files.map((f) => [f.path, f]));
  for (const f of ctx.files) {
    if (!isCode(f) || !/\.[jt]sx$/.test(f.path) || isClient(f.content)) continue;
    const imps = importsOf(f.content);
    const cmsFile = imps.some((i) => CMS_SPEC.test(i.spec));
    // local name -> client file
    const clientComps = new Map<string, SourceFile>();
    for (const i of imps) {
      const target = resolveImport(f.path, i.spec, byPath);
      if (!target || !isClient(target.content)) continue;
      const names = i.clause.match(/[A-Za-z_$][\w$]*/g) ?? [];
      for (const n of names) if (/^[A-Z]/.test(n)) clientComps.set(n, target);
    }
    if (clientComps.size === 0) continue;
    const payload = new Set<string>();
    for (const { m } of matches(f.content, /(?:const|let)\s+(?:(\w+)|\{([^}]*)\})\s*=\s*await\s+([^\n;]*)/)) {
      if (!cmsFile && !/cms|contentful|sanity|storyblok|builder|sitecore|prismic|getPage|fetch/i.test(m[3])) continue;
      if (m[1]) payload.add(m[1]);
    }
    if (payload.size === 0) continue;
    for (const { m, line } of matches(f.content, /<([A-Z][\w]*)\b((?:[^>]|=>)*)>/)) {
      const target = clientComps.get(m[1]);
      if (!target) continue;
      for (const v of payload) {
        const re = new RegExp(`\\{\\s*\\.\\.\\.${v}\\s*\\}|\\b(?:data|page|content|entry|fields|item|items|response|res|payload|cms\\w*|props)\\s*=\\s*\\{\\s*${v}\\s*\\}`);
        if (!re.test(m[2])) continue;
        out.push(
          find("full-cms-payload-to-client", {
            severity: "medium",
            file: f.path,
            line,
            message: `Whole CMS response \`${v}\` is passed to client component <${m[1]}> (${target.path}); it is serialized into the HTML/RSC payload (__next_f).`,
            fix: `Pick only the fields <${m[1]}> renders (e.g. title, href, image{url,alt}) and pass those as props, or keep the data fetch in a server component and pass server-rendered children.`,
          }),
        );
        break;
      }
    }
  }
  return out;
}

export function middlewareScope(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  for (const f of ctx.files) {
    if (!/^(?:src\/)?(?:middleware|proxy)\.[cm]?[jt]s$/.test(f.path) && !/(?:^|\/)(?:src\/)?middleware\.[cm]?[jt]s$/.test(f.path)) continue;
    if (isTestFile(f.path)) continue;
    const c = f.content;
    const cfg = c.search(/export\s+const\s+config\b/);
    const matcher = cfg >= 0 ? c.slice(cfg).match(/matcher\s*:\s*(\[[\s\S]*?\]|["'`][^"'`]*["'`])/) : null;
    if (!matcher) {
      out.push(
        find("middleware-scope", {
          severity: "high",
          file: f.path,
          line: cfg >= 0 ? lineAt(c, cfg) : 1,
          message: "Middleware has no `config.matcher`; it runs on every request including _next/static, images and prefetches.",
          fix: 'Export `config = { matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|css|js)$).*)"] }` or list only the paths that need it.',
        }),
      );
      continue;
    }
    const mt = matcher[1];
    const line = lineAt(c, cfg);
    const catchAll = /["'`]\/?(?::\w+\*|\(\.\*\)|\(\(\?!)/.test(mt) || /["'`]\/\(\(\?!/.test(mt) || /["'`]\/?\(\?!/.test(mt) || /["'`]\/:path\*["'`]/.test(mt);
    if (!catchAll) continue;
    if (!/_next\/static|_next/.test(mt)) {
      out.push(
        find("middleware-scope", {
          severity: "medium",
          file: f.path,
          line,
          message: "Catch-all middleware matcher does not exclude _next/static.",
          fix: "Add a negative lookahead: `/((?!_next/static|_next/image|favicon.ico).*)`.",
        }),
      );
    } else if (!/_next\/image|\\\.\(?(?:\?:)?[a-z|]*(?:png|jpe?g|svg|webp)/i.test(mt)) {
      out.push(
        find("middleware-scope", {
          severity: "low",
          file: f.path,
          line,
          message: "Middleware matcher excludes _next/static but not _next/image or static image files.",
          fix: "Also exclude `_next/image` and image extensions (svg|png|jpg|jpeg|gif|webp|avif).",
        }),
      );
    }
  }
  return out;
}

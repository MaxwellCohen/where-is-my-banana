import type { AuditContext, Finding, Severity } from "./types.js";
import { find, importsOf, isClient, isCode, lineAt, matches } from "./util.js";

export interface Heavy {
  re: RegExp;
  severity: Severity;
  message: string;
  fix: string;
}

export const HEAVY: Heavy[] = [
  { re: /^moment(?:-timezone)?$/, severity: "high", message: "moment is ~70 KB+ (timezone data adds more) and not tree-shakeable.", fix: "Replace with date-fns (per-function imports), dayjs, or native Intl.DateTimeFormat." },
  { re: /^lodash$/, severity: "medium", message: "`lodash` (CJS) pulls the whole library unless imported per method.", fix: "Switch to `lodash-es` with named imports, or native array/object methods." },
  { re: /^(?:core-js|regenerator-runtime)$/, severity: "medium", message: "Polyfills for browsers Next.js no longer supports.", fix: "Remove the dependency/imports; Next already ships required polyfills. Use modern browserslist targets." },
  { re: /^(?:axios|request|node-fetch|isomorphic-fetch|whatwg-fetch|cross-fetch)$/, severity: "low", message: "HTTP client duplicates native fetch (and bypasses Next's fetch cache/revalidate).", fix: "Use native `fetch` with `next: { revalidate, tags }`." },
  { re: /^jquery$/, severity: "high", message: "jQuery is ~30 KB gz and rarely needed in React.", fix: "Remove; use React state/refs and native DOM APIs." },
  { re: /^rxjs$/, severity: "low", message: "rxjs is large if imported broadly on the client.", fix: "Import operators from `rxjs/operators` only where needed, or replace with async/await." },
  { re: /^@mui\/icons-material$/, severity: "high", message: "@mui/icons-material has thousands of icons; barrel imports are very expensive.", fix: "Import by path (`@mui/icons-material/Search`) or replace with lucide-react/inline SVG." },
  { re: /^react-icons$/, severity: "medium", message: "react-icons barrel imports can pull large icon sets.", fix: "Import from sub-paths (`react-icons/fa6`) and add to `experimental.optimizePackageImports`, or inline SVGs." },
  { re: /^@fortawesome\//, severity: "medium", message: "FontAwesome icon packs are large and often import-all.", fix: "Import individual icons only, or replace with inline SVG icons." },
  { re: /^(?:draft-js|react-draft-wysiwyg)$/, severity: "high", message: "Draft.js editor is heavy and unmaintained.", fix: "Replace with Tiptap/Lexical loaded lazily, or render CMS rich text on the server." },
  { re: /^(?:styled-components|@emotion\/(?:react|styled))$/, severity: "medium", message: "Runtime CSS-in-JS needs client JS and slows hydration.", fix: "Move to CSS modules/Tailwind/vanilla-extract (build-time CSS)." },
  { re: /^(?:framer-motion|motion)$/, severity: "medium", message: "framer-motion adds ~30-50 KB gz to every route that imports it.", fix: "Use `LazyMotion` + `m` components with domAnimation, CSS transitions, or lazy-load animated sections." },
  { re: /^gsap$/, severity: "medium", message: "gsap is ~25 KB+ gz plus plugins.", fix: "Dynamic-import gsap inside effects only on routes that animate; prefer CSS animations." },
  { re: /^(?:yup|joi)$/, severity: "low", message: "Validation library may be shipped to the client.", fix: "Keep validation server-side or use a lighter schema lib (valibot) if forms need it client-side." },
];

const CMS_SDK = /^(?:contentful(?:-management)?|@sanity\/client|groq|next-sanity|storyblok-js-client|@storyblok\/[\w-]+|@builder\.io\/(?:sdk[\w-]*|react|sdk-react[\w-]*)|@sitecore-jss\/[\w-]+|@optimizely\/[\w-]+|@prismicio\/client)$/;

const DATE_LIBS = ["moment", "moment-timezone", "dayjs", "date-fns", "luxon", "js-joda"];
const ICON_LIBS = ["react-icons", "@mui/icons-material", "lucide-react", "@heroicons/react", "@tabler/icons-react", "phosphor-react", "@phosphor-icons/react", "@fortawesome/react-fontawesome"];

export function heavyDeps(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  const fileByPath = new Map(ctx.files.map((f) => [f.path, f]));
  const depLine = (pkgPath: string, name: string) => {
    const c = fileByPath.get(pkgPath)?.content;
    if (!c) return 1;
    const i = c.indexOf(`"${name}"`);
    return i >= 0 ? lineAt(c, i) : 1;
  };
  const usesFetch = ctx.files.some((f) => isCode(f) && /\bfetch\s*\(/.test(f.content));
  for (const pkg of ctx.packages) {
    const deps = { ...pkg.json.dependencies, ...pkg.json.optionalDependencies } as Record<string, string>;
    const names = Object.keys(deps);
    for (const n of names) {
      const h = HEAVY.find((x) => x.re.test(n));
      if (h) {
        let { severity, fix } = h;
        if (n === "axios" && usesFetch) fix = "Code already uses fetch elsewhere; remove axios and use native fetch with `next: { revalidate, tags }`.";
        out.push(find("heavy-deps", { id: "heavy-deps/" + n, severity, file: pkg.path, line: depLine(pkg.path, n), message: `\`${n}\`: ${h.message}`, fix }));
      }
      if (CMS_SDK.test(n)) {
        const pkgDir = pkg.path.replace(/package\.json$/, "");
        const clientUses = ctx.files.filter(
          (f) => isCode(f) && f.path.startsWith(pkgDir) && isClient(f.content) && importsOf(f.content).some((i) => i.spec === n || i.spec.startsWith(n + "/")),
        );
        if (clientUses.length) {
          for (const f of clientUses) {
            const imp = importsOf(f.content).find((i) => i.spec === n || i.spec.startsWith(n + "/"))!;
            out.push(find("heavy-deps", { id: "heavy-deps/cms-sdk-client", severity: "high", file: f.path, line: imp.line, message: `CMS SDK \`${n}\` is imported by a "use client" file and ships to browsers.`, fix: "Fetch in a server component/route handler and pass only needed fields to the client; keep the SDK server-only (add `import \"server-only\"` to your CMS client module)." }));
          }
        } else {
          out.push(find("heavy-deps", { id: "heavy-deps/cms-sdk", severity: "low", file: pkg.path, line: depLine(pkg.path, n), message: `CMS SDK \`${n}\` must stay server-only; full SDKs are 50-300 KB.`, fix: 'Ensure it is imported only from server code; add `import "server-only"` in the module that creates the client.' }));
        }
      }
    }
    if (names.includes("swr") && names.includes("@tanstack/react-query")) {
      out.push(find("heavy-deps", { id: "heavy-deps/duplicate-fetching", severity: "medium", file: pkg.path, line: depLine(pkg.path, "swr"), message: "Both swr and @tanstack/react-query are installed (two client data-fetching libs).", fix: "Standardize on one (or drop both and fetch in server components)." }));
    }
    const dates = names.filter((n) => DATE_LIBS.includes(n));
    if (new Set(dates.map((d) => (d === "moment-timezone" ? "moment" : d))).size >= 2) {
      out.push(find("heavy-deps", { id: "heavy-deps/duplicate-date", severity: "medium", file: pkg.path, line: depLine(pkg.path, dates[0]), message: `Multiple date libraries: ${dates.join(", ")}.`, fix: "Keep one (date-fns or dayjs) and migrate the rest." }));
    }
    const icons = names.filter((n) => ICON_LIBS.includes(n));
    if (icons.length >= 2) {
      out.push(find("heavy-deps", { id: "heavy-deps/duplicate-icons", severity: "medium", file: pkg.path, line: depLine(pkg.path, icons[0]), message: `Multiple icon libraries: ${icons.join(", ")}.`, fix: "Consolidate on one icon set (or inline SVGs)." }));
    }
  }
  return out;
}

const OLD_TARGET = [
  { re: /\bie\s*(?:<=?\s*)?(?:\d+|all)/i, label: "IE" },
  { re: /(?:^|[\s"',])>=?\s*0(?:\.0+)?\s*%/, label: "> 0%" },
  { re: /\bandroid\s*(?:<=?\s*)?[2-4](?:\.\d)?\b/i, label: "old Android" },
  { re: /\blast\s+(?:[5-9]|\d{2,})\s+(?:\w+\s+)?versions?/i, label: "last N>=5 versions" },
  { re: /\bop_mini\b|\bbb\s*\d|\bsafari\s*(?:<=?\s*)?(?:[1-9]|1[01])\b/i, label: "legacy browsers" },
];

export function oldBrowserslist(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  const byPath = new Map(ctx.files.map((f) => [f.path, f]));
  for (const pkg of ctx.packages) {
    const dir = pkg.path.replace(/package\.json$/, "");
    const rc = byPath.get(dir + ".browserslistrc") ?? byPath.get(dir + "browserslist");
    const field = pkg.json.browserslist;
    if (!field && !rc) {
      continue;
    }
    const text = rc ? rc.content : JSON.stringify(field);
    const hit = OLD_TARGET.find((t) => t.re.test(text.replace(/^\s*#.*$/gm, "")));
    if (hit) {
      const src = rc ? rc.path : pkg.path;
      const content = byPath.get(src)?.content ?? "";
      const idx = rc ? 0 : content.indexOf('"browserslist"');
      out.push(find("old-browserslist", { id: "old-browserslist/legacy-target", severity: hit.label === "IE" || hit.label === "> 0%" ? "high" : "medium", file: src, line: Math.max(1, lineAt(content, Math.max(idx, 0))), message: `browserslist includes legacy targets (${hit.label}); builds ship extra transpilation and polyfills.`, fix: "Replace with modern targets, e.g. `chrome >= 100, edge >= 100, firefox >= 100, safari >= 15.4`, or `defaults and fully supports es6-module`." }));
    }
  }
  for (const f of ctx.files) {
    if (!isCode(f)) continue;
    for (const { m, line } of matches(f.content, /(?:import\s+|from\s*|require\(\s*)["'](core-js(?:\/[^"']*)?|regenerator-runtime(?:\/[^"']*)?)["']/)) {
      out.push(find("old-browserslist", { id: "old-browserslist/core-js-import", severity: "medium", file: f.path, line, message: `Explicit \`${m[1]}\` import ships polyfills for features modern browsers already have.`, fix: "Remove the import; Next.js includes the polyfills it needs. Drop the dependency if nothing else uses it." }));
    }
  }
  return out;
}

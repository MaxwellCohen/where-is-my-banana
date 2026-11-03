import type { AuditContext, Finding } from "./types.js";
import { find, isCode, isLayoutLike, isRootLayout, importsOf, lineAt, matches } from "./util.js";

export function fonts(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  for (const f of ctx.files) {
    const isStyle = /\.(?:css|scss)$/.test(f.path);
    if (!isCode(f) && !isStyle) continue;
    const c = f.content;
    for (const { line } of matches(c, /<link\b[^>]*fonts\.googleapis\.com|@import\s+(?:url\()?["']?[^;\n]*fonts\.googleapis\.com/)) {
      out.push(
        find("fonts", {
          id: "fonts/google-link",
          severity: isLayoutLike(f.path) || isStyle ? "high" : "medium",
          file: f.path,
          line,
          message: "Google Fonts loaded via <link>/@import: render-blocking third-party request, no self-hosting.",
          fix: 'Use `next/font/google` (self-hosted, zero layout shift): `const inter = Inter({ subsets: ["latin"], display: "swap" })` and apply `inter.className`; remove the <link>/@import.',
        }),
      );
    }
    if (!isCode(f)) continue;
    const usesNextFont = importsOf(c).some((i) => /^next\/font\/(?:google|local)$/.test(i.spec));
    if (!usesNextFont) continue;
    for (const { m, line } of matches(c, /=\s*([A-Z][\w]*)\(\s*\{([\s\S]*?)\}\s*\)\s*;?/)) {
      const body = m[2];
      const isLocal = /\bsrc\s*:/.test(body);
      if (!isLocal && !/\b(?:subsets|weight)\s*:/.test(body)) continue;
      let count = 0;
      if (isLocal) count = (body.match(/\bpath\s*:/g) ?? []).length || (/\bsrc\s*:\s*["']/.test(body) ? 1 : 0);
      else {
        const w = body.match(/\bweight\s*:\s*\[([^\]]*)\]/);
        if (w) count = w[1].split(",").filter((s) => s.trim()).length;
        const st = body.match(/\bstyle\s*:\s*\[([^\]]*)\]/);
        if (st) count *= Math.max(1, st[1].split(",").filter((s) => s.trim()).length);
      }
      if (count > 4) {
        out.push(
          find("fonts", {
            id: "fonts/too-many-files",
            severity: "medium",
            file: f.path,
            line,
            message: `${m[1]} loads ${count} font files/weights; each is a separate request and preload candidate.`,
            fix: "Cut to <=4 files: use a variable font (omit `weight` or use \"variable\") or drop unused weights/styles.",
          }),
        );
      }
      const disp = body.match(/\bdisplay\s*:\s*["'](\w+)["']/);
      if (disp && disp[1] !== "swap" && disp[1] !== "optional") {
        out.push(
          find("fonts", {
            id: "fonts/display",
            severity: "medium",
            file: f.path,
            line,
            message: `font \`display: "${disp[1]}"\` can block text rendering (invisible text) until the font loads.`,
            fix: 'Use `display: "swap"` (next/font default) or "optional".',
          }),
        );
      }
    }
  }
  return out;
}

export function cssWeight(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  for (const f of ctx.files) {
    if (/\.(?:css|scss)$/.test(f.path) && f.content.length > 200_000) {
      out.push(
        find("css-weight", {
          id: "css-weight/large-css",
          severity: "medium",
          file: f.path,
          line: 1,
          message: `Stylesheet is ${(f.content.length / 1024).toFixed(0)} KB of source; render-blocking CSS delays first paint.`,
          fix: "Split per-route (CSS modules / component-scoped styles), purge unused rules, and avoid importing entire UI-kit stylesheets globally.",
        }),
      );
    }
    if (/(?:^|\/)tailwind\.config\.[cm]?[jt]s$/.test(f.path) && !/\bcontent\s*:|\bpresets\s*:/.test(f.content)) {
      out.push(
        find("css-weight", {
          id: "css-weight/tailwind-content",
          severity: "high",
          file: f.path,
          line: 1,
          message: "Tailwind config has no `content` globs; unused utilities are not purged.",
          fix: 'Add `content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"]` covering all files that use class names.',
        }),
      );
    }
    if (!isCode(f) || !isLayoutLike(f.path)) continue;
    const cssImports = importsOf(f.content).filter((i) => /\.(?:css|scss|sass)$/.test(i.spec));
    if (cssImports.length >= 4) {
      out.push(
        find("css-weight", {
          id: "css-weight/layout-css-imports",
          severity: cssImports.length >= 8 ? "high" : "medium",
          file: f.path,
          line: cssImports[0].line,
          message: `Layout imports ${cssImports.length} global stylesheets; all ship render-blocking on every route.`,
          fix: "Merge into one globals.css, and move route-/component-specific styles to CSS modules imported next to the component that uses them.",
        }),
      );
    }
    if (isRootLayout(f.path)) {
      const cij = importsOf(f.content).find((i) => /^(?:styled-components|@emotion\/(?:react|styled))/.test(i.spec));
      if (cij) {
        out.push(
          find("css-weight", {
            id: "css-weight/css-in-js-layout",
            severity: "high",
            file: f.path,
            line: cij.line,
            message: "Runtime CSS-in-JS imported in the root layout: forces client JS and style recalculation on every route.",
            fix: "Replace with CSS modules/Tailwind/vanilla-extract (build-time CSS), at least for shared layout components.",
          }),
        );
      }
    }
  }
  return out;
}

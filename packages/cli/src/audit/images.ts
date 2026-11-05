import type { AuditContext, Finding } from "./types.js";
import { find, isCode, JSX_RE, lineAt, matches } from "./util.js";

const IMPORTS_NEXT_IMAGE = /from\s*["']next\/image["']|require\(\s*["']next\/image["']/;

export function rawImg(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  for (const f of ctx.files) {
    if (!isCode(f) || !JSX_RE.test(f.path)) continue;
    if (IMPORTS_NEXT_IMAGE.test(f.content) || /\bImageResponse\b/.test(f.content)) continue;
    for (const { line } of matches(f.content, /<img[\s/>]/)) {
      out.push(
        find("raw-img", {
          severity: "medium",
          file: f.path,
          line,
          message: "Raw <img> bypasses next/image optimization (no resizing, AVIF/WebP, lazy-loading or size reservation).",
          fix: 'Replace with `import Image from "next/image"` and <Image src alt width height sizes="..." />. Use `fill` + a sized parent when dimensions are unknown.',
        }),
      );
    }
  }
  return out;
}

export function lcpPriority(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  for (const f of ctx.files) {
    if (!isCode(f) || !JSX_RE.test(f.path)) continue;
    const base = f.path.split("/").pop() ?? "";
    if (!/hero|banner|masthead/i.test(base)) continue;
    if (!IMPORTS_NEXT_IMAGE.test(f.content)) continue;
    const tags = [...matches(f.content, /<Image\b(?:[^>]|=>)*>/)];
    if (tags.length === 0) continue;
    const ok = tags.some(({ m }) => /\bpriority\b|fetchPriority\s*=\s*["']high|loading\s*=\s*["']eager/.test(m[0]));
    if (ok) continue;
    out.push(
      find("lcp-priority", {
        severity: "high",
        file: f.path,
        line: tags[0].line,
        message: "Hero/banner image uses next/image without `priority`; it is lazy-loaded and will delay LCP.",
        fix: "Add `priority` (or fetchPriority=\"high\") and an accurate `sizes` to the above-the-fold <Image>. Only do this for the one LCP image per page.",
      }),
    );
  }
  return out;
}

const NEXT_CONFIG_RE = /(?:^|\/)next\.config\.[cm]?[jt]s$/;

export function imageConfig(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  const usesNextImage = ctx.files.some((f) => isCode(f) && IMPORTS_NEXT_IMAGE.test(f.content));
  const hasRemoteImages = ctx.files.some(
    (f) => isCode(f) && !NEXT_CONFIG_RE.test(f.path) && (CMS_HOSTS.some((h) => h.re.test(f.content)) || /\bsrc\s*=\s*\{?\s*["'`]https?:\/\//.test(f.content)),
  );
  for (const f of ctx.files) {
    if (!NEXT_CONFIG_RE.test(f.path)) continue;
    const c = f.content;
    const imagesIdx = c.search(/\bimages\s*:/);
    const unopt = c.match(/\bunoptimized\s*:\s*true/);
    if (unopt) {
      out.push(
        find("image-config", {
          id: "image-config/unoptimized",
          severity: "high",
          file: f.path,
          line: lineAt(c, unopt.index!),
          message: "`images.unoptimized: true` disables all next/image optimization.",
          fix: "Remove `unoptimized: true`. If it was added for static export, use a custom `images.loader` (CDN/Cloudinary/imgix) instead.",
        }),
      );
    }
    const line = imagesIdx >= 0 ? lineAt(c, imagesIdx) : 1;
    if (usesNextImage && !/formats\s*:\s*\[[^\]]*(?:avif|webp)/.test(c)) {
      out.push(
        find("image-config", {
          id: "image-config/formats",
          severity: "medium",
          file: f.path,
          line,
          message: "`images.formats` not set; AVIF is not served (Next only serves WebP by default).",
          fix: "Set `images: { formats: [\"image/avif\", \"image/webp\"] }` in next.config.",
        }),
      );
    }
    if (hasRemoteImages && !/remotePatterns\s*:|\bloader\s*:|loaderFile/.test(c)) {
      out.push(
        find("image-config", {
          id: "image-config/remote-patterns",
          severity: "low",
          file: f.path,
          line,
          message: "`images.remotePatterns` not configured; remote (CMS/CDN) images cannot use next/image optimization.",
          fix: "Add `images.remotePatterns` for each CMS/CDN host (e.g. images.ctfassets.net) so remote images can go through <Image>.",
        }),
      );
    }
  }
  return out;
}

const CMS_HOSTS: { re: RegExp; ok: RegExp; name: string }[] = [
  { name: "Contentful", re: /images\.ctfassets\.net/, ok: /[?&](?:w|h|fm|q|fl)=|\$\{/ },
  { name: "Cloudinary", re: /res\.cloudinary\.com/, ok: /f_auto|q_auto|[,/]w_\d+|\$\{/ },
  { name: "Sanity", re: /cdn\.sanity\.io\/images/, ok: /[?&](?:w|h|fm|auto)=|\$\{/ },
  { name: "Builder.io", re: /cdn\.builder\.io\/api\/v1\/image/, ok: /[?&](?:width|format)=|\$\{/ },
  { name: "imgix", re: /[\w-]+\.imgix\.net/, ok: /[?&](?:w|fm|auto)=|\$\{/ },
];

export function cmsImageParams(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  for (const f of ctx.files) {
    if (!isCode(f) || NEXT_CONFIG_RE.test(f.path)) continue;
    for (const { m, line } of matches(f.content, /(?:https?:)?\/\/[^\s"'`)<>]+/)) {
      const url = m[0];
      for (const h of CMS_HOSTS) {
        if (!h.re.test(url) || h.ok.test(url)) continue;
        out.push(
          find("cms-image-params", {
            severity: "medium",
            file: f.path,
            line,
            message: `${h.name} image URL has no width/format/quality params; the original (often multi-MB) asset is served.`,
            fix: `Add sizing params (width, fm=webp/f_auto, q=75) to the ${h.name} URL, or route it through next/image with a custom \`loader\` that appends them.`,
          }),
        );
      }
    }
  }
  return out;
}

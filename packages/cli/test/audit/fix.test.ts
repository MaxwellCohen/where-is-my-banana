import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFindings } from "../../src/audit/index.js";
import { applyFixes, unifiedDiff } from "../../src/audit/fix.js";

function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "wimb-fix-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}
/** Fix once, then verify a second run changes nothing. */
function fix(files: Record<string, string>, opts: { force?: boolean } = {}) {
  const root = project(files);
  const first = applyFixes(root, collectFindings({ projectRoot: root }).findings, opts);
  const snapshot = Object.fromEntries(Object.keys(files).map((p) => [p, readFileSync(join(root, p), "utf-8")]));
  const second = applyFixes(root, collectFindings({ projectRoot: root }).findings, opts);
  const after = Object.fromEntries(Object.keys(files).map((p) => [p, readFileSync(join(root, p), "utf-8")]));
  expect(second.changes).toEqual([]);
  expect(after).toEqual(snapshot);
  return { root, first, out: snapshot };
}

describe("fix: script strategy", () => {
  const src = (tags: string) => `import Script from "next/script";\nexport default () => (<>${tags}</>);\n`;
  it("adds lazyOnload to analytics lacking strategy and replaces beforeInteractive", () => {
    const { out } = fix({
      "app/layout.tsx": src(
        `<Script src="https://www.googletagmanager.com/gtm.js?id=X" />\n<Script src="https://widget.intercom.io/w" strategy="beforeInteractive" />\n<Script src={\`https://www.googletagmanager.com/gtag/js\`} strategy={'beforeInteractive'} />`,
      ),
    });
    expect(out["app/layout.tsx"]).toContain('<Script strategy="lazyOnload" src="https://www.googletagmanager.com/gtm.js?id=X" />');
    expect(out["app/layout.tsx"]).toContain('src="https://widget.intercom.io/w" strategy="lazyOnload"');
    expect(out["app/layout.tsx"]).toContain("strategy={'lazyOnload'}");
    expect(out["app/layout.tsx"]).not.toContain("beforeInteractive");
  });
  it("leaves consent managers alone but reports them", () => {
    const code = src(`<Script src="https://cdn.cookielaw.org/otSDKStub.js" strategy="beforeInteractive" />`);
    const { out, first } = fix({ "app/layout.tsx": code });
    expect(out["app/layout.tsx"]).toBe(code);
    expect(first.skipped[0].reason).toMatch(/consent/);
  });
  it("skips dynamic strategy and prop spreads", () => {
    const code = src(`<Script src="https://www.googletagmanager.com/gtm.js" strategy={s} />\n<Script {...p} src="https://www.googletagmanager.com/gtm.js" />`);
    expect(fix({ "app/layout.tsx": code }).out["app/layout.tsx"]).toBe(code);
  });
});

describe("fix: font display", () => {
  it("swaps explicit non-swap display only", () => {
    const { out } = fix({
      "app/fonts.ts": `import { Inter, Lora } from "next/font/google";\nexport const a = Inter({ subsets: ["latin"], display: 'block' });\nexport const b = Lora({ subsets: ["latin"], display: "optional" });\n`,
    });
    expect(out["app/fonts.ts"]).toContain("display: 'swap'");
    expect(out["app/fonts.ts"]).toContain('display: "optional"');
  });
});

describe("fix: ssr:false", () => {
  const reg = (opts: string) => `import dynamic from "next/dynamic";\nexport const X = dynamic(() => import("./X")${opts});\n`;
  it.each([
    [`, { ssr: false }`, `dynamic(() => import("./X"))`],
    [`, { loading: () => null, ssr: false }`, `{ loading: () => null }`],
    [`, { ssr: false, loading: () => null }`, `{ loading: () => null }`],
    [`, {\n  loading: () => null,\n  ssr: false,\n}`, `loading: () => null,\n}`],
  ])("removes from %j", (opts, expected) => {
    const { out } = fix({ "components/blocks/registry.tsx": reg(opts) });
    expect(out["components/blocks/registry.tsx"]).not.toContain("ssr");
    expect(out["components/blocks/registry.tsx"]).toContain(expected.replace(/\n/g, "\n"));
    expect(out["components/blocks/registry.tsx"]).toContain("dynamic(");
  });
  it("leaves legitimate leaf ssr:false alone", () => {
    const code = reg(`, { ssr: false }`).replace("X", "Chart");
    expect(fix({ "components/chart/Loader.tsx": code }).out["components/chart/Loader.tsx"]).toBe(code);
  });
});

describe("fix: images.formats", () => {
  const usesImage = { "app/a.tsx": `import Image from "next/image";\nexport const A = () => <Image src="/a.png" alt="" width={1} height={1} />;\n` };
  it("adds images block to a plain config", () => {
    const { out } = fix({ ...usesImage, "next.config.js": `const nextConfig = {\n  reactStrictMode: true,\n};\nmodule.exports = nextConfig;\n` });
    expect(out["next.config.js"]).toContain('images: { formats: ["image/avif", "image/webp"] },');
    expect(out["next.config.js"]).toMatch(/\{\n  images:/);
  });
  it("adds formats inside an existing images object", () => {
    const { out } = fix({ ...usesImage, "next.config.js": `module.exports = {\n  images: {\n    remotePatterns: [],\n  },\n};\n` });
    expect(out["next.config.js"]).toContain('images: {\n    formats: ["image/avif", "image/webp"],\n    remotePatterns');
  });
  it("skips wrapped configs", () => {
    const code = `module.exports = withBundleAnalyzer({\n  reactStrictMode: true,\n});\n`;
    const { out, first } = fix({ ...usesImage, "next.config.js": code });
    expect(out["next.config.js"]).toBe(code);
    expect(first.skipped.length).toBeGreaterThan(0);
  });
});

describe("fix: hero priority", () => {
  const hero = (body: string) => `import Image from "next/image";\nexport default function Hero() { return ${body}; }\n`;
  it("adds priority to a hero Image", () => {
    const { out } = fix({ "components/Hero.tsx": hero(`<Image src="/h.png" alt="" width={1} height={1} />`) });
    expect(out["components/Hero.tsx"]).toContain("<Image priority src=");
  });
  it("skips carousels and lazy-loaded heroes", () => {
    const a = hero(`<div>{xs.map((x) => <Image key={x} src={x} alt="" width={1} height={1} />)}</div>`);
    const b = hero(`<Image src="/h.png" alt="" width={1} height={1} loading="lazy" />`);
    expect(fix({ "components/Hero.tsx": a }).out["components/Hero.tsx"]).toBe(a);
    expect(fix({ "components/HeroB.tsx": b }).out["components/HeroB.tsx"]).toBe(b);
  });
});

describe("fix: raw img", () => {
  it("adds lazy+async, only the missing attributes", () => {
    const { out } = fix({
      "components/Gallery.tsx": `export const G = () => (<><img src="a" /><img src="b" decoding="sync" /><img src="c" loading="lazy" /></>);\n`,
    });
    expect(out["components/Gallery.tsx"]).toContain('<img loading="lazy" decoding="async" src="a" />');
    expect(out["components/Gallery.tsx"]).toContain('<img loading="lazy" src="b" decoding="sync" />');
    expect(out["components/Gallery.tsx"]).toContain('<img decoding="async" src="c" loading="lazy" />');
  });
  it("leaves hero/header/logo images alone", () => {
    const a = `export const A = () => <img src="a" />;\n`;
    const b = `export const B = () => <img src="/logo.svg" />;\n`;
    expect(fix({ "components/Hero.tsx": a }).out["components/Hero.tsx"]).toBe(a);
    expect(fix({ "components/Footer.tsx": b }).out["components/Footer.tsx"]).toBe(b);
  });
});

describe("fix: safety", () => {
  it("never touches files with unstaged git changes unless forced", () => {
    const files = { "components/G.tsx": `export const G = () => <img src="a" />;\n` };
    const root = project(files);
    const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.email=a@b", "-c", "user.name=a", "add", ".");
    git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init");
    writeFileSync(join(root, "components/G.tsx"), `export const G = () => <img src="a" />; // wip\n`);
    const r = applyFixes(root, collectFindings({ projectRoot: root }).findings);
    expect(r.changes).toEqual([]);
    expect(r.skipped.some((s) => /unstaged/.test(s.reason))).toBe(true);
    expect(readFileSync(join(root, "components/G.tsx"), "utf-8")).not.toContain("lazy");
    const forced = applyFixes(root, collectFindings({ projectRoot: root }).findings, { force: true });
    expect(forced.changes).toHaveLength(1);
    expect(readFileSync(join(root, "components/G.tsx"), "utf-8")).toContain('loading="lazy"');
  });
  it("dry run writes nothing and returns a unified diff", () => {
    const root = project({ "components/G.tsx": `export const G = () => <img src="a" />;\n` });
    const r = applyFixes(root, collectFindings({ projectRoot: root }).findings, { dryRun: true });
    expect(readFileSync(join(root, "components/G.tsx"), "utf-8")).not.toContain("lazy");
    expect(r.diff).toContain("--- a/components/G.tsx");
    expect(r.diff).toContain('+export const G = () => <img loading="lazy" decoding="async" src="a" />;');
    expect(r.diff).toContain("-export const G = () => <img src=\"a\" />;");
  });
});

describe("unifiedDiff", () => {
  it("emits hunks with context and correct ranges", () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
    const b = a.replace("l2\n", "L2\n").replace("l18\n", "L18\nextra\n");
    const d = unifiedDiff("f.txt", a, b);
    expect(d).toContain("@@ -1,5 +1,5 @@");
    expect(d).toContain("@@ -15,6 +15,7 @@");
    expect(unifiedDiff("f", a, a)).toBe("");
  });
});

import { describe, it, expect } from "vitest";
import { jsxTags } from "../../src/audit/util.js";
import { computeFixes } from "../../src/audit/fix.js";
import { run } from "./helpers.js";

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const fixOf = (path: string, content: string, check: Parameters<typeof run>[0]) => {
  const findings = run(check, { [path]: content });
  return { findings, res: computeFixes([{ path, content }], findings) };
};

describe("jsxTags", () => {
  it("does not stop at => or at > inside strings", () => {
    const t = [...jsxTags(`<Script onLoad={() => init()} a="x > y" b='>' c={\`>\`} />`, "Script")];
    expect(t).toHaveLength(1);
    expect(t[0].text.endsWith("/>")).toBe(true);
    expect(t[0].attrs).toContain('a="x > y"');
  });
  it("handles multi-line arrow bodies with >", () => {
    const src = `<Image\n  onLoad={() => {\n    if (a > b) go();\n  }}\n  alt="x"\n/>`;
    const [t] = [...jsxTags(src, "Image")];
    expect(t.text).toBe(src);
  });
  it("skips unterminated tags", () => {
    expect([...jsxTags(`<Image src="a" ${"x ".repeat(4000)}`, "Image")]).toEqual([]);
  });
  it("an apostrophe in a comment inside an attribute does not run into the next tag", () => {
    const src = `<Script\n  onLoad={() => {\n    // don't run twice\n    init(); /* it's fine */\n  }}\n  strategy="beforeInteractive"\n/>\n<p title='x'>after</p>\n<Script src="b.js" />`;
    const tags = [...jsxTags(src, "Script")];
    expect(tags).toHaveLength(2);
    expect(tags[0].text).toBe(src.slice(0, src.indexOf("<p")).trimEnd());
    expect(tags[1].text).toBe(`<Script src="b.js" />`);
  });
  it("does not read // inside a URL or a regex as a comment", () => {
    const src = `<a\n  onClick={() => open(url.replace(/^http:\\/\\//, "https://"), x ? "//cdn" : y)}\n  href="//example.com/a"\n>`;
    const [t] = [...jsxTags(src, "a")];
    expect(t.text).toBe(src);
  });
});

describe("arrow-function attributes before existing attributes", () => {
  const gtag = "https://www.googletagmanager.com/gtag/js";
  const scriptSrc = (tag: string) => `import Script from "next/script";\nexport default () => (<>${tag}</>);\n`;

  it("<Script> with lazyOnload after an arrow: no finding", () => {
    const c = scriptSrc(`<Script onLoad={() => init()} strategy="lazyOnload" src="${gtag}"/>`);
    expect(run("third-party-script", { "app/a.tsx": c })).toEqual([]);
  });
  it("<Script> with strategy after an arrow gets rewritten once", () => {
    const c = scriptSrc(`<Script onLoad={() => init()} strategy="afterInteractive" src="${gtag}"/>`);
    const bad = scriptSrc(`<Script onLoad={() => init()} strategy="beforeInteractive" src="${gtag}"/>`);
    expect(run("third-party-script", { "app/a.tsx": c })).toHaveLength(0);
    const { res } = fixOf("app/a.tsx", bad, "third-party-script");
    const after = res.edits[0].after;
    expect(count(after, /strategy=/g)).toBe(1);
    expect(after).toContain('strategy="lazyOnload"');
  });
  it("<Script> multi-line onLoad with `a > b` and > in alt-like strings", () => {
    const c = scriptSrc(`<Script\n  onLoad={() => {\n    if (a > b) { init(); }\n  }}\n  data-x="a > b"\n  strategy="lazyOnload"\n  src="${gtag}"\n/>`);
    expect(run("third-party-script", { "app/a.tsx": c })).toEqual([]);
  });
  it("<Script> after one whose handler has an apostrophe in a comment is still reported and fixed on its own", () => {
    const fb = "https://connect.facebook.net/en_US/fbevents.js";
    const c = scriptSrc(`<Script\n  src="${gtag}"\n  onLoad={() => {\n    // don't run twice\n    init();\n  }}\n  strategy="lazyOnload"\n/>\n<p title='x'>after</p>\n<Script src="${fb}" strategy="beforeInteractive" />`);
    const { findings, res } = fixOf("app/a.tsx", c, "third-party-script");
    expect(findings.map((f) => f.line)).toEqual([11]);
    expect(res.edits[0].after).toContain(`<Script src="${fb}" strategy="lazyOnload" />`);
    expect(count(res.edits[0].after, /strategy="lazyOnload"/g)).toBe(2);
  });
  it("<Script> without strategy gets exactly one added", () => {
    const c = scriptSrc(`<Script onLoad={() => init()} src="${gtag}" data-x="a > b"/>`);
    const { findings, res } = fixOf("app/a.tsx", c, "third-party-script");
    expect(findings).toHaveLength(1);
    expect(count(res.edits[0].after, /strategy=/g)).toBe(1);
  });

  const imgSrc = (tag: string) => `import Image from "next/image";\nexport default () => (<div>${tag}</div>);\n`;
  it("<Image> with priority after an arrow: no lcp-priority finding", () => {
    const c = imgSrc(`<Image onLoad={() => {}} priority src="/a.png" alt="a > b" width={1} height={1} />`);
    expect(run("lcp-priority", { "components/Hero.tsx": c })).toEqual([]);
  });
  it("<Image> with loading after an arrow: fixer adds no priority", () => {
    const c = imgSrc(`<Image onLoad={() => { a > b; }} loading="lazy" src="/a.png" alt="x" width={1} height={1} />`);
    const { findings, res } = fixOf("components/Hero.tsx", c, "lcp-priority");
    expect(findings).toHaveLength(1);
    expect(res.edits).toEqual([]);
    expect(res.skipped.some((s) => /loading/.test(s.reason))).toBe(true);
  });
  it("<Image> missing priority: one priority added with arrow attr + > in alt", () => {
    const c = imgSrc(`<Image\n  onLoad={() => {\n    a > b;\n  }}\n  alt="a > b"\n  src="/a.png" width={1} height={1}\n/>`);
    const { res } = fixOf("components/Hero.tsx", c, "lcp-priority");
    expect(count(res.edits[0].after, /\bpriority\b/g)).toBe(1);
  });

  it("<img> with loading/decoding after an arrow: no duplicates", () => {
    const c = `export const A = () => <img onLoad={() => go()} loading="lazy" decoding="async" src="a" />;\n`;
    const { res } = fixOf("components/Card.tsx", c, "raw-img");
    expect(res.edits).toEqual([]);
  });
  it("<img> with alt containing > and a multi-line arrow gets each attribute once", () => {
    const c = `export const A = () => (\n  <img\n    onLoad={() => {\n      if (a > b) go();\n    }}\n    alt="a > b"\n    loading="lazy"\n    src="a"\n  />\n);\n`;
    const { res } = fixOf("components/Card.tsx", c, "raw-img");
    const after = res.edits[0].after;
    expect(count(after, /loading=/g)).toBe(1);
    expect(count(after, /decoding=/g)).toBe(1);
  });
});

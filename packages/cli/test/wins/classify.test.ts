import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { classifyWins, detectFramework } from "../../src/wins/classify.js";
import type { RouteAttribution } from "../../src/wins/types.js";

let root: string;
const write = (rel: string, src: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), src);
};

const attr = (
  route: string,
  importer: string,
  imported: string,
  bytes: number,
  packageName: string | null = null,
): RouteAttribution => ({
  route,
  firstLoadBytes: 100000,
  measured: true,
  edges: [
    {
      edge: { importer, imported, packageName },
      chain: [importer, imported],
      uniqueBytes: bytes,
      subtreeBytes: bytes,
    },
  ],
});

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "wins-classify-"));
  write(
    "lib/renderMd.tsx",
    `import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
export function renderInlineMarkdownText(text: string) {
  return String(unified().use(remarkParse).use(remarkRehype).use(rehypeStringify).processSync(text));
}`,
  );
  write(
    "components/Faq.tsx",
    `"use client";
import { renderInlineMarkdownText } from "../lib/renderMd";
export default function Faq({ t }: { t: string }) { return <div dangerouslySetInnerHTML={{ __html: renderInlineMarkdownText(t) }} />; }`,
  );
  write("components/Chart.tsx", `export default function Chart(){ return <div/>; }`);
  write("components/Named.tsx", `export function Named(){ return <div/>; }`);
  write("components/Static.tsx", `export default function Static(){ return <p>hi</p>; }`);
  write("components/Unused.tsx", `export default function Unused(){ return null; }`);
  write(
    "app/cond/page.tsx",
    `"use client";
import Chart from "../../components/Chart";
export default function P({ open }: { open: boolean }) { return <main>{open && <Chart />}</main>; }`,
  );
  write(
    "app/handler/page.tsx",
    `"use client";
import Chart from "../../components/Chart";
export default function P() { return <button onClick={() => { console.log(Chart); }}>x</button>; }`,
  );
  write(
    "app/always/page.tsx",
    `import Chart from "../../components/Chart";
export default function P() { return <main><Chart /></main>; }`,
  );
  write(
    "app/named/page.tsx",
    `"use client";
import { Named } from "../../components/Named";
export default function P({ a }: { a: boolean }) { return a ? <Named /> : null; }`,
  );
  write(
    "app/barrel/page.tsx",
    `import { Foo } from "lucide-react";
export default function P() { return <Foo />; }`,
  );
  write(
    "app/unused/page.tsx",
    `import Unused from "../../components/Unused";
export default function P() { return <main/>; }`,
  );
  write(
    "app/server/client.tsx",
    `"use client";
import Static from "../../components/Static";
export default function C() { return <Static />; }`,
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = (a: RouteAttribution[]) => classifyWins(a, { projectRoot: root, byteSource: "measured" });

describe("classifyWins", () => {
  it("conditional render -> lazy, safe, SSR kept", async () => {
    const [w] = await run([attr("/cond", "app/cond/page.tsx", "components/Chart.tsx", 20000)]);
    expect(w!.fixKind).toBe("lazy");
    expect(w!.usage).toBe("conditional-render");
    expect(w!.safety).toBe("safe");
    expect(w!.edit.replacementImport).not.toContain("ssr: false");
    expect(w!.usageLoc).toBeDefined();
  });

  it("first-party edge into a module hosting a unified pipeline -> guard-heavy", async () => {
    const [w] = await run([attr("/faq", "components/Faq.tsx", "lib/renderMd.tsx", 100000)]);
    expect(w!.fixKind).toBe("guard-heavy");
    expect(w!.edit.replacementImport).toContain("MARKDOWN_HINT");
    expect(w!.edit.summary).toContain("lib/renderMd.tsx");
  });

  it("handler-only -> await import", async () => {
    const [w] = await run([attr("/h", "app/handler/page.tsx", "components/Chart.tsx", 20000)]);
    expect(w!.usage).toBe("event-handler-only");
    expect(w!.edit.replacementImport).toContain("await import('../../components/Chart')");
  });

  it("always rendered in page -> above-the-fold needs-review", async () => {
    const [w] = await run([attr("/a", "app/always/page.tsx", "components/Chart.tsx", 20000)]);
    expect(w!.usage).toBe("always-rendered");
    expect(w!.safety).toBe("needs-review");
    expect(w!.safetyReasons).toContain("above-the-fold");
  });

  it("named export flagged with .then mapping", async () => {
    const [w] = await run([attr("/n", "app/named/page.tsx", "components/Named.tsx", 20000)]);
    expect(w!.safetyReasons).toContain("named-export");
    expect(w!.safetyReasons).toContain("no-default-export");
    expect(w!.edit.replacementImport).toContain(".then((m) => m.Named)");
  });

  it("barrel package root import -> deep-import", async () => {
    const [w] = await run([
      attr("/b", "app/barrel/page.tsx", "node_modules/lucide-react/index.js", 50000, "lucide-react"),
    ]);
    expect(w!.fixKind).toBe("deep-import");
  });

  it("unused binding -> remove", async () => {
    const [w] = await run([attr("/u", "app/unused/page.tsx", "components/Unused.tsx", 20000)]);
    expect(w!.fixKind).toBe("remove");
  });

  it("pure module under use client -> move-to-server", async () => {
    const [w] = await run([attr("/s", "app/server/client.tsx", "components/Static.tsx", 20000)]);
    expect(w!.fixKind).toBe("move-to-server");
  });

  it("merges routes, max-dedupes, sorts, drops small unknown", async () => {
    const wins = await run([
      attr("/x", "app/cond/page.tsx", "components/Chart.tsx", 20000),
      attr("/y", "app/cond/page.tsx", "components/Chart.tsx", 30000),
      attr("/z", "missing/file.tsx", "components/Chart.tsx", 5000),
      attr("/q", "missing/other.tsx", "components/Chart.tsx", 90000),
    ]);
    expect(wins.map((w) => w.edge.importer)).toEqual(["missing/other.tsx", "app/cond/page.tsx"]);
    const merged = wins[1]!;
    expect(merged.routes).toEqual({ "/x": 20000, "/y": 30000 });
    expect(merged.totalSavedBytes).toBe(30000);
    expect(wins[0]!.safetyReasons).toContain("unresolved-usage");
  });
});

describe("detectFramework", () => {
  const proj = (pkg: object) => {
    const d = mkdtempSync(join(tmpdir(), "wins-fw-"));
    writeFileSync(join(d, "package.json"), JSON.stringify(pkg));
    return d;
  };
  const all = ["preact", "react", "svelte", "vue", "solid-js", "next"];

  it("preact-only -> preact", () => {
    expect(detectFramework(proj({ dependencies: { preact: "^10" } }))).toBe("preact");
  });

  it("precedence next > solid > vue > svelte > react > preact", () => {
    const order = [["next", "next"], ["solid-js", "solid"], ["vue", "vue"], ["svelte", "svelte"], ["react", "react"], ["preact", "preact"]] as const;
    for (let i = 0; i < order.length; i++) {
      const deps = Object.fromEntries(order.slice(i).map(([d]) => [d, "1"]));
      expect(detectFramework(proj({ dependencies: deps }))).toBe(order[i]![1]);
    }
    expect(all).toHaveLength(order.length);
  });

  it("dependencies beat devDependencies; devDependencies used as fallback", () => {
    expect(detectFramework(proj({ dependencies: { preact: "1" }, devDependencies: { next: "1" } }))).toBe("preact");
    expect(detectFramework(proj({ devDependencies: { vue: "1", react: "1" } }))).toBe("vue");
    expect(detectFramework(proj({}))).toBe("generic");
  });
});

describe("classifyWins framework output", () => {
  it("preact -> lazy from preact/compat", async () => {
    const preactRoot = mkdtempSync(join(tmpdir(), "wins-preact-"));
    writeFileSync(join(preactRoot, "package.json"), JSON.stringify({ dependencies: { preact: "^10" } }));
    for (const f of ["app/cond/page.tsx", "components/Chart.tsx"]) {
      mkdirSync(dirname(join(preactRoot, f)), { recursive: true });
      writeFileSync(join(preactRoot, f), readFileSync(join(root, f)));
    }
    const [w] = await classifyWins([attr("/cond", "app/cond/page.tsx", "components/Chart.tsx", 20000)], {
      projectRoot: preactRoot,
      byteSource: "measured",
      framework: detectFramework(preactRoot),
    });
    expect(w!.edit.replacementImport).toContain("import { lazy } from 'preact/compat';");
    expect(w!.edit.replacementImport).toContain("lazy(() => import(");
    rmSync(preactRoot, { recursive: true, force: true });
  });

  it("namespace import -> await import, never lazy()/dynamic(), unresolved-usage", async () => {
    write(
      "app/ns/page.tsx",
      `"use client";
import * as Icons from "lib";
export default function P({ n }: { n: string }) { return <main>{(Icons as any)[n]}</main>; }`,
    );
    for (const framework of ["next", "react", "preact", "vue", "solid", "svelte", "generic"] as const) {
      const [w] = await classifyWins([attr("/ns", "app/ns/page.tsx", "node_modules/lib/index.js", 50000, "lib")], {
        projectRoot: root,
        byteSource: "measured",
        framework,
      });
      expect(w!.fixKind).toBe("lazy");
      expect(w!.edit.replacementImport).toContain("const Icons = await import('lib');");
      expect(w!.edit.replacementImport).not.toMatch(/lazy\(|dynamic\(|defineAsyncComponent\(/);
      expect(w!.safety).toBe("needs-review");
      expect(w!.safetyReasons).toContain("unresolved-usage");
    }
  });
});

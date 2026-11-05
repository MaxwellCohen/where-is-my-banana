import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { WinsReport } from "../../src/wins/types.js";
import { formatValidationMarkdown, runValidate } from "../../src/wins/validate.js";

const A = "a".repeat(5000) + Math.random();
const B = Array.from({ length: 800 }, (_, i) => `x${i * 7919 % 1000}`).join(",");
const C = "console.log('dyn')".repeat(50);
const gz = (s: string) => gzipSync(Buffer.from(s), { level: 9 }).length;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "wimb-val-"));
  const dist = join(root, ".next");
  mkdirSync(join(dist, "static/chunks"), { recursive: true });
  mkdirSync(join(dist, "server/app"), { recursive: true });
  writeFileSync(join(dist, "static/chunks/a.js"), A);
  writeFileSync(join(dist, "static/chunks/b.js"), B);
  writeFileSync(join(dist, "static/chunks/c.js"), C);
  writeFileSync(join(dist, "static/chunks/poly.js"), "polyfill");
  const home = `<html><head>
<link rel="preload" as="script" href="/_next/static/chunks/a.js"/>
<link href="/_next/static/chunks/c.js?v=1" as="script" rel="preload"/>
<script src="/_next/static/chunks/a.js" async></script>
<script async src='/_next/static/chunks/b.js'></script>
<script nomodule src="/_next/static/chunks/poly.js"></script>
<script>inline()</script></head></html>`;
  writeFileSync(join(dist, "server/app/index.html"), home);
  writeFileSync(join(dist, "server/app/about.html"), `<script src="/_next/static/chunks/a.js"></script><script src="/_next/static/chunks/gone.js"></script>`);
  return { root, dist, home };
}

const exact = gz(A) + gz(B);
const report = (first: number, extra: WinsReport["routes"] = []): WinsReport => ({
  version: "2",
  timestamp: "",
  projectRoot: "",
  byteSource: "measured",
  routes: [{ route: "/", firstLoadBytes: first, preloadedBytes: 99 }, ...extra],
  wins: [],
});

describe("runValidate", () => {
  it("totals, preload-only separation, nomodule exclusion", async () => {
    const { root } = setup();
    const v = await runValidate({ projectRoot: root, report: report(exact) });
    const r = v.routes[0]!;
    expect(r.status).toBe("ok");
    expect(r.scriptCount).toBe(2);
    expect(r.htmlScriptRawBytes).toBe(Buffer.byteLength(A) + Buffer.byteLength(B));
    expect(r.htmlScriptGzipBytes).toBe(exact);
    expect(r.preloadCount).toBe(1);
    expect(r.htmlPreloadGzipBytes).toBe(gz(C));
    expect(r.graphPreloadedBytes).toBe(99);
    expect(r.diff).toBe(0);
    expect(r.reasons.join()).toContain("polyfills (nomodule) excluded");
    expect(r.reasons.join()).toContain("1 dynamic chunks preloaded");
  });

  it("flags beyond tolerance", async () => {
    const { root } = setup();
    const v = await runValidate({ projectRoot: root, report: report(Math.round(exact * 0.5)) });
    expect(v.flagged).toBe(1);
    expect(v.routes[0]!.status).toBe("flagged");
    expect(v.routes[0]!.diff).toBeGreaterThan(0.15);
    const v2 = await runValidate({ projectRoot: root, report: report(Math.round(exact * 0.5)), tolerance: 5 });
    expect(v2.flagged).toBe(0);
    expect(formatValidationMarkdown(v)[0]).toBe("## Validation");
  });

  it("no-html and missing files", async () => {
    const { root } = setup();
    const v = await runValidate({
      projectRoot: root,
      report: report(exact, [{ route: "/blog/[slug]", firstLoadBytes: 10 }, { route: "/about", firstLoadBytes: gz(A) }]),
    });
    expect(v.routes[1]!.status).toBe("no-html");
    expect(v.routes[1]!.reasons[0]).toContain("not prerendered");
    expect(v.routes[2]!.status).toBe("ok");
    expect(v.routes[2]!.missing).toEqual(["/_next/static/chunks/gone.js"]);
  });

  it("htmlDir", async () => {
    const { root, home } = setup();
    const dir = join(root, "out");
    mkdirSync(join(dir, "about"), { recursive: true });
    writeFileSync(join(dir, "index.html"), home);
    writeFileSync(join(dir, "about/index.html"), `<script src="/_next/static/chunks/b.js"></script>`);
    const v = await runValidate({ projectRoot: root, htmlDir: dir, report: report(exact, [{ route: "/about", firstLoadBytes: gz(B) }]) });
    expect(v.routes.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(v.routes[1]!.htmlPath).toContain("about/index.html");
  });

  it("url mode with injected fetch", async () => {
    const { root, home } = setup();
    const seen: string[] = [];
    const fetchFn = (async (u: string) => {
      seen.push(u);
      const files: Record<string, string> = {
        "https://x.test/": home,
        "https://x.test/_next/static/chunks/a.js": A,
        "https://x.test/_next/static/chunks/b.js": B,
        "https://x.test/_next/static/chunks/c.js?v=1": C,
      };
      const body = files[u];
      return body === undefined ? new Response("", { status: 404 }) : new Response(body);
    }) as unknown as typeof fetch;
    const v = await runValidate({
      projectRoot: root,
      url: "https://x.test",
      fetchFn,
      delayMs: 0,
      report: report(exact, [{ route: "/p/[id]", firstLoadBytes: 5 }]),
    });
    expect(v.routes[0]!.source).toBe("url");
    expect(v.routes[0]!.htmlScriptGzipBytes).toBe(exact);
    expect(v.routes[0]!.status).toBe("ok");
    expect(v.routes[1]!.status).toBe("no-html");
    expect(seen.some((u) => u.includes("["))).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { run } from "./helpers.js";

describe("force-dynamic", () => {
  it("flags force-dynamic, revalidate 0, no-store", () => {
    const f = run("force-dynamic", {
      "app/page.tsx": `export const dynamic = "force-dynamic";\nexport const revalidate = 0;\nconst r = await fetch(u, { cache: "no-store" });`,
    });
    expect(f.map((x) => x.id).sort()).toEqual(["force-dynamic/no-store", "force-dynamic/revalidate-0", "force-dynamic/segment-config"]);
  });
  it("flags cookies() in layout as high", () => {
    const f = run("force-dynamic", { "app/layout.tsx": `import { cookies } from "next/headers";\nconst c = cookies();` });
    expect(f[0]).toMatchObject({ id: "force-dynamic/layout-request-api", severity: "high" });
  });
  it("ignores route handlers and static pages", () => {
    expect(run("force-dynamic", { "app/api/x/route.ts": `export const dynamic = "force-dynamic";`, "app/page.tsx": `export const revalidate = 60;` })).toHaveLength(0);
  });
});

describe("missing-static-params", () => {
  it("flags dynamic page without generateStaticParams", () => {
    const f = run("missing-static-params", { "app/locations/[slug]/page.tsx": `export default function P(){return null}` });
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain("/locations/[slug]");
  });
  it("passes with generateStaticParams", () => {
    expect(run("missing-static-params", { "app/[slug]/page.tsx": `export async function generateStaticParams(){return []}` })).toHaveLength(0);
  });
  it("ignores static routes", () => {
    expect(run("missing-static-params", { "app/about/page.tsx": `export default () => null` })).toHaveLength(0);
  });
});

describe("sequential-await", () => {
  it("flags independent adjacent awaits", () => {
    const c = `export default async function P() {\n  const page = await getPage();\n  const nav = await getNav();\n  return null;\n}`;
    const f = run("sequential-await", { "app/page.tsx": c });
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(2);
  });
  it("skips dependent awaits", () => {
    const c = `export default async function P() {\n  const page = await getPage();\n  const rel = await getRelated(page.id);\n}`;
    expect(run("sequential-await", { "app/page.tsx": c })).toHaveLength(0);
  });
  it("skips client files", () => {
    const c = `"use client";\nconst a = await getA();\nconst b = await getB();`;
    expect(run("sequential-await", { "app/c.tsx": c })).toHaveLength(0);
  });
});

describe("full-cms-payload-to-client", () => {
  const files = (prop: string) => ({
    "app/page.tsx": `import Hero from "../components/Hero";\nimport { getPage } from "../lib/cms";\nexport default async function P(){\n  const page = await getPage();\n  return <Hero ${prop} />;\n}`,
    "components/Hero.tsx": `"use client";\nexport default function Hero(p:any){return null}`,
  });
  it("flags whole response passed to client component", () => {
    expect(run("full-cms-payload-to-client", files("data={page}"))).toHaveLength(1);
    expect(run("full-cms-payload-to-client", files("{...page}"))).toHaveLength(1);
  });
  it("passes picked fields", () => {
    expect(run("full-cms-payload-to-client", files("title={page.title}"))).toHaveLength(0);
  });
});

describe("middleware-scope", () => {
  it("flags missing matcher", () => {
    expect(run("middleware-scope", { "middleware.ts": `export function middleware(){}` })[0].severity).toBe("high");
  });
  it("flags catch-all without _next exclusion", () => {
    const f = run("middleware-scope", { "middleware.ts": `export const config = { matcher: ["/(.*)"] };` });
    expect(f[0].severity).toBe("medium");
  });
  it("passes a scoped matcher", () => {
    expect(run("middleware-scope", { "middleware.ts": `export const config = { matcher: ["/dashboard/:path*"] };` })).toHaveLength(0);
  });
  it("passes standard exclusion pattern", () => {
    const c = `export const config = { matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\\\.(?:svg|png)$).*)"] };`;
    expect(run("middleware-scope", { "middleware.ts": c })).toHaveLength(0);
  });
});

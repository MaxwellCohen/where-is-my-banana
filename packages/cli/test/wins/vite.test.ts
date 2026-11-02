import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { classifyRouteChunk } from "../../src/sources/route-files.js";
import { buildGraphFromVite, isViteProject, routeForEntry, routeForTanstackFile } from "../../src/sources/vite.js";

function project(pkg: object): string {
  const dir = mkdtempSync(join(tmpdir(), "wimb-vite-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
}

describe("isViteProject", () => {
  it("true for vite without next", () => {
    expect(isViteProject(project({ devDependencies: { vite: "^5" } }))).toBe(true);
  });
  it("false when next present or no package.json", () => {
    expect(isViteProject(project({ dependencies: { next: "16", vite: "5" } }))).toBe(false);
    expect(isViteProject(mkdtempSync(join(tmpdir(), "wimb-vite-")))).toBe(false);
  });
});

describe("routeForEntry", () => {
  it("keys on facade path so same-named entries differ", () => {
    expect(routeForEntry("index.html", "index")).toBe("/");
    expect(routeForEntry("admin/index.html", "index")).toBe("/admin");
    expect(routeForEntry("about.html", "about")).toBe("/about");
    expect(routeForEntry("src/a/main.ts", "main")).toBe("/src/a/main");
    expect(routeForEntry("src/b/main.ts", "main")).toBe("/src/b/main");
    expect(routeForEntry("", "fallback")).toBe("/fallback");
  });
});

describe("routeForTanstackFile", () => {
  it("maps file-based routes to URL patterns", () => {
    expect(routeForTanstackFile("src/routes/index.tsx?tsr-split=component")).toBe("/");
    expect(routeForTanstackFile("src/routes/about.tsx")).toBe("/about");
    expect(routeForTanstackFile("src/routes/example.chat.tsx")).toBe("/example/chat");
    expect(routeForTanstackFile("src/routes/posts/$id.tsx")).toBe("/posts/[id]");
    expect(routeForTanstackFile("src/routes/posts/index.tsx")).toBe("/posts");
    expect(routeForTanstackFile("src/routes/_auth.login.tsx")).toBe("/login");
    expect(routeForTanstackFile("src/routes/(app)/home.tsx")).toBe("/home");
    expect(routeForTanstackFile("src/routes/__root.tsx")).toBeNull();
    expect(routeForTanstackFile("src/routes/posts.route.tsx")).toBeNull();
    expect(routeForTanstackFile("src/routes/_layout.tsx")).toBeNull();
  });
});

describe("buildGraphFromVite with TanStack route splitting", () => {
  it("derives one route per split route file, each including the entry closure", async () => {
    const graph = await buildGraphFromVite(fileURLToPath(new URL("../fixtures/vite-tanstack", import.meta.url)));
    expect([...graph.routes.keys()].sort()).toEqual(["/", "/about", "/example/chat"]);
    const size = (r: string) => [...graph.clientPartsByRoute.get(r)!.values()].reduce((a, b) => a + b, 0);
    for (const r of graph.routes.keys()) expect(graph.clientPartsByRoute.get(r)!.has("src/shared.ts")).toBe(true);
    expect(graph.clientPartsByRoute.get("/")!.has("src/heavy.ts")).toBe(true);
    expect(graph.clientPartsByRoute.get("/about")!.has("src/heavy.ts")).toBe(false);
    expect(size("/")).toBeGreaterThan(size("/about"));
  });
});

describe("classifyRouteChunk", () => {
  it("recognises SvelteKit pages, layouts and error pages", () => {
    expect(classifyRouteChunk("/p/src/routes/+page.svelte", "src/routes/+page.svelte")).toMatchObject({ kind: "page", route: "/" });
    expect(classifyRouteChunk("/p/src/routes/(app)/[id]/+page.svelte", "src/routes/(app)/[id]/+page.svelte")).toMatchObject({
      kind: "page",
      route: "/[id]",
    });
    expect(classifyRouteChunk("/p/src/routes/+layout.svelte", "src/routes/+layout.svelte")).toMatchObject({ kind: "layout", dir: "src/routes" });
    expect(classifyRouteChunk("/p/src/routes/+error.svelte", "src/routes/+error.svelte")).toMatchObject({ kind: "skip" });
  });
  it("recognises SolidStart picked route files", () => {
    expect(classifyRouteChunk("/p/src/routes/index.tsx?pick=default", "src/routes/index.tsx")).toMatchObject({ kind: "page", route: "/" });
    expect(classifyRouteChunk("/p/src/routes/blog/[slug].tsx?pick=default", "src/routes/blog/[slug].tsx")).toMatchObject({
      route: "/blog/[slug]",
    });
  });
  it("ignores ordinary modules", () => {
    expect(classifyRouteChunk("/p/src/lib/a.ts", "src/lib/a.ts")).toBeNull();
  });
});

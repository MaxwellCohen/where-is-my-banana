import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isViteProject, routeForEntry } from "../../src/sources/vite.js";

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

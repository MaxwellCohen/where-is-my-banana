import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { synGraph } from "../helpers-graph.js";
import { rebaseGraph } from "../../src/wins/rebase.js";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wimb-rebase-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function touch(...parts: string[]): void {
  const file = join(tmp, ...parts);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "");
}

describe("rebaseGraph", () => {
  it("makes workspace-root paths relative to a monorepo sub-package", () => {
    touch("mono", "packages", "web", "src", "page.tsx");
    touch("mono", "packages", "ui", "src", "button.tsx");
    touch("mono", "node_modules", "zod", "index.js");
    const paths = {
      page: "[project]/packages/web/src/page.tsx",
      button: "[project]/packages/ui/src/button.tsx",
      zod: "[project]/node_modules/zod/index.js",
      runtime: "[turbopack]/browser/runtime.ts",
    };
    const g = synGraph(
      {
        page: { path: paths.page, sync: ["button", "zod", "runtime"] },
        button: { path: paths.button },
        zod: { path: paths.zod },
        runtime: { path: paths.runtime },
      },
      {
        "/": {
          seeds: ["page"],
          bytes: { "packages/web/src/page.tsx": 1, "packages/ui/src/button.tsx": 2, "node_modules/zod/index.js": 3, "[turbopack]/browser/runtime.ts": 4 },
        },
      },
    );
    rebaseGraph(g, join(tmp, "mono", "packages", "web"));
    expect([...g.modules.values()].map((m) => m.path)).toEqual([
      "src/page.tsx",
      "../ui/src/button.tsx",
      "../../node_modules/zod/index.js",
      "[turbopack]/browser/runtime.ts",
    ]);
    expect([...g.clientPartsByRoute.get("/")!]).toEqual([
      ["src/page.tsx", 1],
      ["../ui/src/button.tsx", 2],
      ["../../node_modules/zod/index.js", 3],
      ["[turbopack]/browser/runtime.ts", 4],
    ]);
    const entry = g.routes.get("/")!.entries![0];
    expect(entry.module_path).toBe("src/page.tsx");
    expect(entry.client_references!.map((c) => c.module_path)).toEqual(["src/page.tsx"]);
  });

  it("is not misled by a sibling folder named like the project", () => {
    // mono2/web is an old app next to mono2/packages/web; one of its files has a twin inside the project.
    touch("mono2", "packages", "web", "src", "page.tsx");
    touch("mono2", "packages", "web", "src", "util.ts");
    touch("mono2", "web", "src", "util.ts");
    const g = synGraph(
      {
        page: { path: "[project]/packages/web/src/page.tsx", sync: ["util", "old"] },
        util: { path: "[project]/packages/web/src/util.ts" },
        old: { path: "[project]/web/src/util.ts" },
      },
      { "/": { seeds: ["page"], bytes: { "packages/web/src/page.tsx": 1, "packages/web/src/util.ts": 2, "web/src/util.ts": 3 } } },
    );
    rebaseGraph(g, join(tmp, "mono2", "packages", "web"));
    expect([...g.clientPartsByRoute.get("/")!.keys()]).toEqual(["src/page.tsx", "src/util.ts", "../../web/src/util.ts"]);
  });

  it("leaves a standalone project alone, even when a folder is named like the project", () => {
    touch("app", "app", "page.tsx");
    const g = synGraph({ page: { path: "[project]/app/page.tsx" } }, { "/": { seeds: ["page"], bytes: { "app/page.tsx": 1 } } });
    rebaseGraph(g, join(tmp, "app"));
    expect(g.modules.get("page")!.path).toBe("[project]/app/page.tsx");
    expect([...g.clientPartsByRoute.get("/")!.keys()]).toEqual(["app/page.tsx"]);
  });

  it("leaves the graph alone when the files are not on disk", () => {
    const g = synGraph({ page: { path: "[project]/packages/web/src/page.tsx" } }, { "/": { seeds: ["page"], bytes: {} } });
    rebaseGraph(g, join(tmp, "elsewhere", "packages", "web"));
    expect(g.modules.get("page")!.path).toBe("[project]/packages/web/src/page.tsx");
  });
});

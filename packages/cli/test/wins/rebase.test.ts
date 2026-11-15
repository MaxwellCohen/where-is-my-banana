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
    expect(g.routes.get("/")!.entries![0].module_path).toBe("src/page.tsx");
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

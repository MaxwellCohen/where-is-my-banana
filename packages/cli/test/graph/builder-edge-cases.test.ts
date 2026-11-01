import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../../src/graph/builder.js";
import { getPackageName } from "../../src/graph/package-info.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function project(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "wimb-graph-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe("graph builder edge cases", () => {
  it("resolves scoped packages from node_modules", async () => {
    const root = project({
      "app/page.tsx": 'import { a } from "@scope/pkg";\nexport default function P(){ return a; }\n',
      "node_modules/@scope/pkg/package.json": '{"name":"@scope/pkg","main":"index.js"}',
      "node_modules/@scope/pkg/index.js": "export const a = 1;\n",
    });
    expect(getPackageName("@scope/pkg/sub")).toBe("@scope/pkg");
    const graph = await buildGraph(root);
    const page = [...graph.modules.values()].find((m) => m.filePath.endsWith("page.tsx"))!;
    expect(page.imports[0]?.resolvedPath).toContain("@scope");
  });

  it("handles CRLF sources with correct locations", async () => {
    const root = project({
      "app/page.tsx": 'import { a } from "./a";\r\n\r\nexport const x = a;\r\nexport default function P(){ return x; }\r\n',
      "app/a.ts": "export const a = 1;\r\n",
    });
    const graph = await buildGraph(root);
    const page = [...graph.modules.values()].find((m) => m.filePath.endsWith("page.tsx"))!;
    const x = page.exports.find((e) => e.name === "x")!;
    expect(x.loc.line).toBe(3);
    expect(page.exports.map((e) => e.name)).toContain("default");
  });

  it("computes chains, subtree bytes (cycles) and export refs", async () => {
    const root = project({
      "app/page.tsx": 'import * as m from "../lib/a";\nexport default function P(){ return m; }\n',
      "lib/a.ts": 'import { b } from "./b";\nexport const a = b;\nexport class K {}\n',
      "lib/b.ts": 'import { a } from "./a";\nexport const b = 1;\nexport const c = a;\n',
    });
    const graph = await buildGraph(root);
    const get = (s: string) => [...graph.modules.values()].find((m) => m.filePath.endsWith(s))!;
    expect(get("b.ts").importChainFromEntry.map((p) => p.split("/").pop())).toEqual(["page.tsx", "a.ts", "b.ts"]);
    expect(get("a.ts").subtreeBytes).toBe(get("a.ts").sourceBytes + get("b.ts").sourceBytes);
    expect(get("a.ts").subtreeBytes).toBe(get("b.ts").subtreeBytes);
    const refs = get("a.ts").exports.map((e) => [e.name, e.referencedBy.length]);
    expect(refs).toEqual([["a", 2], ["K", 1]]);
  });

  it("surfaces parse errors as warnings", async () => {
    const root = project({ "app/page.tsx": "export default function ( {{{\n" });
    const graph = await buildGraph(root);
    expect(graph.warnings.length).toBeGreaterThan(0);
  });
});

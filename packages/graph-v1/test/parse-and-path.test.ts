import { describe, it, expect } from "vitest";
import { parseGraphV1Jsonl } from "../src/parse.js";
import { normalizeModulePath } from "../src/module-path.js";

describe("normalizeModulePath", () => {
  it("normalizes backslashes before stripping prefixes", () => {
    expect(normalizeModulePath("[project]\\app\\page.tsx")).toBe("app/page.tsx");
    expect(normalizeModulePath("[client-fs]/a/b.js")).toBe("a/b.js");
  });
});

describe("parse.ts", () => {
  it("parses a minimal jsonl and tolerates blank lines", () => {
    const jsonl = [
      JSON.stringify({ type: "meta", schema_version: 1, snapshot_name: "s", module_index_hash: "h", route_count: 0, selected_routes: 0 }),
      "",
      JSON.stringify({ type: "module", ident: "m", path: "[project]/app/page.tsx", dependencies: { sync: [], async: [], traced: [] } }),
    ].join("\n");
    const parsed = parseGraphV1Jsonl(jsonl);
    expect(parsed.meta.snapshot_name).toBe("s");
    expect(parsed.modules.size).toBe(1);
  });
});

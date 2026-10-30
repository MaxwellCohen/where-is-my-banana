import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { loadGraphFromFile, validateVizGraph } from "./load-graph";

const node = (over: Record<string, unknown> = {}) => ({
  kind: "route",
  id: "/",
  label: "/",
  selfBytes: 1,
  totalBytes: 2,
  routeCount: 1,
  children: [],
  ...over,
});
const graph = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  meta: { snapshotName: null, routeCount: 1, selectedRoutes: 1 },
  routes: [{ route: "/", totalBytes: 2, moduleCount: 1 }],
  trees: { "/": node() },
  ...over,
});
const file = (data: BlobPart, name: string) => new File([data], name);

describe("validateVizGraph", () => {
  it("accepts a valid graph", () => {
    expect(validateVizGraph(graph()).schemaVersion).toBe(2);
  });
  it("rejects bad schema, null trees, bad children, non-finite bytes", () => {
    expect(() => validateVizGraph(graph({ schemaVersion: 3 }))).toThrow(/schemaVersion/);
    expect(() => validateVizGraph(graph({ trees: { "/": null } }))).toThrow(/non-object/);
    expect(() => validateVizGraph(graph({ trees: { "/": node({ children: null }) } }))).toThrow(/children/);
    expect(() => validateVizGraph(graph({ trees: { "/": node({ totalBytes: "1" }) } }))).toThrow(/bytes/);
    expect(() => validateVizGraph(graph({ trees: { "/": node({ selfBytes: NaN }) } }))).toThrow(/bytes/);
  });
  it("validates nested children and sides", () => {
    const bad = node({ children: [node({ children: [5] })] });
    expect(() => validateVizGraph(graph({ trees: { "/": bad } }))).toThrow(/non-object/);
    expect(() => validateVizGraph(graph({ sides: { client: { routes: [], trees: {} } } }))).toThrow(/server/);
  });
});

describe("loadGraphFromFile", () => {
  it("loads .json", async () => {
    const g = await loadGraphFromFile(file(JSON.stringify(graph()), "g.json"));
    expect(g.routes).toHaveLength(1);
  });
  it("friendly error on invalid JSON", async () => {
    await expect(loadGraphFromFile(file("{nope", "g.json"))).rejects.toThrow(/not valid JSON/);
  });
  it("rejects oversize files", async () => {
    await expect(
      loadGraphFromFile(file("x".repeat(20), "g.json"), { maxFileBytes: 10 }),
    ).rejects.toThrow(/too large/);
  });
  it("aborts gunzip past the decompressed limit", async () => {
    const gz = gzipSync(Buffer.alloc(100_000, 97));
    await expect(
      loadGraphFromFile(file(new Uint8Array(gz), "g.jsonl.gz"), { maxDecompressedBytes: 1000 }),
    ).rejects.toThrow(/too large after decompression/);
  });
  it("reports corrupt gzip", async () => {
    await expect(loadGraphFromFile(file("not gzip", "g.jsonl.gz"))).rejects.toThrow(/decompress/);
  });
});

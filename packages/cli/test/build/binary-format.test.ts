import { describe, it, expect } from "vitest";
import {
  buildFullPaths,
  encodeEdgeTable,
  packDataFile,
  parseDataFile,
  readEdgesAtIndex,
} from "../../src/build/binary-format.js";

function view(buf: Buffer): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

describe("binary-format malformed input", () => {
  it("round-trips a valid edge table", () => {
    const { ref, bytes } = encodeEdgeTable([[1, 2], [], [3]]);
    expect(readEdgesAtIndex(view(bytes), ref, 0)).toEqual([1, 2]);
    expect(readEdgesAtIndex(view(bytes), ref, 1)).toEqual([]);
    expect(readEdgesAtIndex(view(bytes), ref, 2)).toEqual([3]);
  });

  it("handles truncated edge data without throwing", () => {
    const { ref, bytes } = encodeEdgeTable([[1, 2, 3, 4]]);
    const cut = bytes.subarray(0, bytes.byteLength - 8);
    expect(readEdgesAtIndex(view(cut), ref, 0)).toEqual([1, 2]);
    expect(readEdgesAtIndex(view(bytes.subarray(0, 6)), ref, 0)).toEqual([]);
  });

  it("rejects non-monotonic offsets and clamps huge counts", () => {
    const bad = Buffer.alloc(4 + 8 + 4);
    bad.writeUInt32BE(2, 0);
    bad.writeUInt32BE(5, 4);
    bad.writeUInt32BE(1, 8);
    expect(readEdgesAtIndex(view(bad), { offset: 0, length: bad.length }, 1)).toEqual([]);
    const huge = Buffer.alloc(4 + 4 + 4);
    huge.writeUInt32BE(1, 0);
    huge.writeUInt32BE(0xffffffff, 4);
    huge.writeUInt32BE(7, 8);
    expect(readEdgesAtIndex(view(huge), { offset: 0, length: huge.length }, 0)).toEqual([7]);
  });

  it("throws descriptive error on bad header JSON", () => {
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(4, 0);
    buf.write("{bad", 4);
    expect(() => parseDataFile(buf)).toThrow(/invalid analyze header JSON/);
  });

  it("rejects invalid ref offsets", () => {
    const buf = packDataFile({ source_children: { offset: -1, length: 4 } });
    expect(() => parseDataFile(buf)).toThrow(/source_children/);
    const frac = packDataFile({ module_dependencies: { offset: 0, length: 1.5 } });
    expect(() => parseDataFile(frac)).toThrow(/module_dependencies/);
  });

  it("buildFullPaths survives parent cycles", () => {
    const paths = buildFullPaths([
      { path: "a/", parent_source_index: 1 },
      { path: "b/", parent_source_index: 0 },
      { path: "c", parent_source_index: null },
      { path: "d", parent_source_index: 2 },
      { path: "x", parent_source_index: 99 },
    ]);
    expect(paths).toHaveLength(5);
    expect(paths[2]).toBe("c");
    expect(paths[3]).toBe("cd");
    expect(paths[4]).toBe("x");
  });
});

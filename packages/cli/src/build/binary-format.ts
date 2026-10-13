/**
 * Next.js Turbopack analyze binary format helpers (pre-16.4 on-disk artifacts).
 * Next 16.4+ measured bytes prefer `next analyze export` JSONL; see analyze-export.ts.
 *
 * File layout (big-endian):
 *   [uint32 jsonLength][utf-8 JSON header][binary edge tables]
 *
 * Edge table at `ref.offset`:
 *   [uint32 N][N × uint32 cumulative counts][flat uint32 edge targets]
 *
 * Format is experimental and may change between Next.js versions.
 */

export interface BinaryRef {
  offset: number;
  length: number;
}

export interface AnalyzeSource {
  path: string;
  parent_source_index?: number | null;
}

export interface AnalyzeChunkPart {
  source_index: number;
  output_file_index: number;
  size: number;
  compressed_size: number;
}

export interface AnalyzeOutputFile {
  filename: string;
}

export interface AnalyzeRouteHeader {
  sources: AnalyzeSource[];
  chunk_parts: AnalyzeChunkPart[];
  output_files: AnalyzeOutputFile[];
  source_chunk_parts?: BinaryRef;
  source_children?: BinaryRef;
  source_roots?: number[];
  output_file_chunk_parts?: BinaryRef;
}

export interface ModulesHeader {
  modules: { ident?: string; path?: string }[];
  module_dependencies?: BinaryRef;
  async_module_dependencies?: BinaryRef;
}

export interface ParsedDataFile<T> {
  header: T;
  binary: DataView;
}

export function parseDataFile<T>(buf: Buffer): ParsedDataFile<T> {
  if (buf.byteLength < 4) {
    throw new Error("analyze data file too small");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const jsonLength = view.getUint32(0, false);
  if (jsonLength <= 0 || 4 + jsonLength > buf.byteLength) {
    throw new Error(`invalid analyze JSON length: ${jsonLength}`);
  }
  const jsonStr = new TextDecoder("utf-8").decode(buf.subarray(4, 4 + jsonLength));
  const header = JSON.parse(jsonStr) as T;
  const binaryOffset = 4 + jsonLength;
  const binary = new DataView(
    buf.buffer,
    buf.byteOffset + binaryOffset,
    buf.byteLength - binaryOffset,
  );
  return { header, binary };
}

export function readEdgesAtIndex(binary: DataView, ref: BinaryRef | undefined, index: number): number[] {
  if (!ref || ref.length === 0) return [];
  const { offset } = ref;
  if (offset + 4 > binary.byteLength) return [];
  const numOffsets = binary.getUint32(offset, false);
  if (index < 0 || index >= numOffsets) return [];

  const offsetsStart = offset + 4;
  const prevOffset = index === 0 ? 0 : binary.getUint32(offsetsStart + (index - 1) * 4, false);
  const edgeCount = binary.getUint32(offsetsStart + index * 4, false) - prevOffset;
  if (edgeCount <= 0) return [];

  const dataStart = offset + 4 + 4 * numOffsets;
  const edges: number[] = [];
  for (let j = 0; j < edgeCount; j++) {
    const pos = dataStart + (prevOffset + j) * 4;
    if (pos + 4 > binary.byteLength) break;
    edges.push(binary.getUint32(pos, false));
  }
  return edges;
}

export function buildFullPaths(sources: AnalyzeSource[]): string[] {
  const cache = new Map<number, string>();
  function getFullPath(index: number): string {
    if (cache.has(index)) return cache.get(index)!;
    const s = sources[index];
    if (!s) {
      cache.set(index, "");
      return "";
    }
    const p =
      s.parent_source_index == null ? s.path : getFullPath(s.parent_source_index) + s.path;
    cache.set(index, p);
    return p;
  }
  return sources.map((_, i) => getFullPath(i));
}

/** Encode edge lists (one list per source index) into the Turbopack edge-table binary. */
export function encodeEdgeTable(lists: number[][]): { ref: BinaryRef; bytes: Buffer } {
  const numOffsets = lists.length;
  const cumulative: number[] = [];
  let total = 0;
  for (const list of lists) {
    total += list.length;
    cumulative.push(total);
  }
  const bytes = Buffer.alloc(4 + 4 * numOffsets + 4 * total);
  bytes.writeUInt32BE(numOffsets, 0);
  for (let i = 0; i < numOffsets; i++) {
    bytes.writeUInt32BE(cumulative[i]!, 4 + i * 4);
  }
  let writeAt = 4 + 4 * numOffsets;
  for (const list of lists) {
    for (const edge of list) {
      bytes.writeUInt32BE(edge, writeAt);
      writeAt += 4;
    }
  }
  return { ref: { offset: 0, length: bytes.byteLength }, bytes };
}

/** Pack a JSON header + binary payload into a `.data` file buffer. */
export function packDataFile(header: unknown, binary: Buffer = Buffer.alloc(0)): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf-8");
  const out = Buffer.alloc(4 + json.byteLength + binary.byteLength);
  out.writeUInt32BE(json.byteLength, 0);
  json.copy(out, 4);
  binary.copy(out, 4 + json.byteLength);
  return out;
}

/**
 * Build a route analyze.data buffer.
 * `sourceChunkParts` maps source index → chunk_part indices.
 * `sourceChildren` maps source index → child source indices.
 */
export function packRouteAnalyzeData(opts: {
  sources: AnalyzeSource[];
  chunkParts: AnalyzeChunkPart[];
  outputFiles: AnalyzeOutputFile[];
  sourceChunkParts: number[][];
  sourceChildren?: number[][];
  sourceRoots?: number[];
}): Buffer {
  const n = opts.sources.length;
  const sourceChunkParts = padLists(opts.sourceChunkParts, n);
  const sourceChildren = padLists(opts.sourceChildren ?? [], n);
  const outputFileChunkParts: number[][] = opts.outputFiles.map(() => []);
  for (let i = 0; i < opts.chunkParts.length; i++) {
    const ofIdx = opts.chunkParts[i]!.output_file_index;
    outputFileChunkParts[ofIdx]?.push(i);
  }

  const tables: Buffer[] = [];
  const refs: {
    source_chunk_parts: BinaryRef;
    source_children: BinaryRef;
    output_file_chunk_parts: BinaryRef;
  } = {
    source_chunk_parts: { offset: 0, length: 0 },
    source_children: { offset: 0, length: 0 },
    output_file_chunk_parts: { offset: 0, length: 0 },
  };

  let offset = 0;
  for (const [key, lists] of [
    ["source_chunk_parts", sourceChunkParts],
    ["source_children", sourceChildren],
    ["output_file_chunk_parts", outputFileChunkParts],
  ] as const) {
    const { ref, bytes } = encodeEdgeTable(lists);
    refs[key] = { offset, length: bytes.byteLength };
    tables.push(bytes);
    offset += bytes.byteLength;
    void ref;
  }

  const header: AnalyzeRouteHeader = {
    sources: opts.sources,
    chunk_parts: opts.chunkParts,
    output_files: opts.outputFiles,
    source_chunk_parts: refs.source_chunk_parts,
    source_children: refs.source_children,
    source_roots: opts.sourceRoots ?? [0],
    output_file_chunk_parts: refs.output_file_chunk_parts,
  };

  return packDataFile(header, Buffer.concat(tables));
}

function padLists(lists: number[][], n: number): number[][] {
  const out = lists.slice(0, n);
  while (out.length < n) out.push([]);
  return out;
}

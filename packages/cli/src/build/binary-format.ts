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
  let header: T;
  try {
    header = JSON.parse(jsonStr) as T;
  } catch (err) {
    throw new Error(`invalid analyze header JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (header === null || typeof header !== "object") {
    throw new Error("invalid analyze header JSON: expected an object");
  }
  validateRefs(header);
  const binaryOffset = 4 + jsonLength;
  const binary = new DataView(
    buf.buffer,
    buf.byteOffset + binaryOffset,
    buf.byteLength - binaryOffset,
  );
  return { header, binary };
}

const REF_KEYS = [
  "source_chunk_parts",
  "source_children",
  "output_file_chunk_parts",
  "module_dependencies",
  "async_module_dependencies",
];

function validateRefs(header: object): void {
  const h = header as Record<string, unknown>;
  for (const key of REF_KEYS) {
    const ref = h[key];
    if (ref === undefined || ref === null) continue;
    const r = ref as Partial<BinaryRef>;
    if (
      typeof ref !== "object" ||
      !Number.isInteger(r.offset) ||
      !Number.isInteger(r.length) ||
      r.offset! < 0 ||
      r.length! < 0
    ) {
      throw new Error(`invalid analyze header: ${key} must have non-negative integer offset and length`);
    }
  }
}

export function readEdgesAtIndex(binary: DataView, ref: BinaryRef | undefined, index: number): number[] {
  if (!ref || ref.length === 0) return [];
  const { offset } = ref;
  if (offset + 4 > binary.byteLength) return [];
  const numOffsets = binary.getUint32(offset, false);
  if (index < 0 || index >= numOffsets) return [];

  const offsetsStart = offset + 4;
  const dataStart = offsetsStart + 4 * numOffsets;
  if (dataStart > binary.byteLength) return [];

  // Cumulative offsets must be monotonic non-decreasing up to `index`.
  let prevOffset = 0;
  let endOffset = 0;
  for (let i = 0; i <= index; i++) {
    const cur = binary.getUint32(offsetsStart + i * 4, false);
    if (cur < prevOffset) return [];
    if (i < index) prevOffset = cur;
    else endOffset = cur;
  }
  const maxEdges = Math.floor((binary.byteLength - dataStart) / 4);
  const edgeCount = Math.min(endOffset, maxEdges) - prevOffset;
  if (edgeCount <= 0) return [];

  const edges: number[] = [];
  for (let j = 0; j < edgeCount; j++) {
    edges.push(binary.getUint32(dataStart + (prevOffset + j) * 4, false));
  }
  return edges;
}

export function buildFullPaths(sources: AnalyzeSource[]): string[] {
  const cache = new Map<number, string>();
  function getFullPath(start: number): string {
    // Walk up the parent chain iteratively; a repeated index means a cycle.
    const chain: number[] = [];
    const seen = new Set<number>();
    let idx: number | null | undefined = start;
    let base = "";
    while (idx != null) {
      const cached = cache.get(idx);
      if (cached !== undefined) {
        base = cached;
        break;
      }
      if (seen.has(idx) || !sources[idx]) break;
      seen.add(idx);
      chain.push(idx);
      idx = sources[idx]!.parent_source_index;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      base += sources[chain[i]!]!.path;
      cache.set(chain[i]!, base);
    }
    if (chain.length === 0 && !cache.has(start)) cache.set(start, base);
    return cache.get(start) ?? base;
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

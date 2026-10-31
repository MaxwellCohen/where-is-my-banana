import { buildDualRouteForest, parseGraphV1Jsonl, type VizGraph } from "@wimb/graph-v1";

export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function validateTrees(trees: unknown, where: string): void {
  if (!isObj(trees)) throw new Error(`Invalid graph: ${where}.trees must be an object`);
  for (const [route, root] of Object.entries(trees)) {
    const stack: unknown[] = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!isObj(n)) throw new Error(`Invalid graph: non-object node in ${where}.trees["${route}"]`);
      if (typeof n.id !== "string" || typeof n.label !== "string") {
        throw new Error(`Invalid graph: node missing id/label in "${route}"`);
      }
      // Older exports may omit byte fields; default them rather than rejecting the file.
      if (n.selfBytes === undefined) n.selfBytes = 0;
      if (n.totalBytes === undefined) n.totalBytes = n.selfBytes;
      if (!isNum(n.totalBytes) || !isNum(n.selfBytes)) {
        throw new Error(`Invalid graph: non-numeric bytes on node "${n.id}" in "${route}"`);
      }
      if (!isNum(n.routeCount)) n.routeCount = 0;
      if (!Array.isArray(n.children)) {
        throw new Error(`Invalid graph: node "${n.id}" in "${route}" has no children array`);
      }
      for (const c of n.children) stack.push(c);
    }
  }
}

function validateRoutes(routes: unknown, where: string): void {
  if (!Array.isArray(routes)) throw new Error(`Invalid graph: ${where}.routes must be an array`);
  for (const r of routes) {
    if (!isObj(r) || typeof r.route !== "string" || !isNum(r.totalBytes)) {
      throw new Error(`Invalid graph: bad route entry in ${where}.routes`);
    }
    if (!isNum(r.moduleCount)) r.moduleCount = 0;
  }
}

/** Deep-validate a parsed forest JSON; throws a friendly Error. */
export function validateVizGraph(value: unknown): VizGraph {
  if (!isObj(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new Error("JSON must be a wimb viz graph (schemaVersion 1 or 2)");
  }
  validateRoutes(value.routes, "graph");
  validateTrees(value.trees, "graph");
  if (!isObj(value.meta)) value.meta = { snapshotName: null, routeCount: 0, selectedRoutes: 0 };
  if (value.sides !== undefined) {
    const sides = value.sides;
    if (!isObj(sides)) throw new Error("Invalid graph: sides must be an object");
    for (const s of ["client", "server"]) {
      const side = sides[s];
      if (!isObj(side)) throw new Error(`Invalid graph: sides.${s} missing`);
      validateRoutes(side.routes, `sides.${s}`);
      validateTrees(side.trees, `sides.${s}`);
    }
  }
  return value as unknown as VizGraph;
}

async function gunzipToText(buf: ArrayBuffer, limit: number): Promise<string> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Browser cannot gunzip this file; upload the unzipped .jsonl or a .json forest");
  }
  const reader = new Response(buf).body!.pipeThrough(new DecompressionStream("gzip")).getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error(
          `File is too large after decompression (over ${Math.round(limit / 1024 / 1024)} MB)`,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("File is too large")) throw err;
    throw new Error("Could not decompress file; is it a valid .gz?");
  }
  return text + decoder.decode();
}

/** Parse a prebuilt forest JSON or analyze-export JSONL (optionally gzipped) in the browser. */
export async function loadGraphFromFile(
  file: File,
  limits: { maxFileBytes?: number; maxDecompressedBytes?: number } = {},
): Promise<VizGraph> {
  const maxFile = limits.maxFileBytes ?? MAX_FILE_BYTES;
  const maxOut = limits.maxDecompressedBytes ?? MAX_DECOMPRESSED_BYTES;
  if (file.size > maxFile) {
    throw new Error(`File is too large (${Math.round(file.size / 1024 / 1024)} MB; limit ${Math.round(maxFile / 1024 / 1024)} MB)`);
  }
  const name = file.name.toLowerCase();
  const buf = await file.arrayBuffer();

  try {
    if (name.endsWith(".json") && !name.endsWith(".jsonl") && !name.includes(".jsonl.")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(buf));
      } catch {
        throw new Error("File is not valid JSON");
      }
      return validateVizGraph(parsed);
    }

    const text =
      name.endsWith(".gz") || name.endsWith(".gzip")
        ? await gunzipToText(buf, maxOut)
        : new TextDecoder().decode(buf);

    return buildDualRouteForest(parseGraphV1Jsonl(text));
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error("Could not read graph file");
  }
}

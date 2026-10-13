import { buildDualRouteForest, parseGraphV1Jsonl, type VizGraph } from "@wimb/graph-v1";

function isVizGraph(value: unknown): value is VizGraph {
  if (!value || typeof value !== "object") return false;
  const g = value as VizGraph;
  return (
    (g.schemaVersion === 1 || g.schemaVersion === 2) &&
    typeof g.trees === "object" &&
    Array.isArray(g.routes)
  );
}

async function gunzipToText(buf: ArrayBuffer): Promise<string> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Browser cannot gunzip this file; upload the unzipped .jsonl or a .json forest");
  }
  const stream = new Response(buf).body!.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** Parse a prebuilt forest JSON or analyze-export JSONL (optionally gzipped) in the browser. */
export async function loadGraphFromFile(file: File): Promise<VizGraph> {
  const name = file.name.toLowerCase();
  const buf = await file.arrayBuffer();

  if (name.endsWith(".json") && !name.endsWith(".jsonl") && !name.includes(".jsonl.")) {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(buf));
    if (!isVizGraph(parsed)) {
      throw new Error("JSON must be a wimb viz graph (schemaVersion 1 or 2)");
    }
    return parsed;
  }

  const text =
    name.endsWith(".gz") || name.endsWith(".gzip")
      ? await gunzipToText(buf)
      : new TextDecoder().decode(buf);

  return buildDualRouteForest(parseGraphV1Jsonl(text));
}

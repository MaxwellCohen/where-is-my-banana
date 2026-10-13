import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseGraphV1Jsonl } from "./parse.js";
import type { ParsedGraph } from "./types.js";

/** Read `.jsonl` or `.jsonl.gz` from disk (Node only). */
export function parseGraphV1File(filePath: string): ParsedGraph {
  const buf = readFileSync(filePath);
  const text = filePath.endsWith(".gz") ? gunzipSync(buf).toString("utf-8") : buf.toString("utf-8");
  return parseGraphV1Jsonl(text);
}

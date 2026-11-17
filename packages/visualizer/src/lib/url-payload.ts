import type { VizGraph } from "./types";
import { validateVizGraph } from "./load-graph";
import { parseWinsReport, type WinsReport } from "./wins";

export interface LaunchPayload {
  graph?: VizGraph;
  wins?: WinsReport;
}

const MAX_SRC_PAYLOAD_BYTES = 200 * 1024 * 1024;
const MAX_INLINE_PAYLOAD_BYTES = 32 * 1024 * 1024;

function fromBase64Url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gunzipText(bytes: Uint8Array, maxBytes: number): Promise<string> {
  const stream = new Response(bytes as BufferSource).body!.pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Launch payload is too large after decompression");
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

export function parseLaunchPayload(parsed: unknown): LaunchPayload {
  if (!parsed || typeof parsed !== "object") throw new Error("Launch payload must be a JSON object");
  const p = parsed as Record<string, unknown>;
  const out: LaunchPayload = {};
  if (p.graph !== undefined) out.graph = validateVizGraph(p.graph);
  if (p.wins !== undefined) out.wins = parseWinsReport(p.wins);
  if (!out.graph && !out.wins) throw new Error("Launch payload has neither graph nor wins");
  return out;
}

/**
 * Read data embedded in the URL fragment.
 * `#d=<base64url(gzip(JSON {graph,wins}))>` carries the data inline (fragments never reach a server);
 * `#src=<URL>` fetches a gzip JSON payload, but only from `http:` on loopback (`wimb open`'s localhost server).
 * `#d=` is capped at a smaller decompressed size than loopback `#src=`.
 * Returns null when the fragment has neither key.
 */
export async function loadLaunchPayloadFromHash(
  hash: string,
  inlineMaxBytes: number = MAX_INLINE_PAYLOAD_BYTES,
): Promise<LaunchPayload | null> {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const d = params.get("d");
  const src = params.get("src");
  try {
    if (d) {
      return parseLaunchPayload(JSON.parse(await gunzipText(fromBase64Url(d), inlineMaxBytes)));
    }
    if (src) {
      const url = new URL(src);
      if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        throw new Error("src must be http on localhost, 127.0.0.1 or [::1]");
      }
      const res = await fetch(url, { redirect: "error" });
      if (!res.ok) throw new Error(`Could not fetch ${src} (${res.status})`);
      const len = Number(res.headers.get("content-length"));
      if (len > MAX_SRC_PAYLOAD_BYTES) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error("Launch payload is too large");
      }
      return parseLaunchPayload(
        JSON.parse(await gunzipText(new Uint8Array(await res.arrayBuffer()), MAX_SRC_PAYLOAD_BYTES)),
      );
    }
  } catch (err) {
    throw new Error(`Could not load data from the URL: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

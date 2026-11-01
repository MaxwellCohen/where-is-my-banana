import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export const DEFAULT_VISUALIZER_URL = "https://wimb-visualizer.vercel.app";
/** Above this many fragment chars, serve the payload from localhost instead of inlining it. */
export const MAX_INLINE_FRAGMENT = 200_000;

export function buildPayload(projectRoot: string): Buffer {
  const dir = join(projectRoot, ".wimb");
  const read = (name: string): unknown => {
    const file = join(dir, name);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : undefined;
  };
  const graph = read("bundle-graph.json");
  const wins = read("wins.json");
  if (!graph && !wins) throw new Error(`no .wimb/bundle-graph.json or .wimb/wins.json in ${projectRoot}; run \`wimb wins\` first`);
  return gzipSync(JSON.stringify({ graph, wins }), { level: 9 });
}

export function inlineUrl(base: string, gz: Buffer): string | null {
  const frag = gz.toString("base64url");
  return frag.length <= MAX_INLINE_FRAGMENT ? `${base.replace(/\/$/, "")}/#d=${frag}` : null;
}

export function launchBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
    : ["xdg-open", [url]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}

/** Serve the payload once on 127.0.0.1 (CORS-open for the visualizer origin) and resolve when fetched or timed out. */
export function serveOnce(
  gz: Buffer,
  base: string,
  onReady: (url: string) => void,
  timeoutMs = 120_000,
): Promise<void> {
  const origin = new URL(base).origin;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET");
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": gz.length });
      res.end(gz, () => {
        clearTimeout(timer);
        server.close(() => resolve());
      });
    });
    const timer = setTimeout(() => server.close(() => resolve()), timeoutMs);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      const src = encodeURIComponent(`http://127.0.0.1:${port}/payload.json.gz`);
      onReady(`${base.replace(/\/$/, "")}/#src=${src}`);
    });
  });
}

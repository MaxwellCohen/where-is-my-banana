import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runLive, writeLive } from "../../src/live/index.js";

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/old") return void res.writeHead(301, { location: "/" }).end();
    if (req.url === "/blocker.js") return void res.writeHead(200, { "content-type": "application/javascript", "content-length": "100000" }).end("x".repeat(100000));
    if (req.url === "/hero.jpg") return void res.writeHead(200, { "content-type": "image/jpeg", "content-length": "300000" }).end(Buffer.alloc(300000));
    const data = JSON.stringify({ props: { pageProps: { entries: Array.from({ length: 4000 }, (_, i) => ({ i, title: "t" + i * 7919 })) } } });
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "visitor=1" });
    res.end(`<!doctype html><html lang="en"><head><title>t</title><meta name="viewport" content="width=device-width"><script src="https://cdn.hotjar.com/h.js"></script><script src="/blocker.js"></script><script id="__NEXT_DATA__" type="application/json">${data}</script></head><body><img src="/hero.jpg" loading="lazy" alt="x"></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

it("audits a deliberately bad page end to end", async () => {
  const out = mkdtempSync(join(tmpdir(), "wimb-live-"));
  try {
    const r = await runLive({ urls: [`${base}/old`], sample: 8, concurrency: 2, timeoutMs: 5000, userAgent: "t", mobile: false, maxRequests: 50, out, json: false, lighthouse: false, lighthouseJson: [] });
    expect(r.errors).toEqual([]);
    const ids = r.findings.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["html-size/inline-data", "headers/no-cache-control", "headers/set-cookie", "scripts/blocking-head", "images/lcp-lazy", "images/oversized", "redirects/chain", "headers/no-compression"]));
    expect(r.pages[0].scripts.find((s) => s.url.endsWith("/blocker.js"))!.bytes).toBe(100000);
    writeLive(r, out);
    expect(JSON.parse(readFileSync(join(out, "live.json"), "utf8")).pages).toHaveLength(1);
    expect(readFileSync(join(out, "live.md"), "utf8")).toContain("Do these first");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

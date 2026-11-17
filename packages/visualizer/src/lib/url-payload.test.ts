import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLaunchPayloadFromHash } from "./url-payload";

const graph = {
  schemaVersion: 2,
  routes: [{ route: "/", totalBytes: 10, moduleCount: 1 }],
  trees: { "/": { id: "a", label: "a", selfBytes: 10, totalBytes: 10, routeCount: 1, children: [] } },
  meta: { snapshotName: null, routeCount: 1, selectedRoutes: 1 },
};

describe("loadLaunchPayloadFromHash", () => {
  it("decodes #d= gzip+base64url", async () => {
    const d = gzipSync(JSON.stringify({ graph })).toString("base64url");
    const p = await loadLaunchPayloadFromHash(`#d=${d}`);
    expect(p?.graph?.routes[0].route).toBe("/");
  });
  it("returns null without keys", async () => {
    expect(await loadLaunchPayloadFromHash("#foo=1")).toBeNull();
  });
  it("rejects non-loopback src (http and https)", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(loadLaunchPayloadFromHash("#src=http://evil.example/")).rejects.toThrow(/localhost/);
    await expect(loadLaunchPayloadFromHash("#src=https://example.com/p.json.gz")).rejects.toThrow(/localhost/);
    await expect(loadLaunchPayloadFromHash("#src=https://localhost:1234/x")).rejects.toThrow(/localhost/);
    expect(f).not.toHaveBeenCalled();
  });
  it.each(["http://127.0.0.1:1234/x", "http://localhost:1234/x", "http://[::1]:1234/x"])("accepts loopback src %s", async (u) => {
    const body = gzipSync(JSON.stringify({ graph }));
    const f = vi.fn(async () => new Response(new Uint8Array(body)));
    vi.stubGlobal("fetch", f);
    const p = await loadLaunchPayloadFromHash(`#src=${u}`);
    expect(p?.graph?.routes[0].route).toBe("/");
    expect(f).toHaveBeenCalledWith(expect.any(URL), { redirect: "error" });
  });
  it("rejects inline payloads over the inline cap", async () => {
    const d = gzipSync(JSON.stringify({ graph, pad: "x".repeat(10_000) })).toString("base64url");
    await expect(loadLaunchPayloadFromHash(`#d=${d}`, 1000)).rejects.toThrow(/too large/);
  });
});

afterEach(() => vi.unstubAllGlobals());

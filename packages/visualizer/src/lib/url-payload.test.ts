import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
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
  it("rejects non-local http src", async () => {
    await expect(loadLaunchPayloadFromHash("#src=http://evil.com/x")).rejects.toThrow(/https, or http on localhost/);
  });
});

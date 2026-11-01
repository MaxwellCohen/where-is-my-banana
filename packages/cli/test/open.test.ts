import { gunzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPayload, inlineUrl, serveOnce } from "../src/open.js";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "wimb-open-"));
  mkdirSync(join(root, ".wimb"));
  writeFileSync(join(root, ".wimb/bundle-graph.json"), JSON.stringify({ schemaVersion: 2, routes: [], trees: {} }));
  return root;
}

describe("open", () => {
  it("round-trips an inline fragment", () => {
    const gz = buildPayload(project());
    const url = inlineUrl("https://x.test/", gz)!;
    const d = url.split("#d=")[1];
    expect(JSON.parse(gunzipSync(Buffer.from(d, "base64url")).toString()).graph.schemaVersion).toBe(2);
  });
  it("throws without data", () => {
    expect(() => buildPayload(mkdtempSync(join(tmpdir(), "wimb-empty-")))).toThrow(/wimb wins/);
  });
  it("serves once with CORS", async () => {
    const gz = buildPayload(project());
    await serveOnce(gz, "https://x.test", async (url) => {
      const src = decodeURIComponent(new URL(url).hash.split("#src=")[1]);
      const res = await fetch(src);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://x.test");
      expect(Buffer.from(await res.arrayBuffer()).equals(gz)).toBe(true);
    });
  });
});

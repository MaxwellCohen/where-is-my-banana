import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { attributeRoutes } from "../../src/wins/attribute.js";
import { synGraph } from "../helpers-graph.js";

let root: string;
const NEXTJS = "node_modules/@sentry/nextjs";
const REPLAY = "node_modules/@sentry/replay";
const write = (rel: string, src: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), src);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "wins-injdeps-"));
  write(`${NEXTJS}/package.json`, JSON.stringify({ name: "@sentry/nextjs", dependencies: { "@sentry/replay": "1" } }));
  write(`${REPLAY}/package.json`, JSON.stringify({ name: "@sentry/replay" }));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Re-exports collapsed: the graph shows SentryInit -> replay directly and instrumentation-client -> nextjs only.
const mods = {
  page: { path: "app/SentryInit.tsx", sync: ["nx", "rp"] },
  instr: { path: "instrumentation-client.ts", sync: ["nx"] },
  nx: { path: `${NEXTJS}/index.js` },
  rp: { path: `${REPLAY}/index.js` },
};
const routes = { "/": { seeds: ["page"], bytes: { "app/SentryInit.tsx": 100, "instrumentation-client.ts": 100, [`${NEXTJS}/index.js`]: 5000, [`${REPLAY}/index.js`]: 38000 } } };

describe("injected entry + declared dependencies", () => {
  it("zeroes a cut into a package declared by a package the injected entry reaches", () => {
    const [a] = attributeRoutes(synGraph(mods, routes), { projectRoot: root });
    const e = a!.edges.find((x) => x.edge.imported === `${REPLAY}/index.js`)!;
    expect(e.uniqueBytes).toBe(0);
    expect(e.alsoReachableVia?.[0]?.[0]).toBe("instrumentation-client.ts");
  });

  it("keeps the full bytes without projectRoot or a declared dependency", () => {
    const [a] = attributeRoutes(synGraph(mods, routes));
    expect(a!.edges.find((x) => x.edge.imported === `${REPLAY}/index.js`)!.uniqueBytes).toBe(38000);
  });
});

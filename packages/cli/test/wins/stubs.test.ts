import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectStubWins } from "../../src/wins/stubs.js";
import { formatWinsMarkdown } from "../../src/wins/output.js";
import { buildItems } from "../../src/speed/merge.js";
import { synGraph } from "../helpers-graph.js";

let root: string;
const write = (rel: string, src: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), src);
};

const A = "node_modules/feature-kit";
const P = "node_modules/vwo-fme-node-sdk";
const mods = {
  page: { path: "app/page.tsx", sync: ["kitIndex"] },
  kitIndex: { path: `${A}/dist/index.js`, sync: ["kitUi", "kitServer"] },
  kitUi: { path: `${A}/dist/ui.js` },
  kitServer: { path: `${A}/dist/server.js`, sync: ["sdk"] },
  sdk: { path: `${P}/dist/index.js` },
};
const route = {
  "/": {
    seeds: ["page"],
    bytes: { "app/page.tsx": 500, [`${A}/dist/index.js`]: 200, [`${A}/dist/ui.js`]: 3000, [`${A}/dist/server.js`]: 100, [`${P}/dist/index.js`]: 80000 },
  },
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "wins-stubs-"));
  write(`${A}/package.json`, JSON.stringify({ name: "feature-kit", sideEffects: false }));
  write(`${P}/package.json`, JSON.stringify({ name: "vwo-fme-node-sdk" }));
  write(`${P}/dist/index.js`, `const fs = require("fs"); module.exports = {};`);
  write(`${A}/dist/index.js`, `export * from "./ui.js";\nexport { vwoInit } from "./server.js";\n`);
  write(`${A}/dist/server.js`, `import { init } from "vwo-fme-node-sdk"; export const vwoInit = () => init();`);
  write("app/ok.tsx", `import { Button } from "feature-kit";\nexport default () => Button;`);
  write("app/uses.tsx", `import { vwoInit } from "feature-kit";\nexport default () => vwoInit;`);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

// The barrel (kitIndex) re-exports the SDK directly; kitServer is unused in these graphs.
const barrelMods = (appFile: string) => ({
  ...mods,
  page: { path: appFile, sync: ["kitIndex"] },
  kitIndex: { path: `${A}/dist/index.js`, sync: ["kitUi", "sdk"] },
  kitServer: { path: `${A}/dist/server.js` },
});

describe("detectStubWins", () => {
  it("sideEffects:false barrel pulling a node-only SDK the app does not use -> client-stub finding", () => {
    write(`${A}/dist/index.js`, `export * from "./ui.js";\nexport { init, Client } from "vwo-fme-node-sdk";\n`);
    const g = synGraph(barrelMods("app/ok.tsx"), {
      "/": { seeds: ["page"], bytes: { ...route["/"].bytes, "app/ok.tsx": 500 } },
    });
    const wins = detectStubWins(g, { projectRoot: root });
    expect(wins).toHaveLength(1);
    const w = wins[0];
    expect(w.fixKind).toBe("stub-alias");
    expect(w.safety).toBe("needs-review");
    expect(w.safetyReasons).toEqual(["client-stub"]);
    expect(w.edge.packageName).toBe("vwo-fme-node-sdk");
    expect(w.totalSavedBytes).toBe(80000);
    expect(w.confidence).toBe("high");
    expect(w.chain).toEqual(["app/ok.tsx", `${A}/dist/index.js`, `${P}/dist/index.js`]);
    expect(w.stub!.turbopackConfig).toContain("resolveAlias");
    expect(w.stub!.turbopackConfig).toContain("browser:");
    expect(w.stub!.webpackConfig).toContain("!isServer");
    expect(w.stub!.stubContent).toContain("new Proxy");
    expect(w.stub!.signals).toContain("node-in-name");
    const md = formatWinsMarkdown({ version: "2", timestamp: "", projectRoot: root, byteSource: "measured", routes: [{ route: "/", firstLoadBytes: 84000 }], wins: wins });
    expect(md).toContain("resolveAlias");
    expect(md).toContain("stubs/vwo-fme-node-sdk.js");
    const items = buildItems({ wins: { wins: wins as never } });
    expect(items[0].theme).toBe("JS bundle");
    expect(items[0].risk).toBe("needs-review");
    expect(items[0].owner).toBe("code");
  });

  it("sideEffects:false package that imports (not re-exports) the SDK inside a function -> low-confidence candidate", () => {
    const g = synGraph(
      { ...mods, page: { path: "app/ok.tsx", sync: ["kitIndex"] } },
      { "/": { seeds: ["page"], bytes: { ...route["/"].bytes, "app/ok.tsx": 500 } } },
    );
    const wins = detectStubWins(g, { projectRoot: root });
    expect(wins).toHaveLength(1);
    expect(wins[0]!.stub!.package).toBe("vwo-fme-node-sdk");
    expect(wins[0]!.confidence).toBe("low");
  });

  it("negative: the app genuinely imports an export that re-exports the SDK", () => {
    write(`${A}/dist/index.js`, `export * from "./ui.js";\nexport { init, Client } from "vwo-fme-node-sdk";\n`);
    const g = synGraph(barrelMods("app/uses.tsx"), {
      "/": { seeds: ["page"], bytes: { ...route["/"].bytes, "app/uses.tsx": 500 } },
    });
    write("app/uses.tsx", `import { init } from "feature-kit";\nexport default () => init;`);
    expect(detectStubWins(g, { projectRoot: root })).toEqual([]);
  });

  it("barrel not marked sideEffects:false still yields a medium-confidence candidate", () => {
    write(`${A}/package.json`, JSON.stringify({ name: "feature-kit" }));
    write(`${A}/dist/index.js`, `export * from "./ui.js";\nexport { init } from "vwo-fme-node-sdk";\n`);
    const g = synGraph(barrelMods("app/ok.tsx"), { "/": { seeds: ["page"], bytes: { ...route["/"].bytes, "app/ok.tsx": 500 } } });
    const wins = detectStubWins(g, { projectRoot: root });
    expect(wins).toHaveLength(1);
    expect(wins[0].confidence).toBe("medium");
    expect(wins[0].safety).toBe("needs-review");
    write(`${A}/package.json`, JSON.stringify({ name: "feature-kit", sideEffects: false }));
  });

  it("app code importing the node-only package itself -> medium-confidence candidate", () => {
    write(`${A}/dist/index.js`, `export { init } from "vwo-fme-node-sdk";\n`);
    const g = synGraph(
      { ...barrelMods("app/ok.tsx"), page: { path: "app/ok.tsx", sync: ["kitIndex", "sdk"] } },
      { "/": { seeds: ["page"], bytes: { ...route["/"].bytes, "app/ok.tsx": 500 } } },
    );
    const wins = detectStubWins(g, { projectRoot: root });
    expect(wins).toHaveLength(1);
    expect(wins[0].confidence).toBe("medium");
    expect(wins[0].edge.importer).toBe("app/ok.tsx");
    expect(wins[0].edit.replacementImport).toContain("resolveAlias");
  });

  it("package without a browser mapping that imports node builtins (https) is a candidate; with `browser` it is not", () => {
    const Q = "node_modules/acme-core";
    write(`${Q}/package.json`, JSON.stringify({ name: "acme-core", main: "index.js" }));
    write(`${Q}/index.js`, `const https = require("https"); module.exports = https;`);
    const qm = { page: { path: "app/ok.tsx", sync: ["q"] }, q: { path: `${Q}/index.js` } };
    const g = synGraph(qm, { "/": { seeds: ["page"], bytes: { "app/ok.tsx": 500, [`${Q}/index.js`]: 62000 } } });
    const wins = detectStubWins(g, { projectRoot: root });
    expect(wins).toHaveLength(1);
    expect(wins[0].stub!.signals).toContain("node-builtins-no-browser");
    expect(wins[0].confidence).toBe("medium");
    write(`${Q}/package.json`, JSON.stringify({ name: "acme-core", main: "index.js", browser: { "./index.js": "./browser.js" } }));
    expect(detectStubWins(g, { projectRoot: root })).toEqual([]);
  });

  it("name containing -server is a strong signal", () => {
    const Q = "node_modules/acme-flags-server";
    write(`${Q}/package.json`, JSON.stringify({ name: "acme-flags-server" }));
    write(`${Q}/index.js`, `module.exports = {};`);
    const g = synGraph(
      { page: { path: "app/ok.tsx", sync: ["q"] }, q: { path: `${Q}/index.js` } },
      { "/": { seeds: ["page"], bytes: { "app/ok.tsx": 500, [`${Q}/index.js`]: 30000 } } },
    );
    const wins = detectStubWins(g, { projectRoot: root });
    expect(wins).toHaveLength(1);
    expect(wins[0].stub!.signals).toContain("server-in-name");
  });
});

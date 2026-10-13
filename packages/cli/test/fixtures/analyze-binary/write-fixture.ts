/**
 * Writes a synthetic Next.js Turbopack experimental-analyze binary fixture
 * matching the format of `.next/diagnostics/analyze/data/`.
 *
 * Run: npx tsx packages/cli/test/fixtures/analyze-binary/write-fixture.ts
 * Or import writeAnalyzeBinaryFixture() from tests.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packDataFile, packRouteAnalyzeData } from "../../../src/build/binary-format.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export function writeAnalyzeBinaryFixture(outDir: string = HERE): string {
  const dataDir = join(outDir, "data");
  mkdirSync(join(dataDir, "about"), { recursive: true });

  // modules.data — global module registry
  const modulesData = packDataFile({
    modules: [
      { ident: "[project]/app/page.tsx", path: "[project]/app/page.tsx" },
      { ident: "[project]/app/about/page.tsx", path: "[project]/app/about/page.tsx" },
      {
        ident: "[project]/node_modules/lodash/index.js",
        path: "[project]/node_modules/lodash/index.js",
      },
      {
        ident: "[project]/node_modules/tiny-pkg/index.js",
        path: "[project]/node_modules/tiny-pkg/index.js",
      },
    ],
  });
  writeFileSync(join(dataDir, "modules.data"), modulesData);

  writeFileSync(join(dataDir, "routes.json"), JSON.stringify(["/", "/about"]));

  // Route "/" — page + lodash in client JS
  const homeAnalyze = packRouteAnalyzeData({
    sources: [
      { path: "[project]/" },
      { path: "app/", parent_source_index: 0 },
      { path: "page.tsx", parent_source_index: 1 },
      { path: "node_modules/", parent_source_index: 0 },
      { path: "lodash/", parent_source_index: 3 },
      { path: "index.js", parent_source_index: 4 },
      { path: "tiny-pkg/", parent_source_index: 3 },
      { path: "index.js", parent_source_index: 6 },
    ],
    chunkParts: [
      {
        source_index: 2,
        output_file_index: 0,
        size: 2400,
        compressed_size: 800,
      },
      {
        source_index: 5,
        output_file_index: 0,
        size: 72_000,
        compressed_size: 24_000,
      },
      {
        source_index: 7,
        output_file_index: 0,
        size: 1200,
        compressed_size: 400,
      },
      // server-only chunk (should not pollute client module sizes when client flags exist)
      {
        source_index: 2,
        output_file_index: 1,
        size: 500,
        compressed_size: 200,
      },
    ],
    outputFiles: [
      { filename: "[client-fs]/static/chunks/app/page.js" },
      { filename: "[project]/server/app/page.js" },
    ],
    sourceChunkParts: [
      [], // 0
      [], // 1
      [0, 3], // page.tsx → client + server parts
      [], // 3
      [], // 4
      [1], // lodash
      [], // 6
      [2], // tiny-pkg
    ],
    sourceChildren: [[1, 3], [2], [], [4, 6], [5], [], [7], []],
    sourceRoots: [0],
  });
  writeFileSync(join(dataDir, "analyze.data"), homeAnalyze);

  // Route "/about" — smaller page, no lodash
  const aboutAnalyze = packRouteAnalyzeData({
    sources: [
      { path: "[project]/" },
      { path: "app/", parent_source_index: 0 },
      { path: "about/", parent_source_index: 1 },
      { path: "page.tsx", parent_source_index: 2 },
    ],
    chunkParts: [
      {
        source_index: 3,
        output_file_index: 0,
        size: 1800,
        compressed_size: 600,
      },
    ],
    outputFiles: [{ filename: "[client-fs]/static/chunks/app/about/page.js" }],
    sourceChunkParts: [[], [], [], [0]],
    sourceChildren: [[1], [2], [3], []],
    sourceRoots: [0],
  });
  writeFileSync(join(dataDir, "about", "analyze.data"), aboutAnalyze);

  return dataDir;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("write-fixture.ts")) {
  const dir = writeAnalyzeBinaryFixture();
  console.log(`Wrote analyze binary fixture to ${dir}`);
}

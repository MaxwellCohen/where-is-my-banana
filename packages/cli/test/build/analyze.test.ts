import { describe, it, expect, beforeAll } from "vitest";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  parseBinaryAnalyzeDir,
  normalizeModulePath,
  packageNameFromPath,
  hasAnalyzeArtifacts,
  runBuildAnalysis,
} from "../../src/build/analyze.js";
import { writeAnalyzeBinaryFixture } from "../fixtures/analyze-binary/write-fixture.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/analyze-binary");

describe("normalizeModulePath", () => {
  it("strips Turbopack virtual prefixes", () => {
    expect(normalizeModulePath("[project]/app/page.tsx")).toBe("app/page.tsx");
    expect(normalizeModulePath("[client-fs]/static/chunks/x.js")).toBe("static/chunks/x.js");
  });
});

describe("packageNameFromPath", () => {
  it("extracts scoped and unscoped package names", () => {
    expect(packageNameFromPath("node_modules/lodash/index.js")).toBe("lodash");
    expect(packageNameFromPath("app/node_modules/@radix-ui/react-dialog/dist/index.js")).toBe(
      "@radix-ui/react-dialog",
    );
    expect(packageNameFromPath("app/page.tsx")).toBeNull();
  });
});

describe("parseBinaryAnalyzeDir", () => {
  beforeAll(() => {
    writeAnalyzeBinaryFixture(FIXTURE_DIR);
  });

  it("attributes route and module compressed sizes from binary analyze.data", () => {
    const dataDir = join(FIXTURE_DIR, "data");
    const attribution = parseBinaryAnalyzeDir(dataDir);

    expect(attribution.measured).toBe(true);
    expect(attribution.routes.get("/")).toBeGreaterThan(0);
    expect(attribution.routes.get("/about")).toBe(600);

    // lodash compressed size from home route
    expect(attribution.modules.get("lodash")).toBe(24_000);
    expect(attribution.modules.get("node_modules/lodash/index.js")).toBe(24_000);

    // page.tsx client compressed size (server part excluded from client module map)
    expect(attribution.modules.get("app/page.tsx")).toBe(800);
  });

  it("detects analyze artifacts under distDir/diagnostics/analyze/data", () => {
    const distDir = mkdtempSync(join(tmpdir(), "wimb-has-analyze-"));
    try {
      writeAnalyzeBinaryFixture(join(distDir, "diagnostics", "analyze"));
      expect(hasAnalyzeArtifacts(distDir)).toBe(true);
    } finally {
      rmSync(distDir, { recursive: true, force: true });
    }
  });
});

describe("runBuildAnalysis", () => {
  it("parses existing binary artifacts with skipBuild", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "wimb-analyze-"));
    try {
      const distDir = join(projectRoot, ".next");
      writeAnalyzeBinaryFixture(join(distDir, "diagnostics", "analyze"));
      const attribution = await runBuildAnalysis({
        projectRoot,
        distDir,
        skipBuild: true,
      });
      expect(attribution).not.toBeNull();
      expect(attribution!.measured).toBe(true);
      expect(attribution!.routes.has("/")).toBe(true);
      expect(attribution!.modules.get("lodash")).toBe(24_000);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("falls back to legacy JSON analyze files", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "wimb-legacy-"));
    try {
      const analyzeDir = join(projectRoot, ".next", "diagnostics", "analyze");
      mkdirSync(analyzeDir, { recursive: true });
      writeFileSync(
        join(analyzeDir, "home.json"),
        JSON.stringify({
          route: "/",
          size: 12_345,
          modules: [{ name: "lodash", size: 9_999 }],
        }),
      );
      const attribution = await runBuildAnalysis({
        projectRoot,
        distDir: join(projectRoot, ".next"),
        skipBuild: true,
      });
      expect(attribution?.routes.get("/")).toBe(12_345);
      expect(attribution?.modules.get("lodash")).toBe(9_999);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

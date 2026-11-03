import { describe, it, expect } from "vitest";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAudit, collectFindings } from "../../src/audit/index.js";
import { applyFixes } from "../../src/audit/fix.js";
import { formatAuditMarkdown } from "../../src/audit/output.js";

const FIXTURE = resolve(__dirname, "../fixtures/cms-site");
const report = runAudit({ projectRoot: FIXTURE });
const has = (id: string, file: string) => report.findings.some((f) => f.id === id && f.file === file);

describe("cms-site fixture (bad area)", () => {
  const expected: [string, string][] = [
    ["third-party-script/no-strategy", "app/layout.tsx"],
    ["third-party-script/before-interactive", "app/layout.tsx"],
    ["raw-img", "components/blocks/Gallery.tsx"],
    ["raw-img", "components/blocks/RichText.tsx"],
    ["raw-img", "components/blocks/Carousel.tsx"],
    ["lcp-priority", "components/blocks/Hero.tsx"],
    ["image-config/formats", "next.config.js"],
    ["cms-image-params", "components/blocks/RichText.tsx"],
    ["cms-image-params", "lib/cms.ts"],
    ["fonts/google-link", "app/layout.tsx"],
    ["fonts/google-link", "app/globals.css"],
    ["fonts/display", "app/fonts.ts"],
    ["fonts/too-many-files", "app/fonts.ts"],
    ["force-dynamic/segment-config", "app/[...slug]/page.tsx"],
    ["force-dynamic/no-store", "app/[...slug]/page.tsx"],
    ["missing-static-params", "app/[...slug]/page.tsx"],
    ["sequential-await", "app/[...slug]/page.tsx"],
    ["full-cms-payload-to-client", "app/[...slug]/page.tsx"],
    ["heavy-deps/moment", "package.json"],
    ["heavy-deps/lodash", "package.json"],
    ["heavy-deps/framer-motion", "package.json"],
    ["heavy-deps/cms-sdk-client", "components/blocks/Carousel.tsx"],
    ["old-browserslist/legacy-target", "package.json"],
    ["maps-widgets/layout-script", "app/layout.tsx"],
    ["maps-widgets", "components/layout/Footer.tsx"],
    ["maps-widgets/iframe", "components/blocks/VideoPlayer.tsx"],
    ["middleware-scope", "middleware.ts"],
    ["preview-code-in-prod", "app/layout.tsx"],
    ["ssr-false-misuse", "components/blocks/registry.tsx"],
    ["split-candidate/heavy-cluster", "components/blocks/LocationsDashboard.tsx"],
  ];
  it.each(expected)("%s in %s", (id, file) => {
    expect(has(id, file), `${id} @ ${file}`).toBe(true);
  });
  it("covers every check", () => {
    const checks = new Set(report.findings.map((f) => f.check));
    // use-client-inventory is info-only and needs >=10 client files per bucket
    expect([...checks].length).toBeGreaterThanOrEqual(18);
  });
  it("explains how to split the god component", () => {
    const f = report.findings.find((x) => x.id === "split-candidate/heavy-cluster" && x.file === "components/blocks/LocationsDashboard.tsx")!;
    expect(f.severity).toBe("high");
    expect(f.evidence!.clusters.map((c) => c.name).sort()).toEqual(["CallbackForm", "LocationsTable", "RevenueChart"]);
    expect(f.evidence!.uniqueHeavy).toEqual(["recharts"]);
    expect(f.fix).toContain("RevenueChart.tsx");
    expect(f.fix).toContain("next/dynamic");
    expect(f.fix).toContain("thin composer");
    expect(f.fix).not.toContain("ssr: false");
  });
  it("lists it under Files worth breaking up", () => {
    expect(formatAuditMarkdown(report)).toMatch(/## Files worth breaking up[\s\S]*LocationsDashboard\.tsx[\s\S]*recharts/);
  });
  it("skips stories, tests and .d.ts", () => {
    expect(report.findings.filter((f) => /\.stories\.|\.test\.|\.d\.ts$/.test(f.file))).toEqual([]);
  });
  it("scores every finding", () => {
    for (const f of report.findings) {
      expect(f.impactScore).toBeGreaterThanOrEqual(0);
      expect(f.impactScore).toBeLessThanOrEqual(100);
      expect(["S", "M", "L"]).toContain(f.effort);
    }
  });
});

describe("cms-site fixture (clean area)", () => {
  it("has no findings in the (good) area", () => {
    const bad = report.findings.filter((f) => /\(good\)|components\/good\/|lib\/good-cms/.test(f.file));
    expect(bad).toEqual([]);
  });
});

describe("cms-site fixture autofix", () => {
  it("fixes safely, reports consent, and is idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "wimb-cms-"));
    cpSync(FIXTURE, root, { recursive: true });
    const first = applyFixes(root, collectFindings({ projectRoot: root }).findings);
    const layout = readFileSync(join(root, "app/layout.tsx"), "utf-8");
    expect(layout).toContain('strategy="lazyOnload"'); // gtm + chat
    expect(layout).toMatch(/cookielaw[^>]*strategy="beforeInteractive"/); // consent untouched
    expect(first.skipped.some((s) => /consent/.test(s.reason))).toBe(true);
    expect(readFileSync(join(root, "app/fonts.ts"), "utf-8")).toContain('display: "swap"');
    expect(readFileSync(join(root, "components/blocks/registry.tsx"), "utf-8")).not.toContain("ssr: false");
    expect(readFileSync(join(root, "next.config.js"), "utf-8")).toContain("image/avif");
    expect(readFileSync(join(root, "components/blocks/Hero.tsx"), "utf-8")).toContain("<Image priority");
    expect(readFileSync(join(root, "components/blocks/Gallery.tsx"), "utf-8")).toContain('loading="lazy" decoding="async"');
    const second = applyFixes(root, collectFindings({ projectRoot: root }).findings, { dryRun: true });
    expect(second.changes).toEqual([]);
  });
});

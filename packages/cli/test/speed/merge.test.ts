import { describe, it, expect } from "vitest";
import { buildItems, comparePlans, pageTypeOf, pageTypes, sectionize, speedBudget } from "../../src/speed/merge.js";
import type { RawFinding, RawWin } from "../../src/speed/types.js";

const tp = (file: string, msg = "Raw <script> tag loads a third-party script", id = "third-party-script/raw-script"): RawFinding => ({
  id, check: "third-party-script", severity: "medium", file, line: 3, message: msg, fix: "Use next/script strategy=lazyOnload",
});
const win = (importer: string, imported: string, bytes: number, safety = "safe"): RawWin => ({
  id: `lazy:${importer}:${imported}`, fixKind: "lazy", safety, edge: { importer, imported, packageName: null },
  totalSavedBytes: bytes, byteSource: "measured", routes: { "/": bytes },
  edit: { summary: `Lazy-load ${imported}`, steps: ["use next/dynamic"], verify: "wimb wins --compare" },
});

describe("speed merge", () => {
  it("dedupes related audit findings into one item with all locations", () => {
    const items = buildItems({ audit: { findings: [tp("a.tsx"), tp("b.tsx"), tp("c.tsx")] } });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Defer 3 third-party scripts");
    expect(items[0].files).toEqual(["a.tsx", "b.tsx", "c.tsx"]);
    expect(items[0].count).toBe(3);
    expect(items[0].theme).toBe("Third parties");
    expect(items[0].exactInstructions.join("\n")).toContain("b.tsx:3");
  });

  it("corroborates static + live from the same vendor into one higher-scored item", () => {
    const audit = [tp("layout.tsx", "Raw script loads https://www.googletagmanager.com/gtm.js")];
    const base = buildItems({ audit: { findings: audit } })[0].impactScore;
    const live: RawFinding[] = [{
      id: "blocking-third-party", check: "blocking-third-party-script", severity: "high", url: "https://x.com/",
      message: "Blocking script from googletagmanager.com", fix: "Load async", owner: "code",
    }];
    const items = buildItems({ audit: { findings: audit }, live: { findings: live } });
    expect(items).toHaveLength(1);
    expect(items[0].corroborated).toBe(true);
    expect(items[0].sources).toEqual(["audit", "live"]);
    expect(items[0].impactScore).toBeGreaterThan(base);
    expect(items[0].urls).toEqual(["https://x.com/"]);
    expect(items[0].why).toContain("Google Tag Manager");
  });

  it("does not merge a live finding of a different vendor or theme", () => {
    const audit = [tp("layout.tsx", "Raw script loads https://www.googletagmanager.com/gtm.js")];
    const live: RawFinding[] = [
      { id: "a", check: "blocking-third-party-script", severity: "high", url: "https://x.com/", message: "Blocking hotjar.com script", fix: "f", owner: "code" },
      { id: "b", check: "slow-ttfb", severity: "medium", url: "https://x.com/", message: "TTFB 1.8s", fix: "f", owner: "code" },
    ];
    expect(buildItems({ audit: { findings: audit }, live: { findings: live } })).toHaveLength(3);
  });

  it("routes owner: gtm/cdn/cms live findings stay separate, never merge into code items", () => {
    const live: RawFinding[] = [
      { id: "g", check: "gtm-tags", severity: "high", url: "https://x.com/", message: "GTM fires 14 tags on load", fix: "Pause unused tags", owner: "gtm" },
      { id: "c", check: "cache-control", severity: "medium", url: "https://x.com/a", message: "No cache headers", fix: "Add s-maxage", owner: "cdn" },
    ];
    const items = buildItems({ audit: { findings: [tp("a.tsx")] }, live: { findings: live } });
    expect(items.map((i) => i.owner).sort()).toEqual(["cdn", "code", "gtm"]);
    const sec = sectionize(items, 10);
    expect(sec.notCode.map((i) => i.owner).sort()).toEqual(["cdn", "gtm"]);
    expect(sec.notCode.find((i) => i.owner === "gtm")!.exactInstructions[0]).toContain("Google Tag Manager");
    expect(sec.doFirst.map((i) => i.owner)).toEqual(["code"]);
  });

  it("routes decisions: force-dynamic and needs-review wins go to decision, not do-first", () => {
    const items = buildItems({
      audit: { findings: [{ id: "force-dynamic/no-store", check: "force-dynamic", severity: "high", file: "app/p/page.tsx", line: 1, message: "m", fix: "f" }] },
      wins: { wins: [win("a.tsx", "Chart.tsx", 90_000, "needs-review"), win("b.tsx", "Map.tsx", 90_000, "safe")] },
    });
    const sec = sectionize(items, 10);
    expect(sec.decision.map((i) => i.title).sort()).toEqual(["Lazy-load Chart.tsx", "Restore static/ISR rendering on 1 route"]);
    expect(sec.doFirst.map((i) => i.title)).toEqual(["Lazy-load Map.tsx"]);
  });

  it("ranks by impactScore/effort and assigns sequential ranks", () => {
    const items = buildItems({
      audit: { findings: [
        { id: "heavy-deps/cms-sdk", check: "heavy-deps", severity: "high", file: "package.json", line: 1, message: "m", fix: "f", effort: "L", impactScore: 90 },
        { id: "fonts/display", check: "fonts", severity: "low", file: "a.css", line: 1, message: "m", fix: "f", effort: "S", impactScore: 40 },
      ] },
    });
    expect(items.map((i) => i.key)).toEqual(["audit:fonts", "audit:heavy-deps/cms-sdk"]);
    expect(items.map((i) => i.rank)).toEqual([1, 2]);
  });

  it("uses audit-provided impactScore/effort when present", () => {
    const [i] = buildItems({ audit: { findings: [{ ...tp("a.tsx"), impactScore: 77, effort: "L" }] } });
    expect(i.effort).toBe("L");
    expect(i.impactScore).toBe(77);
  });

  it("tolerates missing/garbage input", () => {
    expect(buildItems({})).toEqual([]);
    expect(buildItems({ audit: {}, wins: { wins: [{}] }, live: { findings: [null as never, {}] } })).toEqual([]);
    expect(buildItems({ audit: { findings: [{ check: "mystery", message: "x" }] } })[0].title).toBe("mystery: 1 finding");
  });

  it("speed budget separates measured from rough", () => {
    const items = buildItems({ audit: { findings: [tp("a.tsx")] }, wins: { wins: [win("a.tsx", "Chart.tsx", 51_200)] } });
    const b = speedBudget(items);
    expect(b.find((x) => x.theme === "JS bundle")).toMatchObject({ kb: 50, basis: "measured" });
    expect(b.find((x) => x.theme === "Third parties")!.basis).toBe("rough");
  });

  it("page types group live findings by url shape", () => {
    expect(pageTypeOf("https://x.com/")).toBe("home (/)");
    expect(pageTypeOf("https://x.com/blog/a")).toBe("/blog/*");
    const rows = pageTypes([
      { url: "https://x.com/", check: "a", severity: "high" },
      { url: "https://x.com/blog/1", check: "b", severity: "low" },
      { url: "https://x.com/blog/2", check: "b", severity: "medium" },
    ]);
    expect(rows[0]).toMatchObject({ type: "home (/)", high: 1, urls: 1 });
    expect(rows[1]).toMatchObject({ type: "/blog/*", urls: 2, medium: 1, low: 1, topIssue: "b" });
  });
});

describe("comparePlans", () => {
  it("reports resolved, new, regressed", () => {
    const cur = buildItems({ audit: { findings: [tp("a.tsx"), tp("b.tsx"), { id: "fonts/display", check: "fonts", severity: "low", file: "x.css", line: 1, message: "m", fix: "f" }] } });
    const prev = {
      items: [
        { key: "audit:third-party-script", impactScore: 10, count: 1, title: "t" },
        { key: "audit:raw-img", title: "Replace raw img", theme: "Images" },
      ],
    };
    const c = comparePlans(prev, cur);
    expect(c.resolved.map((x) => x.key)).toEqual(["audit:raw-img"]);
    expect(c.new.map((x) => x.key)).toEqual(["audit:fonts"]);
    expect(c.regressed.map((x) => x.key)).toEqual(["audit:third-party-script"]);
  });
  it("handles null prev", () => {
    expect(comparePlans(null, []).unchanged).toBe(0);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSample, parseUrlFlag, runSpeed } from "../../src/speed/index.js";
import { FlagError } from "../../src/index-flags.js";

const fixturesDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures");
const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "wimb-speed-"));
  tmps.push(d);
  return d;
}
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });

const finding = (file: string) => ({
  id: "third-party-script/raw-script", check: "third-party-script", severity: "high", file, line: 1,
  message: "Raw script https://www.googletagmanager.com/gtm.js", fix: "use next/script lazyOnload",
});

describe("runSpeed", () => {
  it("end to end on a fixture with --no-wins --no-live (real static audit)", async () => {
    const root = tmp();
    const fx = existsSync(join(fixturesDir, "cms-site")) ? "cms-site" : "e2e-app";
    cpSync(join(fixturesDir, fx), root, { recursive: true });
    const r = await runSpeed({ projectRoot: root, wins: false, live: false });
    expect(r.plan.inputs).toEqual({ audit: true, wins: false, live: false });
    expect(existsSync(join(root, ".wimb", "plan.json"))).toBe(true);
    const md = readFileSync(join(root, ".wimb", "plan.md"), "utf-8");
    for (const h of ["Do first (code, safe)", "Needs a human decision", "Not code", "Later", "Handoff prompt"]) expect(md).toContain(h);
    expect(r.plan.agentPrompt).toContain("Make this website faster");
    expect(r.exitCode).toBe(0);
  });

  it("merges audit + wins + live fixtures, writes plan, honors --fail-on and prompt inlines top items", async () => {
    const root = tmp();
    mkdirSync(join(root, ".wimb"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
    writeFileSync(join(root, ".wimb", "wins.json"), JSON.stringify({ wins: [{
      id: "w1", fixKind: "lazy", safety: "safe", edge: { importer: "a.tsx", imported: "Chart.tsx", packageName: null },
      totalSavedBytes: 80_000, byteSource: "measured", edit: { summary: "Lazy-load Chart", steps: ["dynamic()"], verify: "v" },
    }] }));
    writeFileSync(join(root, ".wimb", "live.json"), JSON.stringify({ findings: [
      { id: "x", check: "gtm-tags", severity: "high", url: "https://s.com/", message: "14 GTM tags", fix: "pause tags", owner: "gtm" },
    ] }));
    const r = await runSpeed({
      projectRoot: root, urls: ["https://s.com/"], failOn: "high", compare: true,
      audit: () => ({ findings: [finding("app/layout.tsx")] }),
      exec: () => undefined,
    });
    expect(r.plan.inputs).toEqual({ audit: true, wins: true, live: true });
    expect(r.plan.items.map((i) => i.source).sort()).toEqual(["audit", "live", "wins"]);
    expect(r.exitCode).toBe(1);
    expect(r.plan.agentPrompt).toContain("Defer 1 third-party script");
    expect(r.plan.agentPrompt).toContain("Lazy-load Chart");
    expect(r.plan.agentPrompt).not.toContain("14 GTM tags"); // not-code stays out of the agent's do-list
    expect(r.markdown).toContain("By page type (live)");
    expect(r.plan.warnings.join()).toContain("--compare");
  });

  it("tolerates failing wins/live subprocesses and a failing audit", async () => {
    const root = tmp();
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
    const r = await runSpeed({
      projectRoot: root, urls: ["https://s.com/"],
      audit: () => { throw new Error("boom"); },
      exec: () => "exit 1: nope",
    });
    expect(r.plan.items).toEqual([]);
    expect(r.plan.warnings.some((w) => w.includes("static audit failed"))).toBe(true);
    expect(r.plan.warnings.some((w) => w.includes("wins failed"))).toBe(true);
    expect(r.plan.warnings.some((w) => w.includes("live audit failed"))).toBe(true);
    expect(r.markdown).toContain("Nothing here");
  });

  it("skips wins when the project is not buildable", async () => {
    const root = tmp();
    const calls: string[][] = [];
    const r = await runSpeed({ projectRoot: root, live: false, audit: () => ({ findings: [] }), exec: (a) => (calls.push(a), undefined) });
    expect(calls).toEqual([]);
    expect(r.plan.warnings[0]).toContain("wins skipped");
  });

  it("passes --no-analyze and live flags through to subcommands", async () => {
    const root = tmp();
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
    const calls: string[][] = [];
    await runSpeed({
      projectRoot: root, analyze: false, urls: ["https://a.com"], sitemap: "https://a.com/sitemap.xml", sample: 5,
      audit: () => ({ findings: [] }), exec: (a) => (calls.push(a), undefined),
    });
    expect(calls[0]).toContain("--no-analyze");
    expect(calls[1]).toEqual(expect.arrayContaining(["live", "https://a.com", "--sitemap", "https://a.com/sitemap.xml", "--sample", "5"]));
  });

  it("snapshot then compare shows resolved/new", async () => {
    const root = tmp();
    const opts = { projectRoot: root, wins: false, live: false } as const;
    await runSpeed({ ...opts, snapshot: true, audit: () => ({ findings: [finding("a.tsx")] }) });
    expect(existsSync(join(root, ".wimb", "plan.prev.json"))).toBe(true);
    const r = await runSpeed({ ...opts, compare: true, audit: () => ({ findings: [] }) });
    expect(r.plan.compare!.resolved.map((x) => x.key)).toEqual(["audit:third-party-script"]);
    expect(r.markdown).toContain("Since last snapshot");
    // without --snapshot, prev is untouched
    expect(JSON.parse(readFileSync(join(root, ".wimb", "plan.prev.json"), "utf-8")).items).toHaveLength(1);
  });
});

describe("flag parsing", () => {
  it("splits repeatable and comma url flags", () => {
    expect(parseUrlFlag(["https://a.com,https://b.com", "https://c.com"])).toEqual(["https://a.com", "https://b.com", "https://c.com"]);
    expect(parseUrlFlag(undefined)).toEqual([]);
  });
  it("rejects bad --sample", () => {
    expect(parseSample(undefined)).toBeUndefined();
    expect(parseSample("3")).toBe(3);
    expect(() => parseSample("0")).toThrow(FlagError);
    expect(() => parseSample("x")).toThrow(FlagError);
  });
});

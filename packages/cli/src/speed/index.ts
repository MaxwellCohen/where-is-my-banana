import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { runAudit } from "../audit/index.js";
import { writeAudit } from "../audit/output.js";
import { FlagError } from "../index-flags.js";
import { biggestRisk, buildItems, comparePlans, headline, pageTypes, sectionize, speedBudget } from "./merge.js";
import { buildAgentPrompt, formatPlanMarkdown, formatPlanTerminal, writePlan } from "./output.js";
import type { Plan, PlanInputs, PlanSeverity } from "./types.js";

export interface SpeedOptions {
  projectRoot: string;
  urls?: string[];
  urlsFile?: string;
  sitemap?: string;
  sample?: number;
  wins?: boolean;
  live?: boolean;
  analyze?: boolean;
  top?: number;
  compare?: boolean;
  snapshot?: boolean;
  failOn?: "high" | "medium";
  /** Override subprocess execution (tests). Returns an error message on failure. */
  exec?: (args: string[], cwd: string) => string | undefined;
  /** Override the static audit (tests). */
  audit?: (root: string) => Promise<unknown> | unknown;
}

export interface SpeedResult {
  plan: Plan;
  markdown: string;
  terminal: string;
  paths: { json: string; md: string };
  exitCode: number;
}

/** Split repeatable / comma-separated --url values. */
export function parseUrlFlag(v: unknown): string[] {
  const list = Array.isArray(v) ? v : v == null ? [] : [v];
  return list.flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean);
}

export function parseSample(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new FlagError(`--sample must be a positive integer, got '${v}'`);
  return n;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function isBuildable(root: string): boolean {
  const pkg = readJson<{ dependencies?: object; devDependencies?: object }>(join(root, "package.json"));
  if (!pkg) return false;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return "next" in deps || "vite" in deps;
}

function defaultExec(args: string[], cwd: string): string | undefined {
  const entry = process.argv[1];
  if (!entry) return "cannot locate the wimb entry point to run subcommands";
  const r = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: "utf-8", timeout: 20 * 60_000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) return r.error.message;
  if (r.status !== 0) return `exit ${r.status}: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ")}`;
  return undefined;
}

const SEV_RANK: Record<PlanSeverity, number> = { high: 3, medium: 2, low: 1 };

export async function runSpeed(opts: SpeedOptions): Promise<SpeedResult> {
  const root = opts.projectRoot;
  const wimb = join(root, ".wimb");
  const warnings: string[] = [];
  const exec = opts.exec ?? defaultExec;
  const inputs: PlanInputs = {};
  const used = { audit: false, wins: false, live: false };

  // 1. static audit
  try {
    if (opts.audit) inputs.audit = (await opts.audit(root)) as PlanInputs["audit"];
    else {
      const config = await loadConfig(root);
      const report = runAudit({ projectRoot: root, ignoreFiles: config.ignores.files, ignoreRules: config.ignores.rules });
      writeAudit(root, report, 10);
      inputs.audit = report;
    }
    used.audit = true;
  } catch (e) {
    warnings.push(`static audit failed: ${(e as Error).message}`);
    inputs.audit = readJson(join(wimb, "audit.json"));
    used.audit = !!inputs.audit;
  }

  // 2. wins
  if (opts.wins !== false) {
    if (!isBuildable(root)) warnings.push("wins skipped: no next/vite dependency in package.json (project not buildable)");
    else {
      const err = exec(["wins", "--cwd", root, ...(opts.analyze === false ? ["--no-analyze"] : [])], root);
      if (err) warnings.push(`wins failed, using any existing .wimb/wins.json: ${err}`);
      inputs.wins = readJson(join(wimb, "wins.json"));
      used.wins = !!inputs.wins;
    }
  }

  // 3. live
  if (opts.live !== false) {
    const urls = opts.urls ?? [];
    const wantsRun = urls.length > 0 || !!opts.urlsFile || !!opts.sitemap;
    if (wantsRun) {
      const args = ["live", ...urls, "--cwd", root];
      if (opts.urlsFile) args.push("--urls-file", opts.urlsFile);
      if (opts.sitemap) args.push("--sitemap", opts.sitemap);
      if (opts.sample) args.push("--sample", String(opts.sample));
      const err = exec(args, root);
      if (err) warnings.push(`live audit failed, using any existing .wimb/live.json: ${err}`);
    }
    inputs.live = readJson(join(wimb, "live.json"));
    used.live = !!inputs.live;
    if (!wantsRun && inputs.live) warnings.push("no --url given: reusing existing .wimb/live.json");
  }

  // 4. merge
  const top = opts.top ?? 10;
  const items = buildItems(inputs);
  const sec = sectionize(items, top);
  const prevPath = join(wimb, "plan.prev.json");
  const prev = existsSync(prevPath) ? readJson<{ items?: [] }>(prevPath) : null;
  if (opts.compare && !prev) warnings.push("--compare: no .wimb/plan.prev.json yet; run once with --snapshot to create it");
  const plan: Plan = {
    version: "1",
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    inputs: used,
    warnings,
    summary: {
      items: items.length,
      byOwner: count(items.map((i) => i.owner)),
      byTheme: count(items.map((i) => i.theme)),
      quickWins: sec.quickWins.length,
      budget: speedBudget(items),
      headline: headline(items, sec),
      biggestRisk: biggestRisk(items),
    },
    items,
    agentPrompt: buildAgentPrompt(sec, { hasLive: used.live }),
  };
  const liveFindings = inputs.live?.findings ?? [];
  if (liveFindings.length) plan.pageTypes = pageTypes(liveFindings);
  if (opts.compare && prev) plan.compare = comparePlans(prev, items);

  const markdown = formatPlanMarkdown(plan, sec);
  const paths = writePlan(root, plan, markdown);
  if (opts.snapshot) copyFileSync(paths.json, prevPath);

  const bad = opts.failOn ? items.some((i) => SEV_RANK[i.severity] >= SEV_RANK[opts.failOn!]) : false;
  return { plan, markdown, terminal: formatPlanTerminal(plan, sec, top), paths, exitCode: bad ? 1 : 0 };
}

function count(a: string[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const x of a) o[x] = (o[x] ?? 0) + 1;
  return o;
}

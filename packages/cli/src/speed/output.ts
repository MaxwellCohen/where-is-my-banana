import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PageTypeRow, Plan, PlanCompare, PlanItem } from "./types.js";
import type { Sections } from "./merge.js";

const owners: Record<string, string> = { code: "code", gtm: "GTM", cdn: "CDN", cms: "CMS", "human-decision": "decision" };

export function buildAgentPrompt(sec: Sections, opts: { maxItems?: number; hasLive?: boolean } = {}): string {
  const items = sec.doFirst.slice(0, opts.maxItems ?? 8);
  const L = [
    "Make this website faster. Work through the items below in order. Rules: do not upgrade `next`, never add `ssr: false`, never remove consent/analytics/tracking scripts (defer them and list them for the user to approve), ask before changing caching/revalidate behavior or CMS queries. One small commit per item.",
    "",
  ];
  if (!items.length) L.push("No safe code items were found. Read .wimb/plan.md for items that need a decision.", "");
  items.forEach((i, n) => {
    L.push(`## ${n + 1}. ${i.title}  [${i.theme}, effort ${i.effort}, improves ${i.impact}]`);
    L.push(`Why: ${i.why}`);
    if (i.files.length) L.push(`Files: ${i.files.slice(0, 8).join(", ")}${i.files.length > 8 ? `, +${i.files.length - 8} more` : ""}`);
    L.push("Steps:");
    for (const st of i.exactInstructions.slice(0, 10)) L.push(`- ${st}`);
    L.push(`Verify: ${i.verify}`, "");
  });
  const rest = sec.doFirst.length - items.length;
  if (rest > 0) L.push(`${rest} more safe item(s) are in .wimb/plan.md ("Do first").`, "");
  L.push(
    `After each item: rebuild, re-run \`npx --yes @maxwellcohen/wimb speed --no-wins${opts.hasLive ? "" : " --no-live"} --compare\`, and keep the edit only if the item resolves and the build passes. Revert otherwise.`,
    `Do NOT do these without asking: ${sec.decision.length} item(s) needing a human decision and ${sec.notCode.length} non-code item(s) (GTM/CDN/CMS) are listed in .wimb/plan.md; summarize them for the user at the end.`,
    "Finish with: items fixed, measured deltas, and what remains.",
  );
  return L.join("\n") + "\n";
}

function itemBlock(i: PlanItem, full = true): string[] {
  const L = [
    `### #${i.rank} ${i.title}`,
    `- **Theme:** ${i.theme} | **Impact:** ${i.impact} (score ${i.impactScore}) | **Effort:** ${i.effort} | **Owner:** ${owners[i.owner]} | **Risk:** ${i.risk}` +
      (i.corroborated ? " | **Corroborated by live data**" : "") +
      (i.estKB ? ` | **~${i.estKB} KB** (${i.kbBasis})` : ""),
    `- **Why:** ${i.why}`,
  ];
  if (i.files.length) L.push(`- **Files:** ${i.files.slice(0, 10).map((f) => `\`${f}\``).join(", ")}${i.files.length > 10 ? `, +${i.files.length - 10} more` : ""}`);
  if (i.urls?.length) L.push(`- **Pages:** ${i.urls.slice(0, 5).join(", ")}${i.urls.length > 5 ? `, +${i.urls.length - 5} more` : ""}`);
  if (full) {
    L.push("- **Steps:**");
    for (const st of i.exactInstructions) L.push(`  - ${st}`);
  }
  L.push(`- **Verify:** \`${i.verify}\``, "");
  return L;
}

function section(title: string, note: string, items: PlanItem[], full = true): string[] {
  const L = [`## ${title}`, ""];
  if (note) L.push(note, "");
  if (!items.length) L.push("_Nothing here._", "");
  for (const i of items) L.push(...itemBlock(i, full));
  return L;
}

export function formatCompareMd(c: PlanCompare): string[] {
  const L = ["## Since last snapshot", ""];
  L.push(`Resolved: ${c.resolved.length} · New: ${c.new.length} · Regressed: ${c.regressed.length} · Unchanged: ${c.unchanged}`, "");
  for (const r of c.resolved) L.push(`- resolved: ${r.title}`);
  for (const r of c.new) L.push(`- new: ${r.title} (score ${r.impactScore})`);
  for (const r of c.regressed) L.push(`- regressed: ${r.title} (${r.reason}; score ${r.from} -> ${r.to})`);
  L.push("");
  return L;
}

function pageTypeTable(rows: PageTypeRow[]): string[] {
  const L = ["## By page type (live)", "", "| Page type | URLs | High | Med | Low | Top issue |", "|---|---|---|---|---|---|"];
  for (const r of rows) L.push(`| ${r.type} | ${r.urls} | ${r.high} | ${r.medium} | ${r.low} | ${r.topIssue} |`);
  L.push("");
  return L;
}

export function formatPlanMarkdown(plan: Plan, sec: Sections): string {
  const sm = plan.summary;
  const L = ["# wimb speed plan", "", `_Generated ${plan.generatedAt}. Inputs: ${Object.entries(plan.inputs).map(([k, v]) => `${k}=${v ? "yes" : "no"}`).join(", ")}_`, ""];
  for (const w of plan.warnings) L.push(`> warning: ${w}`);
  if (plan.warnings.length) L.push("");
  L.push(`**${sm.headline}**`, "");
  if (sm.budget.length) {
    L.push("## Speed budget (estimated KB saveable)", "", "| Theme | ~KB | Basis |", "|---|---|---|");
    for (const b of sm.budget) L.push(`| ${b.theme} | ${b.kb} | ${b.basis} |`);
    L.push("", "_\"measured\" comes from bundle analysis; \"rough\" is a per-finding heuristic, not a measurement._", "");
  }
  if (sec.quickWins.length) {
    L.push("## Quick wins (under 30 minutes, safe)", "");
    for (const i of sec.quickWins) L.push(`- #${i.rank} ${i.title} (${i.impact})`);
    L.push("");
  }
  if (sm.biggestRisk) L.push("## Biggest risk", "", sm.biggestRisk, "");
  if (plan.compare) L.push(...formatCompareMd(plan.compare));
  L.push(...section("Do first (code, safe)", "Safe, mechanical, code-only changes. Highest impact per effort first.", sec.doFirst));
  L.push(...section("Needs a human decision", "Behavior or product trade-offs; read the code and decide before editing.", sec.decision));
  L.push(...section("Not code (GTM / CDN / CMS settings)", "Exact steps for the person who owns the tool.", sec.notCode));
  L.push(...section("Later", "Lower impact or beyond the top list.", sec.later, false));
  if (plan.pageTypes?.length) L.push(...pageTypeTable(plan.pageTypes));
  L.push("## Handoff prompt", "", "Paste into an AI coding agent:", "", "````text", plan.agentPrompt.trimEnd(), "````", "");
  return L.join("\n");
}

export function formatPlanTerminal(plan: Plan, sec: Sections, top: number): string {
  const L = [`wimb speed: ${plan.summary.headline}`];
  for (const w of plan.warnings) L.push(`  warning: ${w}`);
  const rows = plan.items.slice(0, top);
  for (const i of rows) {
    L.push(`  #${String(i.rank).padEnd(2)} [${i.owner}/${i.effort}/${i.risk}] ${i.title}  (${i.theme}, ${i.impact}, score ${i.impactScore}${i.corroborated ? ", live-confirmed" : ""})`);
  }
  if (plan.items.length > rows.length) L.push(`  ... ${plan.items.length - rows.length} more in plan.md`);
  if (sec.quickWins.length) L.push(`  quick wins: ${sec.quickWins.map((i) => `#${i.rank}`).join(", ")}`);
  if (plan.summary.biggestRisk) L.push(`  biggest risk: ${plan.summary.biggestRisk}`);
  if (plan.compare) {
    const c = plan.compare;
    L.push(`  vs previous: ${c.resolved.length} resolved, ${c.new.length} new, ${c.regressed.length} regressed`);
    for (const r of c.regressed) L.push(`    regressed: ${r.title} (${r.reason})`);
  }
  return L.join("\n");
}

export function writePlan(root: string, plan: Plan, md: string): { json: string; md: string } {
  const dir = join(root, ".wimb");
  mkdirSync(dir, { recursive: true });
  const json = join(dir, "plan.json");
  const mdPath = join(dir, "plan.md");
  writeFileSync(json, `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
  writeFileSync(mdPath, md, "utf-8");
  return { json, md: mdPath };
}

import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";
import { relPath } from "../../graph/builder.js";

export const useClientTooHigh: Rule = {
  id: "use-client-too-high",
  category: "boundary",
  defaultSeverity: "error",
  run(ctx) {
    const { subtreeBytesHigh, clientSignalRatio } = ctx.config.thresholds;
    for (const mod of ctx.graph.modules.values()) {
      if (!mod.isBoundary) continue;
      if (isIgnored(ctx, "use-client-too-high", mod.filePath)) continue;
      const isHighFile =
        /\/(layout|page|template)\.(t|j)sx?$/.test(mod.filePath) ||
        mod.subtreeBytes() > subtreeBytesHigh;
      if (!isHighFile) continue;

      const subtree = collectSubtree(ctx, mod.filePath);
      const withSignals = subtree.filter(
        (m) => m.signals.hooks.length + m.signals.eventHandlers.length + m.signals.browserGlobals.length > 0,
      );
      if (subtree.length === 0) continue;
      if (withSignals.length / subtree.length >= clientSignalRatio) continue;

      ctx.report(
        makeFinding(ctx, {
          id: `${mod.filePath}:use-client-too-high`,
          ruleId: "use-client-too-high",
          category: "boundary",
          defaultSeverity: "error",
          confidence: "medium",
          file: mod.filePath,
          message: "'use client' is placed too high — most of the subtree is server-safe",
          evidence: {
            signalModules: withSignals.map((m) => relPath(ctx.projectRoot, m.filePath)),
            subtreeBytes: mod.subtreeBytes(),
          },
          estimatedBytes: mod.subtreeBytes(),
          fixStrategy: {
            name: "move-boundary-down",
            steps: [
              "Remove 'use client' from this file",
              "Add 'use client' to the listed signal-bearing descendants",
              "Pass server-rendered content via children/props",
            ],
          },
        }),
      );
    }
  },
};

function collectSubtree(ctx: { graph: { modules: Map<string, { filePath: string; imports: { resolvedPath: string | null }[]; signals: { hooks: unknown[]; eventHandlers: unknown[]; browserGlobals: unknown[] } }> } }, root: string) {
  const visited = new Set<string>();
  const stack = [root];
  const result = [];
  while (stack.length) {
    const p = stack.pop()!;
    if (visited.has(p)) continue;
    visited.add(p);
    const m = ctx.graph.modules.get(p);
    if (!m) continue;
    result.push(m);
    for (const imp of m.imports) {
      if (imp.resolvedPath) stack.push(imp.resolvedPath);
    }
  }
  return result;
}

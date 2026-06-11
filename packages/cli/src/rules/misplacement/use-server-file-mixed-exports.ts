import type { Rule } from "../../types.js";
import { isProjectSource, reportFinding, isIgnored } from "../helpers.js";

export const useServerFileMixedExports: Rule = {
  id: "use-server-file-mixed-exports",
  category: "misplacement",
  defaultSeverity: "warning",
  run(ctx) {
    for (const mod of ctx.graph.modules.values()) {
      if (!isProjectSource(ctx, mod.filePath)) continue;
      if (!mod.directives.has("use server")) continue;
      if (isIgnored(ctx, "use-server-file-mixed-exports", mod.filePath)) continue;
      const nonAsync = mod.exports.filter((e) => !e.isAsync && e.name !== "default");
      if (!nonAsync.length) continue;

      reportFinding(ctx, {
          id: `${mod.filePath}:use-server-file-mixed-exports`,
          ruleId: "use-server-file-mixed-exports",
          category: "misplacement",
          defaultSeverity: "warning",
          confidence: "high",
          file: mod.filePath,
          message: "'use server' file exports non-async functions — every export is a public endpoint",
          evidence: { exports: nonAsync.map((e) => e.name) },
          fixStrategy: {
            name: "isolate-actions",
            steps: [
              "Keep only server actions in 'use server' files",
              "Move helpers to a plain module with import 'server-only'",
            ],
          },
        });
    }
  },
};

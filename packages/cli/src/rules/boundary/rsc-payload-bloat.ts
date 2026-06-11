import type { Rule } from "../../types.js";
import { isProjectSource, reportFinding, isIgnored } from "../helpers.js";

export const rscPayloadBloat: Rule = {
  id: "rsc-payload-bloat",
  category: "boundary",
  defaultSeverity: "warning",
  run(ctx) {
    const { rscPayloadMaxFields } = ctx.config.thresholds;
    for (const mod of ctx.graph.modules.values()) {
      if (!isProjectSource(ctx, mod.filePath)) continue;
      if (mod.env !== "server") continue;
      if (isIgnored(ctx, "rsc-payload-bloat", mod.filePath)) continue;
      const passesToClient = mod.imports.some((i) => {
        if (!i.resolvedPath) return false;
        return ctx.graph.modules.get(i.resolvedPath)?.isBoundary;
      });
      if (!passesToClient) continue;
      const hasAsyncData = mod.imports.some((i) =>
        /fetch|db|prisma|drizzle/i.test(i.specifier),
      );
      if (!hasAsyncData && mod.signals.largestLiteralBytes < 5000) continue;

      reportFinding(ctx, {
          id: `${mod.filePath}:rsc-payload-bloat`,
          ruleId: "rsc-payload-bloat",
          category: "boundary",
          defaultSeverity: "warning",
          confidence: "low",
          file: mod.filePath,
          message: "Server component may pass entire async result to client — pick fields server-side",
          evidence: { maxFields: rscPayloadMaxFields },
          fixStrategy: {
            name: "trim-payload",
            steps: [
              "Pick/map only the needed fields server-side before passing as props",
            ],
          },
        });
    }
  },
};

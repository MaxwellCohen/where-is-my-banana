import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

export const mixedModuleSplit: Rule = {
  id: "mixed-module-split",
  category: "boundary",
  defaultSeverity: "error",
  run(ctx) {
    for (const mod of ctx.graph.modules.values()) {
      if (mod.env !== "shared") continue;
      if (isIgnored(ctx, "mixed-module-split", mod.filePath)) continue;
      for (const exp of mod.exports) {
        const serverOnly = exp.referencedBy.every((r) => {
          const m = ctx.graph.modules.get(r.modulePath);
          return m && m.env === "server";
        });
        if (!serverOnly || !exp.referencedBy.length) continue;
        const hasServerSignals =
          mod.signals.nodeBuiltins.length > 0 ||
          mod.signals.envReads.some((e) => !e.name.startsWith("NEXT_PUBLIC_"));
        if (!hasServerSignals) continue;

        ctx.report(
          makeFinding(ctx, {
            id: `${mod.filePath}:mixed-module-split:${exp.name}`,
            ruleId: "mixed-module-split",
            category: "boundary",
            defaultSeverity: "error",
            confidence: "medium",
            file: mod.filePath,
            message: `Export '${exp.name}' is server-only but module is shared with client`,
            evidence: { export: exp.name, referencedBy: exp.referencedBy },
            fixStrategy: {
              name: "split-server-module",
              steps: [
                `Split into ${exp.name}.server.ts with import 'server-only'`,
                "Keep client-safe remainder in the original file",
                "Update importers",
              ],
            },
          }),
        );
      }
    }
  },
};

import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

export const largeStaticDataInClient: Rule = {
  id: "large-static-data-in-client",
  category: "loading",
  defaultSeverity: "warning",
  run(ctx) {
    const { largeJsonBytes, largeLiteralBytes } = ctx.config.thresholds;
    for (const path of ctx.graph.clientModules) {
      const mod = ctx.graph.modules.get(path)!;
      const jsonImport = mod.imports.find(
        (i) => i.resolvedPath?.endsWith(".json") && (ctx.graph.modules.get(i.resolvedPath!)?.sourceBytes ?? 0) > largeJsonBytes,
      );
      const largeLiteral = mod.signals.largestLiteralBytes > largeLiteralBytes;
      if (!jsonImport && !largeLiteral) continue;
      if (isIgnored(ctx, "large-static-data-in-client", path)) continue;
      ctx.report(
        makeFinding(ctx, {
          id: `${path}:large-static-data-in-client`,
          ruleId: "large-static-data-in-client",
          category: "loading",
          defaultSeverity: "warning",
          confidence: "high",
          file: path,
          message: "Large static data shipped in client module",
          evidence: {
            jsonImport: jsonImport?.resolvedPath,
            largestLiteralBytes: mod.signals.largestLiteralBytes,
          },
          estimatedBytes: mod.signals.largestLiteralBytes,
          fixStrategy: {
            name: "move-data-server",
            steps: [
              "Move data server-side and pass needed slice as props",
              "Fetch on demand or import() lazily",
            ],
          },
        }),
      );
    }
  },
};

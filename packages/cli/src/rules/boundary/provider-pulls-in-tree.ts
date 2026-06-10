import type { Rule } from "../../types.js";
import { makeFinding, isIgnored, getInstallSize } from "../helpers.js";

export const providerPullsInTree: Rule = {
  id: "provider-pulls-in-tree",
  category: "boundary",
  defaultSeverity: "error",
  run(ctx) {
    const { providerMinImports, providerMaxInstallSize } = ctx.config.thresholds;
    for (const mod of ctx.graph.modules.values()) {
      if (!mod.isBoundary) continue;
      if (isIgnored(ctx, "provider-pulls-in-tree", mod.filePath)) continue;
      const isProvider = mod.imports.some(
        (i) => i.namedSymbols.some((s) => /Provider$/.test(s)) || /provider/i.test(i.specifier),
      );
      if (!isProvider && mod.signals.jsxElements < 2) continue;
      const nonReactImports = mod.imports.filter((i) => i.packageName && i.packageName !== "react");
      const heavyImport = mod.imports.find(
        (i) => i.packageName && getInstallSize(ctx, i.packageName) > providerMaxInstallSize,
      );
      if (nonReactImports.length <= providerMinImports && !heavyImport) continue;

      ctx.report(
        makeFinding(ctx, {
          id: `${mod.filePath}:provider-pulls-in-tree`,
          ruleId: "provider-pulls-in-tree",
          category: "boundary",
          defaultSeverity: "error",
          confidence: "high",
          file: mod.filePath,
          message: "Provider boundary pulls in a large dependency tree",
          evidence: {
            imports: nonReactImports.map((i) => i.packageName),
            heavyImport: heavyImport?.packageName,
          },
          estimatedBytes: mod.subtreeBytes(),
          fixStrategy: {
            name: "minimal-provider",
            steps: [
              "Move provider into a minimal providers.tsx with only the provider + children",
              "Import everything else where it's used",
            ],
          },
        }),
      );
    }
  },
};

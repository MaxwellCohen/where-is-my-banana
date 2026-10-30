import type { Rule } from "../../types.js";
import { reportFinding, projectClientModulePaths, isIgnored, isViteApp } from "../helpers.js";

/** ESM packages that Vite/Rollup tree-shake well, so barrel imports are not a bundle problem there. */
const VITE_TREE_SHAKABLE = new Set([
  "lodash-es",
  "react-icons",
  "lucide-react",
  "@heroicons/react",
  "@tabler/icons-react",
  "date-fns",
  "@mui/icons-material",
]);

export const barrelImport: Rule = {
  id: "barrel-import",
  category: "dependency",
  defaultSeverity: "warning",
  run(ctx) {
    const vite = isViteApp(ctx);
    for (const path of projectClientModulePaths(ctx)) {
      const mod = ctx.graph.modules.get(path)!;
      for (const imp of mod.imports) {
        if (imp.isTypeOnly || imp.isDynamic) continue;
        if (!imp.packageName || !ctx.data.barrelPackages.has(imp.packageName)) continue;
        if (vite && VITE_TREE_SHAKABLE.has(imp.packageName)) continue;
        const isDeep = imp.specifier.includes("/") && imp.specifier !== imp.packageName;
        if (isDeep) continue;
        if (isIgnored(ctx, "barrel-import", path)) continue;
        reportFinding(ctx, {
            id: `${path}:barrel-import:${imp.packageName}`,
            ruleId: "barrel-import",
            category: "dependency",
            defaultSeverity: "warning",
            confidence: "high",
            file: path,
            loc: imp.loc,
            message: `Barrel import from '${imp.packageName}' — use deep imports or optimizePackageImports`,
            evidence: { specifier: imp.specifier },
            fixStrategy: {
              name: "deep-import",
              steps: [
                `Use deep import path (e.g. ${imp.packageName}/specific-export)`,
                vite
                  ? "Or switch to an ESM build of the package that Rollup can tree-shake"
                  : "Or add package to experimental.optimizePackageImports in next.config",
              ],
            },
          });
      }
    }
  },
};

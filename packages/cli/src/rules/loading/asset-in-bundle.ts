import type { Rule } from "../../types.js";
import { reportFinding, projectClientModulePaths, isIgnored } from "../helpers.js";

const ASSET_EXTS = /\.(png|jpe?g|gif|mp4|woff2?)$/i;

export const assetInBundle: Rule = {
  id: "asset-in-bundle",
  category: "loading",
  defaultSeverity: "warning",
  run(ctx) {
    const { base64MinBytes } = ctx.config.thresholds;
    for (const path of projectClientModulePaths(ctx)) {
      const mod = ctx.graph.modules.get(path)!;
      for (const imp of mod.imports) {
        if (!ASSET_EXTS.test(imp.specifier) && !/@fontsource/.test(imp.specifier)) continue;
        if (isIgnored(ctx, "asset-in-bundle", path)) continue;
        reportFinding(ctx, {
            id: `${path}:asset-in-bundle`,
            ruleId: "asset-in-bundle",
            category: "loading",
            defaultSeverity: "warning",
            confidence: "high",
            file: path,
            loc: imp.loc,
            message: `Binary asset '${imp.specifier}' imported into client bundle`,
            evidence: { specifier: imp.specifier },
            fixStrategy: {
              name: "public-assets",
              steps: [
                "Move to public/ and use next/image for media",
                "Use next/font for fonts",
              ],
            },
          });
      }
      if (mod.signals.largestLiteralBytes > base64MinBytes) {
        reportFinding(ctx, {
            id: `${path}:asset-in-bundle:base64`,
            ruleId: "asset-in-bundle",
            category: "loading",
            defaultSeverity: "warning",
            confidence: "medium",
            file: path,
            message: "Large base64 data URI detected in client source",
            evidence: { bytes: mod.signals.largestLiteralBytes },
            estimatedBytes: mod.signals.largestLiteralBytes,
            fixStrategy: {
              name: "external-asset",
              steps: ["Move asset to public/ or use next/image"],
            },
          });
      }
    }
  },
};

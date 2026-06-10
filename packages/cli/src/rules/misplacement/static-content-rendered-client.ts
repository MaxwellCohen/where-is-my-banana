import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

export const staticContentRenderedClient: Rule = {
  id: "static-content-rendered-client",
  category: "misplacement",
  defaultSeverity: "warning",
  run(ctx) {
    for (const path of ctx.graph.clientModules) {
      const mod = ctx.graph.modules.get(path)!;
      if (!mod.isBoundary) continue;
      const renderer = mod.imports.find(
        (i) => i.packageName && ctx.data.staticRenderers.has(i.packageName),
      );
      if (!renderer) continue;
      const hasUserInput = mod.signals.hooks.some((h) => h.line > 0);
      if (hasUserInput && mod.signals.eventHandlers.length > 2) continue;
      if (isIgnored(ctx, "static-content-rendered-client", path)) continue;

      ctx.report(
        makeFinding(ctx, {
          id: `${path}:static-content-rendered-client`,
          ruleId: "static-content-rendered-client",
          category: "misplacement",
          defaultSeverity: "warning",
          confidence: "medium",
          file: path,
          loc: renderer.loc,
          message: `Static content rendered client-side via '${renderer.packageName}'`,
          evidence: { renderer: renderer.packageName },
          fixStrategy: {
            name: "server-render-content",
            steps: [
              "Render in a Server Component or precompute at build",
              "Ship HTML to client",
              "Keep client renderer only for live-editing use cases",
            ],
          },
        }),
      );
    }
  },
};

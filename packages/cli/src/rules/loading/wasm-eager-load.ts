import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

export const wasmEagerLoad: Rule = {
  id: "wasm-eager-load",
  category: "loading",
  defaultSeverity: "warning",
  run(ctx) {
    for (const path of ctx.graph.clientModules) {
      const mod = ctx.graph.modules.get(path)!;
      for (const imp of mod.imports) {
        const isWasm =
          imp.specifier.endsWith(".wasm") ||
          (imp.packageName && ctx.data.wasmPackages.has(imp.packageName));
        if (!isWasm || imp.isDynamic) continue;
        if (isIgnored(ctx, "wasm-eager-load", path)) continue;
        ctx.report(
          makeFinding(ctx, {
            id: `${path}:wasm-eager-load`,
            ruleId: "wasm-eager-load",
            category: "loading",
            defaultSeverity: "warning",
            confidence: "high",
            file: path,
            loc: imp.loc,
            message: `WASM '${imp.specifier}' eagerly loaded in client initial bundle`,
            evidence: { specifier: imp.specifier },
            fixStrategy: {
              name: "lazy-wasm",
              steps: [
                "Use dynamic import() on first use",
                "Trigger inside the user interaction that needs WASM",
              ],
            },
          }),
        );
      }
    }
  },
};

import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

const SHIM_PACKAGES = ["buffer", "process", "crypto-browserify", "stream-browserify", "events"];

export const nodeBuiltinPolyfillConfig: Rule = {
  id: "node-builtin-polyfill-config",
  category: "dependency",
  defaultSeverity: "warning",
  run(ctx) {
    if (ctx.nextConfig?.webpackFallbacks.length) {
      ctx.report(
        makeFinding(ctx, {
          id: "next-config:webpack-fallback",
          ruleId: "node-builtin-polyfill-config",
          category: "dependency",
          defaultSeverity: "warning",
          confidence: "high",
          file: "next.config",
          message: "next.config webpack resolve.fallback shims Node built-ins for the browser",
          evidence: { fallbacks: ctx.nextConfig.webpackFallbacks },
          fixStrategy: {
            name: "remove-shims",
            steps: [
              "Find the client module needing the shim",
              "Move server logic server-side instead of shimming",
            ],
          },
        }),
      );
    }
    for (const pkg of SHIM_PACKAGES) {
      if (!ctx.pkg.dependencies[pkg]) continue;
      if (isIgnored(ctx, "node-builtin-polyfill-config", pkg)) continue;
      ctx.report(
        makeFinding(ctx, {
          id: `pkg:${pkg}:node-builtin-polyfill-config`,
          ruleId: "node-builtin-polyfill-config",
          category: "dependency",
          defaultSeverity: "warning",
          confidence: "high",
          file: "package.json",
          message: `Browser shim package '${pkg}' in dependencies`,
          evidence: { package: pkg },
          fixStrategy: {
            name: "remove-shim-dep",
            steps: [
              "Find client module needing the shim",
              "Move that code server-side",
              "Remove shim dependency",
            ],
          },
        }),
      );
    }
  },
};

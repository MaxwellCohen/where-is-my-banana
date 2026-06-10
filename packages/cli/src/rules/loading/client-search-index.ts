import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

const SEARCH_LIBS = ["lunr", "flexsearch", "fuse.js", "minisearch"];

export const clientSearchIndex: Rule = {
  id: "client-search-index",
  category: "loading",
  defaultSeverity: "warning",
  run(ctx) {
    const { searchIndexMinBytes } = ctx.config.thresholds;
    for (const path of ctx.graph.clientModules) {
      const mod = ctx.graph.modules.get(path)!;
      const hasSearch = mod.imports.some((i) => i.packageName && SEARCH_LIBS.includes(i.packageName));
      if (!hasSearch) continue;
      const hasLargeData = mod.imports.some(
        (i) => i.resolvedPath?.endsWith(".json") && (ctx.graph.modules.get(i.resolvedPath!)?.sourceBytes ?? 0) > searchIndexMinBytes,
      );
      if (!hasLargeData && mod.signals.largestLiteralBytes <= searchIndexMinBytes) continue;
      if (isIgnored(ctx, "client-search-index", path)) continue;
      ctx.report(
        makeFinding(ctx, {
          id: `${path}:client-search-index`,
          ruleId: "client-search-index",
          category: "loading",
          defaultSeverity: "warning",
          confidence: "medium",
          file: path,
          message: "Client search index with large static data",
          evidence: {},
          fixStrategy: {
            name: "lazy-search",
            steps: [
              "Lazy-load the index on first search interaction",
              "Or move search to a route handler",
            ],
          },
        }),
      );
    }
  },
};

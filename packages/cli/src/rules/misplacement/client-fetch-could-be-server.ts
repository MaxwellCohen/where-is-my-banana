import type { Rule } from "../../types.js";
import { reportFinding, projectClientModulePaths, isIgnored } from "../helpers.js";

export const clientFetchCouldBeServer: Rule = {
  id: "client-fetch-could-be-server",
  category: "misplacement",
  defaultSeverity: "warning",
  run(ctx) {
    for (const path of projectClientModulePaths(ctx)) {
      const mod = ctx.graph.modules.get(path)!;
      if (!mod.isBoundary) continue;
      if (isIgnored(ctx, "client-fetch-could-be-server", path)) continue;
      const hasFetchEffect = mod.signals.useEffectCalls.some((e) => e.depsEmpty);
      const hasDataLib = mod.imports.some((i) =>
        /swr|react-query|@tanstack\/react-query/.test(i.packageName ?? ""),
      );
      const isPage = /\/page\.(t|j)sx?$/.test(path);
      if (!hasFetchEffect && !(hasDataLib && isPage)) continue;

      reportFinding(ctx, {
          id: `${path}:client-fetch-could-be-server`,
          ruleId: "client-fetch-could-be-server",
          category: "misplacement",
          defaultSeverity: "warning",
          confidence: "low",
          file: path,
          message: "Client-side data fetching with constant URL could be a Server Component fetch",
          evidence: { useEffectCalls: mod.signals.useEffectCalls.length },
          fixStrategy: {
            name: "server-fetch",
            steps: [
              "Convert component or parent to Server Component",
              "Perform fetch server-side and pass data as props",
              "Remove fetching library if unused elsewhere",
            ],
          },
        });
    }
  },
};

import type { Rule } from "../../types.js";
import { reportFinding, projectClientModulePaths, isIgnored } from "../helpers.js";

export const serverLogicInClient: Rule = {
  id: "server-logic-in-client",
  category: "misplacement",
  defaultSeverity: "error",
  run(ctx) {
    for (const path of projectClientModulePaths(ctx)) {
      const mod = ctx.graph.modules.get(path)!;
      if (isIgnored(ctx, "server-logic-in-client", path)) continue;
      const serverImports = mod.imports.filter(
        (i) => i.packageName && ctx.data.serverPackages.has(i.packageName),
      );
      const secretEnv = mod.signals.envReads.filter((e) => !e.name.startsWith("NEXT_PUBLIC_"));
      if (!mod.signals.nodeBuiltins.length && !serverImports.length && !secretEnv.length) continue;

      reportFinding(ctx, {
          id: `${path}:server-logic-in-client`,
          ruleId: "server-logic-in-client",
          category: "misplacement",
          defaultSeverity: "error",
          confidence: "high",
          file: path,
          message: "Server logic detected in client graph",
          evidence: {
            nodeBuiltins: mod.signals.nodeBuiltins,
            serverImports: serverImports.map((i) => i.packageName),
            envReads: secretEnv.map((e) => e.name),
            importChain: mod.importChainFromEntry,
          },
          fixStrategy: {
            name: "move-server-logic",
            steps: [
              "Data read at render time → Server Component fetch",
              "Mutation → server action",
              "Client-triggered read → route handler",
              "Move the import behind that boundary",
            ],
          },
        });
    }
  },
};

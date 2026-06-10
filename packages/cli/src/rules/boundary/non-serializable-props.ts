import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

export const nonSerializableProps: Rule = {
  id: "non-serializable-props",
  category: "boundary",
  defaultSeverity: "error",
  run(ctx) {
    for (const mod of ctx.graph.modules.values()) {
      if (mod.env !== "server") continue;
      if (isIgnored(ctx, "non-serializable-props", mod.filePath)) continue;
      const importsBoundary = mod.imports.some((i) => {
        if (!i.resolvedPath) return false;
        const target = ctx.graph.modules.get(i.resolvedPath);
        return target?.isBoundary;
      });
      if (!importsBoundary) continue;
      const source = mod.ast().body;
      const hasNonSerializable = JSON.stringify(source).match(
        /FunctionExpression|ArrowFunctionExpression|new Date|new Map|new Set|ClassDeclaration/,
      );
      if (!hasNonSerializable) continue;

      ctx.report(
        makeFinding(ctx, {
          id: `${mod.filePath}:non-serializable-props`,
          ruleId: "non-serializable-props",
          category: "boundary",
          defaultSeverity: "error",
          confidence: "medium",
          file: mod.filePath,
          message: "Server component may pass non-serializable props to a client component",
          evidence: { importChain: mod.importChainFromEntry() },
          fixStrategy: {
            name: "serialize-props",
            steps: [
              "Move logic into the client component",
              "Pass serializable primitives only",
              "Or use a server action for callbacks",
            ],
          },
        }),
      );
    }
  },
};

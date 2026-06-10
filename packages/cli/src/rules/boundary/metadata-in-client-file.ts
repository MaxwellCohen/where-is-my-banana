import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

export const metadataInClientFile: Rule = {
  id: "metadata-in-client-file",
  category: "boundary",
  defaultSeverity: "error",
  run(ctx) {
    for (const mod of ctx.graph.modules.values()) {
      if (!mod.isBoundary) continue;
      if (isIgnored(ctx, "metadata-in-client-file", mod.filePath)) continue;
      const hasMetadata = mod.exports.some(
        (e) => e.name === "metadata" || e.name === "generateMetadata",
      );
      if (!hasMetadata) continue;

      ctx.report(
        makeFinding(ctx, {
          id: `${mod.filePath}:metadata-in-client-file`,
          ruleId: "metadata-in-client-file",
          category: "boundary",
          defaultSeverity: "error",
          confidence: "high",
          file: mod.filePath,
          message: "metadata/generateMetadata exported from a client file",
          evidence: {},
          fixStrategy: {
            name: "move-metadata",
            steps: [
              "Move metadata to the nearest server layout/page",
              "Or split the file into server + client parts",
            ],
          },
        }),
      );
    }
  },
};

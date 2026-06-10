import type { Rule } from "../../types.js";
import { makeFinding, isIgnored } from "../helpers.js";

export const authCryptoInClient: Rule = {
  id: "auth-crypto-in-client",
  category: "misplacement",
  defaultSeverity: "error",
  run(ctx) {
    for (const path of ctx.graph.clientModules) {
      const mod = ctx.graph.modules.get(path)!;
      if (isIgnored(ctx, "auth-crypto-in-client", path)) continue;
      const authImports = mod.imports.filter(
        (i) => i.packageName && ctx.data.authCryptoPackages.has(i.packageName),
      );
      const schemaImport = mod.imports.some((i) =>
        /prisma\/schema|db\/schema|\/models\//.test(i.resolvedPath ?? i.specifier),
      );
      if (!authImports.length && !schemaImport) continue;

      ctx.report(
        makeFinding(ctx, {
          id: `${path}:auth-crypto-in-client`,
          ruleId: "auth-crypto-in-client",
          category: "misplacement",
          defaultSeverity: "error",
          confidence: "high",
          file: path,
          message: "SECURITY: Auth/crypto code in client graph",
          evidence: {
            imports: authImports.map((i) => i.packageName),
            schemaImport,
            importChain: mod.importChainFromEntry,
          },
          fixStrategy: {
            name: "move-auth-server",
            steps: [
              "Move all auth/crypto operations server-side immediately",
              "Rotate any exposed credentials",
              "Use server actions or route handlers for auth flows",
            ],
          },
        }),
      );
    }
  },
};

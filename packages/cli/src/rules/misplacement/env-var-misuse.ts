import type { Rule } from "../../types.js";
import { reportFinding, projectClientModulePaths, isIgnored } from "../helpers.js";

const SECRET_PATTERN = /(secret|private|service[_-]?role|api[_-]?key|token|password)/i;
const PUBLIC_ALLOW = /_PUBLISHABLE_KEY$|_SITE_KEY$/;

export const envVarMisuse: Rule = {
  id: "env-var-misuse",
  category: "misplacement",
  defaultSeverity: "error",
  run(ctx) {
    for (const path of projectClientModulePaths(ctx)) {
      const mod = ctx.graph.modules.get(path)!;
      if (isIgnored(ctx, "env-var-misuse", path)) continue;
      for (const env of mod.signals.envReads) {
        if (env.name.startsWith("NEXT_PUBLIC_")) {
          if (SECRET_PATTERN.test(env.name) && !PUBLIC_ALLOW.test(env.name)) {
            reportFinding(ctx, {
                id: `${path}:env-var-misuse:public-secret`,
                ruleId: "env-var-misuse",
                category: "misplacement",
                defaultSeverity: "error",
                confidence: "high",
                file: path,
                loc: env.loc,
                message: `NEXT_PUBLIC env var '${env.name}' looks like a secret`,
                evidence: { envVar: env.name },
                fixStrategy: {
                  name: "rotate-secret",
                  steps: [
                    "Move secret usage server-side",
                    "Rotate the credential immediately",
                  ],
                },
              });
          }
        } else {
          reportFinding(ctx, {
              id: `${path}:env-var-misuse:non-public`,
              ruleId: "env-var-misuse",
              category: "misplacement",
              defaultSeverity: "error",
              confidence: "high",
              file: path,
              loc: env.loc,
              message: `Non-NEXT_PUBLIC env read '${env.name}' in client — undefined at runtime`,
              evidence: { envVar: env.name },
              fixStrategy: {
                name: "fix-env-access",
                steps: [
                  "Rename to NEXT_PUBLIC_ only if genuinely public",
                  "Otherwise restructure to read server-side",
                ],
              },
            });
        }
      }
    }
  },
};

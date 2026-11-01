import type { Module, Rule } from "../../types.js";
import { type AstNode, toAst } from "../../graph/ast-walk.js";
import { reportFinding, projectClientModulePaths, isIgnored } from "../helpers.js";

export const onDemandFeatureEager: Rule = {
  id: "on-demand-feature-eager",
  category: "loading",
  defaultSeverity: "error",
  run(ctx) {
    for (const path of projectClientModulePaths(ctx)) {
      if (isIgnored(ctx, "on-demand-feature-eager", path)) continue;
      const mod = ctx.graph.modules.get(path)!;
      for (const imp of mod.imports) {
        if (!imp.packageName || !ctx.data.onDemandLibs.has(imp.packageName)) continue;
        if (imp.isDynamic || imp.isTypeOnly) continue;
        if (!mod.signals.eventHandlers.length) continue;
        const onlyInHandlers = usedOnlyInHandlers(mod, imp.specifier);
        reportFinding(ctx, {
            id: `${path}:on-demand-feature-eager:${imp.packageName}`,
            ruleId: "on-demand-feature-eager",
            category: "loading",
            defaultSeverity: "error",
            confidence: onlyInHandlers ? "high" : "medium",
            file: path,
            loc: imp.loc,
            message: `On-demand lib '${imp.packageName}' eagerly imported but only used in handlers`,
            evidence: { package: imp.packageName, eventHandlers: mod.signals.eventHandlers.length },
            fixStrategy: {
              name: "handler-dynamic-import",
              steps: [
                `Replace with await import('${imp.packageName}') inside the event handler`,
              ],
            },
          });
      }
    }
  },
};

const HANDLER_NAME = /^(on|handle)[A-Z]/;

/** True when every non-import reference to the import's local bindings sits inside an event-handler scope. */
function usedOnlyInHandlers(mod: Module, specifier: string): boolean {
  const program = toAst(mod.ast());
  const locals = new Set<string>();
  for (const stmt of (program.body as AstNode[]) ?? []) {
    if (stmt.type !== "ImportDeclaration" || stmt.source?.value !== specifier) continue;
    for (const spec of (stmt.specifiers as AstNode[]) ?? []) {
      if (spec.local?.name) locals.add(spec.local.name as string);
    }
  }
  if (!locals.size) return false;

  let used = false;
  let outside = false;
  const visit = (node: AstNode, inHandler: boolean): void => {
    if (node.type === "ImportDeclaration") return;
    let handler = inHandler;
    if (node.type === "JSXAttribute" && /^on[A-Z]/.test(String(node.name?.name ?? ""))) handler = true;
    if (
      (node.type === "FunctionDeclaration" || node.type === "VariableDeclarator") &&
      node.id?.type === "Identifier" &&
      HANDLER_NAME.test(node.id.name as string)
    ) {
      handler = true;
    }
    if (
      node.type === "Property" &&
      node.key?.type === "Identifier" &&
      /^on[A-Z]/.test(node.key.name as string)
    ) {
      handler = true;
    }
    if (node.type === "Identifier" && locals.has(node.name as string)) {
      used = true;
      if (!handler) outside = true;
    }
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (!val || typeof val !== "object") continue;
      if (Array.isArray(val)) {
        for (const child of val) {
          if (child && typeof child === "object" && "type" in child) visit(child as AstNode, handler);
        }
      } else if ("type" in val) {
        visit(val as AstNode, handler);
      }
    }
  };
  visit(program, false);
  return used && !outside;
}

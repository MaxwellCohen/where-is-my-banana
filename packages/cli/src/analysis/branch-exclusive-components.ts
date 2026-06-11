import type { Program } from "oxc-parser";
import type { Import, Loc } from "../types.js";
import { locFromSpan } from "../graph/loc.js";

type AstNode = { type: string; [key: string]: unknown };

const PATH_ROOT_NAMES = new Set(["pathname", "path", "asPath", "href", "route"]);

export interface BranchExclusiveCandidate {
  componentName: string;
  branch: "consequent" | "alternate";
  jsxLoc: Loc;
  pathRootCondition: boolean;
  routes: string[];
}

export function analyzeBranchExclusiveComponents(
  source: string,
  program: Program,
  imports: Import[],
): BranchExclusiveCandidate[] {
  const lines = source.split("\n");
  const pathRoots = collectPathRoots(program);
  const candidates: BranchExclusiveCandidate[] = [];

  walk(program, (node) => {
    if (node.type === "IfStatement") {
      collectFromConditional(
        node.test as AstNode,
        node.consequent as AstNode,
        (node.alternate as AstNode | null) ?? null,
        pathRoots,
        program,
        lines,
        candidates,
      );
    }
    if (node.type === "ConditionalExpression") {
      collectFromConditional(
        node.test as AstNode,
        node.consequent as AstNode,
        node.alternate as AstNode,
        pathRoots,
        program,
        lines,
        candidates,
      );
    }
  });

  if (candidates.length === 0) return [];

  const unconditional = collectUnconditionalComponents(program, lines);
  const importedSymbols = buildImportedSymbolSet(imports);

  const byComponent = new Map<string, BranchExclusiveCandidate[]>();
  for (const c of candidates) {
    if (!importedSymbols.has(c.componentName)) continue;
    const list = byComponent.get(c.componentName) ?? [];
    list.push(c);
    byComponent.set(c.componentName, list);
  }

  const result: BranchExclusiveCandidate[] = [];
  for (const [name, entries] of byComponent) {
    if (unconditional.has(name)) continue;
    result.push(...entries);
  }

  return dedupeCandidates(result);
}

function collectFromConditional(
  test: AstNode,
  consequent: AstNode,
  alternate: AstNode | null,
  pathRoots: Set<string>,
  program: Program,
  lines: string[],
  candidates: BranchExclusiveCandidate[],
): void {
  const consequentComponents = collectComponentsInNode(consequent);
  const alternateComponents = alternate ? collectComponentsInNode(alternate) : new Set<string>();
  const pathInfo = analyzePathCondition(test, pathRoots, program);

  for (const name of consequentComponents) {
    if (alternateComponents.has(name)) continue;
    const jsxLoc = findComponentLoc(consequent, name, lines);
    if (!jsxLoc) continue;
    candidates.push({
      componentName: name,
      branch: "consequent",
      jsxLoc,
      pathRootCondition: pathInfo.pathRootCondition,
      routes: pathInfo.routes,
    });
  }

  if (!alternate) return;

  for (const name of alternateComponents) {
    if (consequentComponents.has(name)) continue;
    const jsxLoc = findComponentLoc(alternate, name, lines);
    if (!jsxLoc) continue;
    candidates.push({
      componentName: name,
      branch: "alternate",
      jsxLoc,
      pathRootCondition: pathInfo.pathRootCondition,
      routes: pathInfo.routes,
    });
  }
}

function collectComponentsInNode(node: AstNode | null): Set<string> {
  const components = new Set<string>();
  if (!node) return components;
  walk(node, (n) => {
    const name = getJsxComponentName(n);
    if (name) components.add(name);
  });
  return components;
}

function collectUnconditionalComponents(program: Program, lines: string[]): Set<string> {
  const unconditional = new Set<string>();
  walkWithAncestors(program, (node, ancestors) => {
    const name = getJsxComponentName(node);
    if (!name) return;
    if (!isUnderConditionalBranch(ancestors)) {
      unconditional.add(name);
    }
  });
  return unconditional;
}

function isUnderConditionalBranch(ancestors: AstNode[]): boolean {
  for (const anc of ancestors) {
    if (anc.type === "IfStatement" || anc.type === "ConditionalExpression") {
      return true;
    }
  }
  return false;
}

function getJsxComponentName(node: AstNode): string | null {
  if (node.type === "JSXElement") {
    return getJsxTagName(node.openingElement as AstNode);
  }
  if (node.type === "JSXSelfClosingElement") {
    return getJsxTagName(node);
  }
  return null;
}

function getJsxTagName(node: AstNode): string | null {
  const name = node.name as AstNode | undefined;
  if (!name) return null;
  if (name.type === "JSXIdentifier") {
    const id = name.name as string;
    return /^[A-Z]/.test(id) ? id : null;
  }
  if (name.type === "JSXMemberExpression") {
    let current: AstNode = name;
    while (current.type === "JSXMemberExpression") {
      current = current.object as AstNode;
    }
    if (current.type === "JSXIdentifier") {
      const id = current.name as string;
      return /^[A-Z]/.test(id) ? id : null;
    }
  }
  return null;
}

function findComponentLoc(node: AstNode, componentName: string, lines: string[]): Loc | null {
  let found: Loc | null = null;
  walk(node, (n) => {
    if (found) return;
    const name = getJsxComponentName(n);
    if (name === componentName) {
      found = locFromSpan(n, lines);
    }
  });
  return found;
}

function collectPathRoots(program: Program): Set<string> {
  const roots = new Set<string>(PATH_ROOT_NAMES);

  walk(program, (node) => {
    if (node.type === "VariableDeclarator") {
      const id = node.id as AstNode;
      const init = node.init as AstNode | null;
      if (!init || id.type !== "Identifier") return;
      if (isPathRootInit(init)) {
        roots.add(id.name as string);
      }
    }
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      const params = (node.params as AstNode[]) ?? [];
      for (const param of params) {
        if (param.type === "Identifier" && PATH_ROOT_NAMES.has(param.name as string)) {
          roots.add(param.name as string);
        }
        if (param.type === "ObjectPattern") {
          for (const prop of (param.properties as AstNode[]) ?? []) {
            if (prop.type !== "Property") continue;
            const key = prop.key as AstNode;
            if (key.type === "Identifier" && PATH_ROOT_NAMES.has(key.name as string)) {
              const value = prop.value as AstNode;
              if (value.type === "Identifier") {
                roots.add(value.name as string);
              }
            }
          }
        }
      }
    }
    if (node.type === "CallExpression") {
      const callee = node.callee as AstNode;
      if (callee.type === "Identifier" && callee.name === "usePathname") {
        const parent = node as AstNode;
        // usePathname() assignment handled via VariableDeclarator init
        void parent;
      }
    }
  });

  // Second pass: track assignments from known path roots
  walk(program, (node) => {
    if (node.type !== "VariableDeclarator") return;
    const id = node.id as AstNode;
    const init = node.init as AstNode | null;
    if (!init || id.type !== "Identifier") return;
    if (expressionUsesPathRoot(init, roots)) {
      roots.add(id.name as string);
    }
    if (init.type === "CallExpression") {
      const callee = init.callee as AstNode;
      if (callee.type === "Identifier" && callee.name === "usePathname") {
        roots.add(id.name as string);
      }
    }
  });

  return roots;
}

function isPathRootInit(init: AstNode): boolean {
  if (init.type === "CallExpression") {
    const callee = init.callee as AstNode;
    return callee.type === "Identifier" && callee.name === "usePathname";
  }
  return false;
}

function expressionUsesPathRoot(node: AstNode, pathRoots: Set<string>): boolean {
  let uses = false;
  walk(node, (n) => {
    if (uses) return;
    if (n.type === "Identifier" && pathRoots.has(n.name as string)) {
      uses = true;
    }
  });
  return uses;
}

function analyzePathCondition(
  test: AstNode,
  pathRoots: Set<string>,
  program: Program,
): { pathRootCondition: boolean; routes: string[] } {
  const routes = new Set<string>();
  let pathRootCondition = false;

  const visit = (node: AstNode) => {
    walk(node, (n) => {
      if (n.type === "Identifier" && pathRoots.has(n.name as string)) {
        pathRootCondition = true;
      }
      const route = stringLiteralRoute(n);
      if (route) routes.add(route);
    });
    if (node.type === "Identifier") {
      const init = findDeclaratorInit(program, node.name as string);
      if (init) visit(init);
    }
  };

  visit(test);
  return { pathRootCondition, routes: [...routes] };
}

function stringLiteralRoute(node: AstNode): string | null {
  if (node.type === "Literal" && typeof node.value === "string" && node.value.startsWith("/")) {
    return node.value;
  }
  if (node.type === "StringLiteral" && typeof node.value === "string" && node.value.startsWith("/")) {
    return node.value as string;
  }
  return null;
}

function findDeclaratorInit(program: Program, name: string): AstNode | null {
  let init: AstNode | null = null;
  walk(program as unknown as AstNode, (node) => {
    if (init) return;
    if (node.type !== "VariableDeclarator") return;
    const id = node.id as AstNode;
    if (id.type === "Identifier" && id.name === name) {
      init = (node.init as AstNode) ?? null;
    }
  });
  return init;
}

function buildImportedSymbolSet(imports: Import[]): Set<string> {
  const symbols = new Set<string>();
  for (const imp of imports) {
    if (imp.isDynamic || imp.isTypeOnly) continue;
    for (const sym of imp.namedSymbols) {
      if (sym && sym !== "*") symbols.add(sym);
    }
  }
  return symbols;
}

function dedupeCandidates(candidates: BranchExclusiveCandidate[]): BranchExclusiveCandidate[] {
  const seen = new Set<string>();
  const result: BranchExclusiveCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.componentName}:${c.branch}:${c.jsxLoc.line}:${c.jsxLoc.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
  }
  return result;
}

function walk(node: AstNode, visitor: (n: AstNode) => void): void {
  visitor(node);
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (!val || typeof val !== "object") continue;
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === "object" && "type" in child) {
          walk(child as AstNode, visitor);
        }
      }
    } else if ("type" in val) {
      walk(val as AstNode, visitor);
    }
  }
}

function walkWithAncestors(
  node: AstNode,
  visitor: (n: AstNode, ancestors: AstNode[]) => void,
  ancestors: AstNode[] = [],
): void {
  visitor(node, ancestors);
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (!val || typeof val !== "object") continue;
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === "object" && "type" in child) {
          walkWithAncestors(child as AstNode, visitor, [...ancestors, node]);
        }
      }
    } else if ("type" in val) {
      walkWithAncestors(val as AstNode, visitor, [...ancestors, node]);
    }
  }
}

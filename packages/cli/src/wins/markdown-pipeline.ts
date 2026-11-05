import { type AstNode, toAst } from "../graph/ast-walk.js";
import { parseSource } from "./usage-analyze.js";
import { MARKDOWN_HINT_SRC } from "./guard-heavy.js";
import type { GuardEdit } from "./guard-heavy.js";
import type { GuardCandidate } from "./usage-analyze.js";

const FN_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const offsetOf = (n: AstNode): number => (n.start ?? n.span?.start ?? 0) as number;
const endOf = (n: AstNode): number => (n.end ?? n.span?.end ?? 0) as number;

interface ImportBinding {
  local: string;
  spec: string;
  kind: "default" | "named" | "namespace";
  imported: string;
}

export interface UnifiedPipeline {
  /** `unified().use(a).use(b)` up to and including the last .use() */
  processorSrc: string;
  /** whole chain including terminal calls such as .process(x) */
  chainSrc: string;
  /** first argument of the terminal call (.process/.processSync), if any */
  inputSrc: string;
  inFunction: boolean;
  fnName: string | null;
  fnAsync: boolean;
  /** imports for `unified` and every plugin identifier used in .use(...) */
  imports: ImportBinding[];
  loc: { line: number; column: number };
}

/** Find a `unified().use(...)...` chain in `source`; null when there is none. */
export function findUnifiedPipeline(file: string, source: string): UnifiedPipeline | null {
  let program;
  try {
    program = parseSource(file, source).program;
  } catch {
    return null;
  }
  const imports = new Map<string, ImportBinding>();
  for (const st of program.body) {
    const n = toAst(st);
    if (n.type !== "ImportDeclaration" || n.importKind === "type") continue;
    for (const sp of n.specifiers ?? []) {
      if (sp.importKind === "type") continue;
      const local = sp.local?.name as string;
      if (sp.type === "ImportDefaultSpecifier") imports.set(local, { local, spec: n.source.value, kind: "default", imported: "default" });
      else if (sp.type === "ImportNamespaceSpecifier") imports.set(local, { local, spec: n.source.value, kind: "namespace", imported: "*" });
      else imports.set(local, { local, spec: n.source.value, kind: "named", imported: sp.imported?.name ?? sp.imported?.value ?? local });
    }
  }
  const unifiedLocal = [...imports.values()].find((b) => b.spec === "unified")?.local;
  if (!unifiedLocal) return null;

  let found: UnifiedPipeline | null = null;
  const visit = (node: AstNode, ancestors: AstNode[]) => {
    if (found) return;
    if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === unifiedLocal) {
      // climb `.member(args)` links
      let cur: AstNode = node;
      let i = ancestors.length - 1;
      const plugins: string[] = [];
      let lastUseEnd = endOf(node);
      let input = "";
      while (i >= 1 && ancestors[i]!.type === "MemberExpression" && ancestors[i]!.object === cur && ancestors[i - 1]!.type === "CallExpression" && ancestors[i - 1]!.callee === ancestors[i]) {
        const call = ancestors[i - 1]!;
        const name = ancestors[i]!.property?.name as string | undefined;
        if (name === "use") {
          const a0 = call.arguments?.[0];
          if (a0?.type === "Identifier") plugins.push(a0.name);
          lastUseEnd = endOf(call);
        } else if ((name === "process" || name === "processSync") && call.arguments?.[0]) {
          input = source.slice(offsetOf(call.arguments[0]), endOf(call.arguments[0]));
        }
        cur = call;
        i -= 2;
      }
      const fnIdx = ancestors.map((a) => FN_TYPES.has(a.type)).lastIndexOf(true);
      const fn = fnIdx >= 0 ? ancestors[fnIdx]! : null;
      const above = fnIdx > 0 ? ancestors[fnIdx - 1] : undefined;
      const fnName: string | null = fn
        ? (fn.id?.name ?? (above?.type === "VariableDeclarator" && above.id?.type === "Identifier" ? above.id.name : null) ?? ((above?.type === "MethodDefinition" || above?.type === "Property") && above.key?.name) ?? null)
        : null;
      const start = offsetOf(node);
      const before = source.slice(0, start).split("\n");
      found = {
        processorSrc: source.slice(start, lastUseEnd),
        chainSrc: source.slice(start, endOf(cur)),
        inputSrc: input,
        inFunction: !!fn,
        fnName,
        fnAsync: !!fn?.async,
        imports: [unifiedLocal, ...plugins].map((l) => imports.get(l)).filter((b): b is ImportBinding => !!b),
        loc: { line: before.length, column: before[before.length - 1]!.length + 1 },
      };
      return;
    }
    ancestors.push(node);
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (!val || typeof val !== "object") continue;
      if (Array.isArray(val)) {
        for (const c of val) if (c && typeof c === "object" && "type" in c) visit(c as AstNode, ancestors);
      } else if ("type" in val) visit(val as AstNode, ancestors);
    }
    ancestors.pop();
  };
  visit(toAst(program), []);
  return found;
}

/** Synthetic guard candidate so a unified pipeline (or one of its plugin imports) classifies as guard-heavy. */
export function pipelineCandidate(file: string, source: string, importedPkg: string): GuardCandidate | null {
  const p = findUnifiedPipeline(file, source);
  if (!p) return null;
  if (p.inFunction && !p.fnAsync && p.fnName && (/^[A-Z]/.test(p.fnName) || /^use[A-Z]/.test(p.fnName))) return null; // render-time
  const b = p.imports.find((x) => x.spec === importedPkg || x.spec.startsWith(`${importedPkg}/`));
  if (!b) return null;
  return {
    binding: { local: b.local, kind: b.kind, imported: b.imported },
    specifier: b.spec,
    callSrc: p.chainSrc,
    calleeSrc: "unified",
    argSrc: p.inputSrc,
    fnName: p.fnName,
    fnAsync: p.fnAsync,
    loc: p.loc,
  };
}

const destructure = (b: ImportBinding): string => (b.kind === "default" ? `{ default: ${b.local} }` : b.kind === "namespace" ? b.local : b.imported === b.local ? `{ ${b.local} }` : `{ ${b.imported}: ${b.local} }`);

/** Edit that wraps the whole unified pipeline in dynamic imports behind the markdown pre-check. */
export function buildMarkdownPipelineEdit(p: UnifiedPipeline, file: string): GuardEdit {
  const uniq = [...new Map(p.imports.map((b) => [b.local, b])).values()];
  const decl = `const [${uniq.map((b) => (b.kind === "namespace" ? b.local : destructure(b))).join(", ")}] = await Promise.all([${uniq.map((b) => `import('${b.spec}')`).join(", ")}]);`;
  const input = p.inputSrc || "input";
  const hint = `const MARKDOWN_HINT = ${MARKDOWN_HINT_SRC}; // text without markdown/HTML syntax renders as escaped plain text`;
  const lines = p.inFunction
    ? [
        hint,
        `// inside ${p.fnName ?? "the enclosing function"} (make it async), replacing the static unified/remark/rehype imports:`,
        `if (!MARKDOWN_HINT.test(${input})) return escapeHtml(${input});`,
        decl,
        `// then keep the original pipeline unchanged:`,
        p.chainSrc,
      ]
    : [
        hint,
        `// module scope: build the processor lazily and memoize it`,
        `let processorPromise;`,
        `export function getProcessor() {`,
        `  return (processorPromise ??= (async () => {`,
        `    ${decl}`,
        `    return ${p.processorSrc};`,
        `  })());`,
        `}`,
        `// at each call site: MARKDOWN_HINT.test(text) ? String(await (await getProcessor()).process(text)) : escapeHtml(text)`,
      ];
  return {
    summary: `Gate the unified pipeline in ${file} behind a markdown pre-check and import unified + plugins on demand`,
    replacementImport: lines.join("\n"),
    steps: [
      `Remove the static imports of ${uniq.map((b) => b.spec).join(", ")} from ${file}.`,
      p.inFunction
        ? `Make ${p.fnName ?? "the enclosing function"} async, add the MARKDOWN_HINT pre-check and the Promise.all dynamic imports above the existing pipeline.`
        : "Replace the module-level pipeline with the memoized getProcessor() and await it at each call site (callers become async).",
      "Provide an escapeHtml helper (replace & < > \" ') for the plain-text path.",
      "Verify output equality on sample inputs: plain strings, markdown/HTML-looking strings and empty input; widen MARKDOWN_HINT if any input renders differently.",
    ],
  };
}

import type { GuardCandidate } from "./usage-analyze.js";

/** Cheap "is there anything for the library to do?" test per library family, plus a trivial fallback expression. */
interface GuardKind {
  name: string;
  hint: string;
  /** expression for the no-library path; `$` is the first call argument */
  fallback: string;
  note: string;
}

/** Cheap "does this text contain any markdown/HTML syntax?" test (source text of the regex literal). */
export const MARKDOWN_HINT_SRC = "/[*_#`\\[\\]<>\\\\~|]|^\\s*(?:[-+]|\\d+\\.)\\s|\\n\\n/m";

const MARKDOWN: GuardKind = {
  name: "MARKDOWN_HINT",
  hint: MARKDOWN_HINT_SRC,
  fallback: "escapeHtml($)",
  note: "text without markdown/HTML syntax renders as escaped plain text",
};
const SANITIZE: GuardKind = {
  name: "HTML_HINT",
  hint: "/[<&]/",
  fallback: "$",
  note: "a string with no `<` or `&` has nothing to sanitize",
};
const HIGHLIGHT: GuardKind = {
  name: "CODE_HINT",
  hint: "/[{}();=<>]/",
  fallback: "escapeHtml($)",
  note: "text without code punctuation does not need highlighting",
};
const MATH: GuardKind = { name: "MATH_HINT", hint: "/[\\\\^_{}]/", fallback: "$", note: "text without TeX syntax needs no rendering" };
const DATE: GuardKind = { name: "HAS_VALUE", hint: "/\\S/", fallback: "''", note: "empty input needs no date formatting" };
const YAML: GuardKind = { name: "YAML_HINT", hint: "/[:\\-\\[{]/", fallback: "null", note: "scalar-free text has no YAML structure" };

const TABLE: [RegExp, GuardKind][] = [
  [/^(marked|markdown-it(-.+)?|showdown|commonmark|react-markdown|snarkdown|unified|remark(-.+)?|rehype(-.+)?|micromark(-.+)?|mdast-.+|hast-.+|@mdx-js\/.+|mdx)$/, MARKDOWN],
  [/^(sanitize-html|dompurify|isomorphic-dompurify|xss)$/, SANITIZE],
  [/^(highlight\.js|prismjs|prism-react-renderer|shiki)$/, HIGHLIGHT],
  [/^(katex|mathjax.*)$/, MATH],
  [/^(moment|moment-timezone|dayjs|date-fns|luxon)$/, DATE],
  [/^(yaml|js-yaml)$/, YAML],
];

export function guardKindFor(pkg: string): GuardKind | null {
  for (const [re, k] of TABLE) if (re.test(pkg)) return k;
  return null;
}

const SAFE_ID = /^[A-Za-z_$][\w$]*$/;

/** `(await import('x')).named` / `.default` / namespace, used in place of the binding at the call site. */
function loaded(c: GuardCandidate): string {
  const spec = `'${c.specifier}'`;
  const b = c.binding;
  if (b.kind === "namespace") return `(await import(${spec}))`;
  if (b.kind === "default") return `(await import(${spec})).default`;
  return SAFE_ID.test(b.imported) ? `(await import(${spec})).${b.imported}` : `(await import(${spec}))["${b.imported}"]`;
}

export interface GuardEdit {
  summary: string;
  replacementImport: string;
  steps: string[];
}

export function buildGuardEdit(pkg: string, c: GuardCandidate, file: string): GuardEdit | null {
  const kind = guardKindFor(pkg);
  if (!kind) return null;
  const arg = c.argSrc || "input";
  // Replace the binding at the head of the callee (`marked.parse` -> `(await import('marked')).marked.parse`).
  const callee = c.calleeSrc.startsWith(c.binding.local) ? `${loaded(c)}${c.calleeSrc.slice(c.binding.local.length)}` : loaded(c);
  const rest = c.callSrc.slice(c.calleeSrc.length);
  const heavy = `${callee}${rest}`;
  const fallback = kind.fallback.replace(/\$/g, arg);
  const fn = c.fnName ?? "the enclosing function";
  return {
    summary: `Guard ${pkg} behind a cheap pre-check in ${file} and import it only when needed`,
    replacementImport: [
      `const ${kind.name} = ${kind.hint}; // ${kind.note}`,
      `// at the call site in ${fn}:`,
      `${kind.name}.test(${arg}) ? ${heavy} : ${fallback}`,
    ].join("\n"),
    steps: [
      `Remove the static import of ${pkg} in ${file}.`,
      `Add the ${kind.name} pre-check next to ${fn} and replace \`${c.callSrc}\` with the guarded expression${c.fnAsync ? "" : " (make the enclosing function async, or load the library in an effect)"}.`,
      ...(kind.fallback.includes("escapeHtml") ? ["Provide an escapeHtml helper (replace & < > \" ') for the plain-text path."] : []),
      `Verify output equality on sample inputs: run the old and new code on plain strings, markdown/HTML-looking strings and empty input and compare results. The pre-check is a heuristic: widen it if any input renders differently.`,
    ],
  };
}

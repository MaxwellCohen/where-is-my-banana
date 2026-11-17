import type { CheckName, Finding, SourceFile } from "./types.js";

export const CODE_RE = /\.(?:[cm]?[jt]sx?)$/;
export const JSX_RE = /\.[jt]sx$/;

export function lineAt(content: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) n++;
  return n;
}

export function find(
  check: CheckName,
  f: Pick<Finding, "severity" | "file" | "line" | "message" | "fix"> & { id?: string },
): Finding {
  return { id: f.id ?? check, check, severity: f.severity, file: f.file, line: f.line, message: f.message, fix: f.fix };
}

export function isCode(f: SourceFile): boolean {
  return CODE_RE.test(f.path) && !/\.d\.ts$/.test(f.path) && !isTestFile(f.path);
}

export function isTestFile(p: string): boolean {
  return /(?:\.(?:test|spec|stories)\.[cm]?[jt]sx?$)|(?:^|\/)(?:__tests__|__mocks__|tests?|e2e|cypress|\.storybook)\//.test(p);
}

export function isClient(content: string): boolean {
  return /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*["']use client["']/.test(content);
}

export function isLayoutLike(p: string): boolean {
  return /(?:^|\/)(?:layout|_document|_app|head)\.[cm]?[jt]sx?$/.test(p);
}

export function isRootLayout(p: string): boolean {
  return /(?:^|\/)(?:src\/)?app\/(?:\([^/]+\)\/)*layout\.[cm]?[jt]sx?$/.test(p);
}

export function isAppFile(p: string, name: string): boolean {
  return new RegExp(`(?:^|/)app/(?:.+/)?${name}\\.[cm]?[jt]sx?$`).test(p);
}

/** Run `re` (must be global) over content, yielding match + 1-based line. */
export function* matches(content: string, re: RegExp): Generator<{ m: RegExpExecArray; line: number }> {
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = r.exec(content))) {
    yield { m, line: lineAt(content, m.index) };
    if (m[0] === "") r.lastIndex++;
  }
}

export function allDeps(json: Record<string, any>): Record<string, string> {
  return { ...json.devDependencies, ...json.peerDependencies, ...json.dependencies };
}

/** Resolve a relative/alias import specifier to a file in the list (best effort). */
export function resolveImport(from: string, spec: string, files: Map<string, SourceFile>): SourceFile | undefined {
  let base: string;
  if (spec.startsWith(".")) {
    const parts = from.split("/").slice(0, -1);
    for (const seg of spec.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== ".") parts.push(seg);
    }
    base = parts.join("/");
  } else if (spec.startsWith("@/") || spec.startsWith("~/")) {
    base = spec.slice(2);
  } else return undefined;
  const exts = ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];
  for (const prefix of spec.startsWith(".") ? [""] : ["", "src/"]) {
    for (const e of exts) {
      const hit = files.get(prefix + base + e);
      if (hit) return hit;
    }
  }
  // monorepo: alias may live under a workspace dir
  for (const [p, f] of files) {
    if (!spec.startsWith(".") && CODE_RE.test(p)) {
      for (const e of exts) if (p.endsWith("/" + base + e) || p.endsWith("/src/" + base + e)) return f;
    }
  }
  return undefined;
}

export function importsOf(content: string): { spec: string; line: number; clause: string }[] {
  const out: { spec: string; line: number; clause: string }[] = [];
  for (const { m, line } of matches(content, /^\s*import\s+([^"';]*?)\s*from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm)) {
    out.push({ spec: m[2] ?? m[3], line, clause: m[1] ?? "" });
  }
  return out;
}

const MAX_TAG_LEN = 5000;

export interface JsxTag {
  /** Regex-match-shaped: [0] full tag text, [1] attribute text, `index` start. */
  m: [string, string] & { index: number };
  line: number;
  name: string;
  text: string;
  attrs: string;
}

/**
 * Find opening tags `<Name ...>` (Name is a regex source, e.g. "Script" or "[A-Z]\\w*").
 * Unlike a `[^>]*` regex, the end `>` is the first one outside `{}` and string literals,
 * so `onLoad={() => x()}` and `alt="a > b"` do not end the tag early.
 */
export function* jsxTags(content: string, nameSource: string): Generator<JsxTag> {
  const re = new RegExp(`<(${nameSource})\\b`, "g");
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(content))) {
    const start = hit.index;
    const attrsFrom = start + hit[0].length;
    const limit = Math.min(content.length, start + MAX_TAG_LEN);
    let depth = 0;
    let quote = "";
    let end = -1;
    for (let i = attrsFrom; i < limit; i++) {
      const ch = content[i];
      if (quote) {
        if (ch === "\\" && depth > 0) i++; // JSX attribute strings have no escapes; JS strings in `{}` do
        else if (ch === quote) quote = "";
        else if (ch === "\n" && depth > 0 && quote !== "`") quote = ""; // a JS string ends on its line: this was an apostrophe in text
      } else if (depth > 0 && ch === "/" && content[i + 1] === "*") {
        const close = content.indexOf("*/", i + 2); // `{/* don't */}`: a quote in a comment is not a string
        if (close < 0) break;
        i = close + 1;
      } else if (depth > 0 && ch === "/" && content[i + 1] === "/" && /[\s{};,()]/.test(content[i - 1])) {
        const nl = content.indexOf("\n", i + 2); // `// don't`: same for a line comment (not `http://` or a regex's `\/\/`)
        if (nl < 0) break;
        i = nl;
      } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
      else if (ch === ">" && depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) continue;
    const text = content.slice(start, end + 1);
    const attrs = content.slice(attrsFrom, end);
    const m = Object.assign([text, attrs] as [string, string], { index: start });
    re.lastIndex = end + 1;
    yield { m, line: lineAt(content, start), name: hit[1], text, attrs };
  }
}

/** Local name bound to the default import of `next/dynamic`, or null. */
export function dynamicImportName(content: string): string | null {
  for (const i of importsOf(content)) {
    if (i.spec !== "next/dynamic") continue;
    const def = i.clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/) ?? i.clause.match(/\bdefault\s+as\s+([A-Za-z_$][\w$]*)/);
    if (def) return def[1];
  }
  return null;
}

function inComment(content: string, index: number): boolean {
  let quote = "";
  for (let i = 0; i < index; i++) {
    const ch = content[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote || (ch === "\n" && quote !== "`")) quote = "";
    } else if (ch === "/" && content[i + 1] === "/") {
      const nl = content.indexOf("\n", i);
      if (nl < 0 || nl >= index) return true;
      i = nl;
    } else if (ch === "/" && content[i + 1] === "*") {
      const close = content.indexOf("*/", i + 2);
      if (close < 0 || close + 1 >= index) return true;
      i = close + 1;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
  }
  return false;
}

/** True when `index` (an `ssr: false` match) is inside the argument list of a call to next/dynamic's default import. */
export function inDynamicCall(content: string, index: number): boolean {
  const name = dynamicImportName(content);
  if (!name || inComment(content, index)) return false;
  let depth = 0;
  const floor = Math.max(0, index - 20_000);
  for (let i = index - 1; i >= floor; i--) {
    const ch = content[i];
    if (ch === ")" || ch === "}" || ch === "]") depth++;
    else if (ch === "(" || ch === "{" || ch === "[") {
      if (depth > 0) depth--;
      else if (ch === "(") {
        const callee = content.slice(Math.max(0, i - 200), i).match(/([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*$/);
        return callee?.[1] === name;
      }
    }
  }
  return false;
}

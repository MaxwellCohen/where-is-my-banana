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

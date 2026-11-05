const escapeRe = (c: string) => c.replace(/[.+^$()|\\/{}[\]*?]/g, "\\$&");

/** Convert a glob (`*`, `**`, `?`, `{a,b}`, `[abc]`/`[!abc]`) to an anchored RegExp over posix paths. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/^\.\//, "").replace(/^\//, "");
  let re = "";
  let depth = 0;
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else if (i + 2 === g.length && re.endsWith("\\/")) {
          re = re.slice(0, -2) + "(?:/.*)?";
          i += 1;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (ch === "{") {
      depth++;
      re += "(?:";
    } else if (ch === "}" && depth > 0) {
      depth--;
      re += ")";
    } else if (ch === "," && depth > 0) re += "|";
    else if (ch === "[") {
      const end = g.indexOf("]", i + 2);
      if (end > i) {
        let cls = g.slice(i + 1, end);
        if (cls[0] === "!") cls = "^" + cls.slice(1);
        re += "[" + cls.replace(/\\/g, "\\\\") + "]";
        i = end;
      } else re += "\\[";
    } else if (ch === "\\" && i + 1 < g.length) re += escapeRe(g[++i]);
    else re += escapeRe(ch);
  }
  while (depth-- > 0) re += ")";
  return new RegExp("^" + re + "$");
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path);
}

/**
 * gitignore-flavoured ignore matcher: patterns without `/` match at any depth, a pattern also
 * matches everything beneath a matched directory, `!pattern` re-includes (last match wins).
 */
export function makeIgnoreMatcher(globs: readonly string[]): (path: string) => boolean {
  const rules = globs
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const negate = raw.startsWith("!");
      let g = negate ? raw.slice(1) : raw;
      g = g.replace(/^\.\//, "").replace(/\/+$/, "");
      if (!g.includes("/")) g = "**/" + g;
      return { negate, re: [globToRegExp(g), globToRegExp(g + "/**")] };
    });
  return (path) => {
    let ignored = false;
    for (const r of rules) if (r.re.some((x) => x.test(path))) ignored = !r.negate;
    return ignored;
  };
}

/** Strip Turbopack virtual prefixes like `[project]/` / `[client-fs]/`. */
export function normalizeModulePath(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/^\[project\]\//, "")
    .replace(/^\[client-fs\]\//, "")
    .replace(/^\[project\]/, "")
    .replace(/^\[client-fs\]/, "")
    .replace(/\\/g, "/");
}

export function packageNameFromPath(path: string): string | null {
  const marker = "node_modules/";
  const idx = path.lastIndexOf(marker);
  if (idx === -1) return null;
  const rest = path.slice(idx + marker.length);
  if (rest.startsWith("@")) {
    const parts = rest.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return rest.split("/")[0] ?? null;
}

export function isClientJavaScriptOutput(filename: string): boolean {
  return filename.startsWith("[client-fs]/") && filename.endsWith(".js");
}

/** Server / RSC JS outputs (any `.js` that is not client-fs). */
export function isServerJavaScriptOutput(filename: string): boolean {
  return filename.endsWith(".js") && !filename.startsWith("[client-fs]/");
}

/** First-party app/source files (not deps, Next internals, or synthetic nodes). */
export function isAppSourcePath(path: string): boolean {
  if (!path) return false;
  if (path.startsWith("source:")) return false;
  if (path.startsWith("[")) return false;
  if (path.endsWith("/")) return false;
  if (path.includes("node_modules/")) return false;
  if (path.startsWith("next/") || path.startsWith("_next/")) return false;
  if (path.startsWith("turbopack/") || path.startsWith("[turbopack]")) return false;
  const base = path.split("/").pop() ?? path;
  return /\.(tsx?|jsx?|mjs|cjs|css|scss)$/i.test(base);
}

/** Short display label: package name for node_modules, otherwise the path. */
export function displayLabel(path: string): string {
  return packageNameFromPath(path) ?? path;
}

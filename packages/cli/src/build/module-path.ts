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

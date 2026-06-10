import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface ReplacementInfo {
  replacement: string;
  manifest: string;
  docsUrl?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function manifestPath(name: string): string | null {
  const candidates = [
    join(process.cwd(), "node_modules", "module-replacements", "manifests", name),
    join(__dirname, "..", "..", "node_modules", "module-replacements", "manifests", name),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadReplacements(): Map<string, ReplacementInfo> {
  const result = new Map<string, ReplacementInfo>();
  for (const manifest of ["native.json", "micro-utilities.json", "preferred.json"]) {
    const path = manifestPath(manifest);
    if (!path) continue;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8")) as Record<
        string,
        { replacement?: string; native?: string; docs?: string; url?: string }
      >;
      for (const [pkg, info] of Object.entries(data)) {
        result.set(pkg, {
          replacement: info.replacement ?? info.native ?? "native API",
          manifest: manifest.replace(".json", ""),
          docsUrl: info.docs ?? info.url,
        });
      }
    } catch {
      // manifest unavailable
    }
  }
  return result;
}

export function loadNativeReplacements(): Map<string, string> {
  const result = new Map<string, string>();
  const path = manifestPath("native.json");
  if (!path) return result;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Record<
      string,
      { native?: string; replacement?: string }
    >;
    for (const [pkg, info] of Object.entries(data)) {
      result.set(pkg, info.native ?? info.replacement ?? "native API");
    }
  } catch {
    // ignore
  }
  return result;
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const ENTRY_PATHS = [
  "app",
  "src/app",
  "pages",
  "src/pages",
  "middleware.ts",
  "src/middleware.ts",
];

export function validateProject(projectRoot: string): ValidationResult {
  const errors: string[] = [];
  const pkgPath = join(projectRoot, "package.json");

  if (!existsSync(pkgPath)) {
    errors.push("package.json not found in project root");
    return { ok: false, errors };
  }

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    errors.push("package.json is not valid JSON");
    return { ok: false, errors };
  }

  const hasNext =
    pkg.dependencies?.next != null || pkg.devDependencies?.next != null;
  if (!hasNext) {
    errors.push("'next' must be listed in dependencies or devDependencies");
  }

  const hasEntry = ENTRY_PATHS.some((p) => existsSync(join(projectRoot, p)));
  if (!hasEntry) {
    errors.push(
      "No Next.js entry found (expected app/, src/app/, pages/, src/pages/, or middleware.ts)",
    );
  }

  return { ok: errors.length === 0, errors };
}

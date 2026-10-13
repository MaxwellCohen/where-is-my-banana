import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Finding, Severity, WimbConfig } from "../types.js";

/**
 * Diagnostics WIMB already covers — skip to avoid duplicate findings.
 */
const SKIP_DIAGNOSTIC_IDS = new Set([
  "client-forbidden-import",
  "use-client-unnecessary",
  "oversized-client-component", // overlapped by heavy-client-import / route-over-budget heuristics
  "client-component-oversized",
]);

interface RscXrayDiagnostic {
  id?: string;
  ruleId?: string;
  code?: string;
  message?: string;
  severity?: string;
  file?: string;
  filePath?: string;
  line?: number;
  column?: number;
  category?: string;
}

interface RscXrayModel {
  diagnostics?: RscXrayDiagnostic[];
  findings?: RscXrayDiagnostic[];
  issues?: RscXrayDiagnostic[];
}

const SEVERITY_MAP: Record<string, Severity> = {
  error: "error",
  warn: "warning",
  warning: "warning",
  info: "info",
  hint: "info",
};

/**
 * Opt-in integration with @rsc-xray/analyzer.
 * Maps unique RSC diagnostics (serialization, duplicates, suspense) to findings.
 */
export async function runRscXrayAnalysis(
  projectRoot: string,
  config: WimbConfig,
): Promise<Finding[]> {
  try {
    const model = await invokeAnalyzer(projectRoot);
    if (!model) return [];
    const diagnostics = model.diagnostics ?? model.findings ?? model.issues ?? [];
    return diagnostics
      .map((d, i) => toFinding(d, i, config))
      .filter((f): f is Finding => f != null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`wimb: rsc-xray analysis skipped (${message})`);
    return [];
  }
}

async function invokeAnalyzer(projectRoot: string): Promise<RscXrayModel | null> {
  // Resolve from the target project first, then from wimb's own deps
  const candidates = [projectRoot, join(projectRoot, "..")];
  for (const base of candidates) {
    try {
      const require = createRequire(join(base, "package.json"));
      const entry = require.resolve("@rsc-xray/analyzer");
      const mod = (await import(pathToFileURL(entry).href)) as {
        analyze?: (opts: { projectRoot: string; cwd?: string }) => Promise<RscXrayModel>;
        default?: {
          analyze?: (opts: { projectRoot: string; cwd?: string }) => Promise<RscXrayModel>;
        };
      };
      const analyze = mod.analyze ?? mod.default?.analyze;
      if (typeof analyze === "function") {
        return await analyze({ projectRoot, cwd: projectRoot });
      }
    } catch {
      // try next
    }
  }

  // Fallback: dynamic import by package name (when installed alongside wimb)
  let importError: unknown;
  try {
    const mod = (await import("@rsc-xray/analyzer")) as {
      analyze?: (opts: { projectRoot: string }) => Promise<RscXrayModel>;
      default?: { analyze?: (opts: { projectRoot: string }) => Promise<RscXrayModel> };
    };
    const analyze = mod.analyze ?? mod.default?.analyze;
    if (typeof analyze === "function") {
      return await analyze({ projectRoot });
    }
  } catch (err) {
    importError = err;
  }

  if (importError) throw importError;
  console.error(
    "wimb: @rsc-xray/analyzer not found. Install it in the target app or as a peer dependency.",
  );
  return null;
}

function toFinding(
  diag: RscXrayDiagnostic,
  index: number,
  config: WimbConfig,
): Finding | null {
  const rawId = diag.ruleId ?? diag.id ?? diag.code ?? "unknown";
  if (SKIP_DIAGNOSTIC_IDS.has(rawId)) return null;

  const ruleId = rawId.startsWith("rsc-xray:") ? rawId : `rsc-xray:${rawId}`;
  const severity =
    config.severityOverrides[ruleId] ??
    SEVERITY_MAP[diag.severity ?? "info"] ??
    "info";
  const file = diag.filePath ?? diag.file ?? "unknown";

  return {
    id: `rsc-xray:${index}:${ruleId}:${file}`,
    ruleId,
    category: diag.category ?? mapCategory(rawId),
    severity,
    confidence: "high",
    file,
    loc: diag.line ? { line: diag.line, column: diag.column ?? 1 } : undefined,
    message: diag.message ?? `rsc-xray: ${rawId}`,
    evidence: { "rsc-xray": diag },
    fixStrategy: {
      name: "rsc-xray-review",
      steps: [
        "Review the rsc-xray diagnostic and apply the suggested remediation",
        "See https://github.com/rsc-xray/rsc-xray for codemods when available",
      ],
    },
    source: "rsc-xray",
  };
}

function mapCategory(id: string): string {
  if (id.includes("serial") || id.includes("forbidden") || id.includes("server-only")) {
    return "misplacement";
  }
  if (id.includes("suspense") || id.includes("waterfall") || id.includes("duplicate")) {
    return "loading";
  }
  if (id.includes("boundary") || id.includes("client")) return "boundary";
  return "dependency";
}

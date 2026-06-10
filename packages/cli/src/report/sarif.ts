import type { ScanReport } from "../types.js";

export function toSarif(report: ScanReport) {
  return {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "wimb",
            version: report.version,
            informationUri: "https://github.com/where-is-my-banana",
            rules: [...new Set(report.findings.map((f) => f.ruleId))].map((id) => ({
              id,
              shortDescription: { text: id },
            })),
          },
        },
        results: report.findings.map((f) => ({
          ruleId: f.ruleId,
          level: f.severity === "error" ? "error" : f.severity === "warning" ? "warning" : "note",
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file },
                region: f.loc
                  ? { startLine: f.loc.line, startColumn: f.loc.column }
                  : undefined,
              },
            },
          ],
          properties: {
            confidence: f.confidence,
            estimatedBytes: f.estimatedBytes,
            fixStrategy: f.fixStrategy,
            evidence: f.evidence,
          },
        })),
      },
    ],
  };
}

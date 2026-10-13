declare module "@rsc-xray/analyzer" {
  export interface RscXrayAnalyzeOptions {
    projectRoot?: string;
    cwd?: string;
  }

  export interface RscXrayAnalyzeResult {
    diagnostics?: unknown[];
    findings?: unknown[];
    issues?: unknown[];
  }

  export function analyze(opts: RscXrayAnalyzeOptions): Promise<RscXrayAnalyzeResult>;
  const _default: { analyze?: typeof analyze };
  export default _default;
}

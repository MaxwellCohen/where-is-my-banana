import { join } from "node:path";

export const WIMB_OUTPUT_DIR = ".wimb";

export function resolveOutputDir(projectRoot: string): string {
  return join(projectRoot, WIMB_OUTPUT_DIR);
}

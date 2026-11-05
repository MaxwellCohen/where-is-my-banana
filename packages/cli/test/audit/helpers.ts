import { auditContext, buildContext } from "../../src/audit/index.js";
import type { CheckName } from "../../src/audit/types.js";

export function run(check: CheckName, files: Record<string, string>) {
  const ctx = buildContext(Object.entries(files).map(([path, content]) => ({ path, content })));
  return auditContext(ctx, [check]);
}

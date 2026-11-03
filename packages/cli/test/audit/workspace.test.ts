import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAudit } from "../../src/audit/index.js";

function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "wimb-ws-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}
const img = `export const A = () => <img src="x" />;`;
const next = (name: string) => JSON.stringify({ name, dependencies: { next: "15" } });

describe("monorepo support", () => {
  it("audits each Next app from pnpm-workspace.yaml and labels findings", () => {
    const root = project({
      "pnpm-workspace.yaml": `packages:\n  - 'apps/*'\n  - 'packages/*'\n`,
      "package.json": JSON.stringify({ name: "root", private: true }),
      "apps/web/package.json": next("@acme/web"),
      "apps/web/app/a.tsx": img,
      "apps/docs/package.json": next("@acme/docs"),
      "apps/docs/app/b.tsx": img,
      "packages/ui/package.json": JSON.stringify({ name: "@acme/ui" }),
      "packages/ui/src/c.tsx": img,
    });
    const r = runAudit({ projectRoot: root, checks: ["raw-img"] });
    expect(r.packages?.sort()).toEqual(["@acme/docs", "@acme/web"]);
    expect(r.findings.map((f) => [f.file, f.package]).sort()).toEqual([
      ["apps/docs/app/b.tsx", "@acme/docs"],
      ["apps/web/app/a.tsx", "@acme/web"],
    ]);
  });
  it("supports package.json workspaces and honors glob ignores", () => {
    const root = project({
      "package.json": JSON.stringify({ name: "root", workspaces: ["apps/*"] }),
      "apps/web/package.json": next("web"),
      "apps/web/app/a.tsx": img,
      "apps/web/app/legacy/b.tsx": img,
    });
    const r = runAudit({ projectRoot: root, checks: ["raw-img"], ignoreFiles: ["apps/*/app/legacy/**"] });
    expect(r.findings.map((f) => f.file)).toEqual(["apps/web/app/a.tsx"]);
  });
  it("falls back to a single project without workspaces", () => {
    const root = project({ "package.json": next("solo"), "app/a.tsx": img });
    const r = runAudit({ projectRoot: root, checks: ["raw-img"] });
    expect(r.packages).toBeUndefined();
    expect(r.findings[0].package).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  attachTestImpact,
  clearTestImpactCache,
  detectTestRunner,
  findTestImpact,
  formatTestImpactMarkdown,
} from "../../src/wins/test-impact.js";
import type { Win } from "../../src/wins/types.js";

let root: string;
function put(rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}
const pkg = (scripts: Record<string, string> = {}, dev: Record<string, string> = {}) =>
  put("package.json", JSON.stringify({ scripts, devDependencies: dev }));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wimb-ti-"));
  clearTestImpactCache();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function mkWin(fixKind: Win["fixKind"], packageName: string | null = null): Win {
  return {
    id: "x",
    fixKind,
    edge: { importer: "src/Page.tsx", imported: "src/Chart.tsx", packageName },
    edit: { summary: "s", steps: ["a"], verify: "wimb verify" },
  } as unknown as Win;
}

describe("detectTestRunner", () => {
  it("reads vitest/jest from test script", () => {
    pkg({ test: "vitest run" }, { jest: "1" });
    expect(detectTestRunner(root).runner).toBe("vitest");
    pkg({ test: "jest --ci" }, { vitest: "1" });
    expect(detectTestRunner(root).runner).toBe("jest");
  });
  it("falls back to deps, else null", () => {
    pkg({}, { jest: "1" });
    expect(detectTestRunner(root).runner).toBe("jest");
    pkg();
    expect(detectTestRunner(root).runner).toBeNull();
  });
});

describe("findTestImpact", () => {
  it("returns null with no tests", async () => {
    put("src/Chart.tsx", "export default 1");
    expect(await findTestImpact(root, ["src/Chart.tsx"])).toBeNull();
  });

  it("finds direct, one-hop and alias tests", async () => {
    pkg({ test: "vitest run" });
    put("pnpm-lock.yaml", "");
    put("src/Chart.tsx", "export default 1");
    put("src/Page.tsx", "import C from './Chart';");
    put("src/a.test.tsx", "import C from './Chart';");
    put("src/b.test.tsx", "import P from './Page';");
    put("src/__tests__/c.tsx", "import C from '@/Chart';");
    put("src/d.test.tsx", "import x from './other';");
    put("src/other.ts", "export const x = 1");
    const r = await findTestImpact(root, ["src/Page.tsx", "src/Chart.tsx"]);
    expect(r!.files).toEqual(["src/__tests__/c.tsx", "src/a.test.tsx", "src/b.test.tsx"]);
    expect(r!.runner).toBe("vitest");
    expect(r!.command).toBe("pnpm exec vitest run src/__tests__/c.tsx src/a.test.tsx src/b.test.tsx");
    expect(r!.setupMock).toContain("vi.mock('next/dynamic'");
  });

  it("emits each warning kind, jest command and mock", async () => {
    pkg({ test: "jest" });
    put("src/Chart.tsx", "export default 1");
    put(
      "src/a.test.tsx",
      "import C from './Chart';\njest.useFakeTimers();\nscreen.getByText('x');\nexpect(t).toMatchSnapshot();",
    );
    const r = (await findTestImpact(root, ["src/Chart.tsx"]))!;
    expect(r.warnings).toHaveLength(3);
    expect(r.warnings.every((w) => w.startsWith("src/a.test.tsx: "))).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/findBy[\s\S]*fake timers[\s\S]*snapshot/);
    expect(r.command).toBe("npx jest --runTestsByPath src/a.test.tsx");
    expect(r.setupMock).toContain("jest.mock('next/dynamic'");
  });
});

describe("attachTestImpact", () => {
  it("updates steps and verify for lazy wins only", async () => {
    pkg({ test: "vitest" });
    put("src/Chart.tsx", "export default 1");
    put("src/a.test.tsx", "import C from './Chart';\nscreen.getByText('x')");
    const lazy = mkWin("lazy");
    const other = mkWin("remove");
    await attachTestImpact([lazy, other], root);
    expect(lazy.testImpact!.files).toEqual(["src/a.test.tsx"]);
    expect(lazy.edit.steps.some((s) => s.startsWith("Update/run these tests: src/a.test.tsx (1 warning(s)"))).toBe(true);
    expect(lazy.edit.verify.startsWith("npx vitest run src/a.test.tsx && ")).toBe(true);
    expect(other.testImpact).toBeUndefined();
    expect(other.edit.steps).toEqual(["a"]);
    const md = formatTestImpactMarkdown(lazy).join("\n");
    expect(md).toContain("Tests affected");
    expect(md).toContain("```");
    expect(formatTestImpactMarkdown(other)).toEqual([]);
  });
});

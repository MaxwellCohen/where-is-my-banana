import { describe, it, expect } from "vitest";
import { computeFixes } from "../../src/audit/fix.js";
import { run } from "./helpers.js";

const check = (path: string, content: string) => {
  const findings = run("ssr-false-misuse", { [path]: content });
  return { findings, res: computeFixes([{ path, content }], findings) };
};

describe("ssr-false-misuse is tied to next/dynamic", () => {
  it("ignores tRPC-style ssr: false in app/layout.tsx", () => {
    const c = `import { createTRPCNext } from "@trpc/next";\nexport const t = createTRPCNext({ ssr: false });\nexport default function L() { return null; }\n`;
    const { findings, res } = check("app/layout.tsx", c);
    expect(findings).toEqual([]);
    expect(res.edits).toEqual([]);
  });
  it("ignores ssr: false in an unrelated call even when dynamic is imported", () => {
    const c = `import dynamic from "next/dynamic";\nexport const a = withApollo(Page, { ssr: false });\n`;
    expect(check("app/page.tsx", c).findings).toEqual([]);
  });
  it("ignores commented-out ssr: false", () => {
    const c = `import dynamic from "next/dynamic";\n// const M = dynamic(() => import("./Map"), { ssr: false });\n/* { ssr: false } */\nexport default function P() { return null; }\n`;
    expect(check("app/page.tsx", c).findings).toEqual([]);
  });
  it("still flags and fixes a real dynamic() in a server file", () => {
    const c = `import dynamic from "next/dynamic";\nconst Map = dynamic(() => import("./Map"), { ssr: false });\nexport default function P() { return <Map />; }\n`;
    const { findings, res } = check("app/page.tsx", c);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("high");
    expect(res.edits[0].after).not.toContain("ssr");
  });
  it("honours a renamed default import", () => {
    const c = `import lazy from "next/dynamic";\nconst Map = lazy(() => import("./Map"), { ssr: false });\nexport default function P() { return <Map />; }\n`;
    const { findings, res } = check("app/page.tsx", c);
    expect(findings).toHaveLength(1);
    expect(res.edits).toHaveLength(1);
  });
  it("fixer picks the dynamic() occurrence when another ssr: false is on the same line", () => {
    const c = `import dynamic from "next/dynamic";\nconst x = foo({ ssr: false }), Map = dynamic(() => import("./Map"), { ssr: false });\nexport default function P() { return null; }\n`;
    const { res } = check("app/page.tsx", c);
    expect(res.edits[0].after).toContain("foo({ ssr: false })");
    expect(res.edits[0].after).not.toMatch(/dynamic\([^)]*ssr/);
  });
  it("reports nothing when next/dynamic is not imported", () => {
    const c = `const Map = dynamic(() => import("./Map"), { ssr: false });\n`;
    expect(check("app/page.tsx", c).findings).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { run } from "./helpers.js";

describe("use-client-inventory", () => {
  it("counts use client files per route dir and lists layout client imports", () => {
    const f = run("use-client-inventory", {
      "app/layout.tsx": `import Nav from "../components/Nav";\nexport default () => <Nav/>;`,
      "components/Nav.tsx": `"use client";\nexport default () => null;`,
      "app/blog/Like.tsx": `"use client";\nexport default () => null;`,
      "app/blog/page.tsx": `export default () => null;`,
    });
    expect(f.some((x) => x.id === "use-client-inventory/count")).toBe(false); // below the noise threshold
    expect(f.find((x) => x.id === "use-client-inventory/layout")?.message).toContain("components/Nav.tsx");
  });
  it("counts buckets with many client files", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`app/blog/C${i}.tsx`] = `"use client";\nexport default () => null;`;
    expect(run("use-client-inventory", files).some((x) => x.id === "use-client-inventory/count" && x.file === "app/blog")).toBe(true);
  });
  it("reports nothing without client files", () => {
    expect(run("use-client-inventory", { "app/page.tsx": `export default () => null;` })).toHaveLength(0);
  });
});

describe("ssr-false-misuse", () => {
  it("flags ssr:false in a server component as high", () => {
    const c = `import dynamic from "next/dynamic";\nconst M = dynamic(() => import("./Map"), { ssr: false });`;
    expect(run("ssr-false-misuse", { "app/page.tsx": c })[0]).toMatchObject({ severity: "high", id: "ssr-false-misuse/server-component" });
  });
  it("flags ssr:false on a hero/registry component", () => {
    const c = `"use client";\nimport dynamic from "next/dynamic";\nconst H = dynamic(() => import("./Hero"), { ssr: false });`;
    expect(run("ssr-false-misuse", { "components/registry.tsx": c })[0].severity).toBe("medium");
  });
  it("allows ssr:false on a client leaf", () => {
    const c = `"use client";\nimport dynamic from "next/dynamic";\nconst M = dynamic(() => import("./Chart"), { ssr: false });`;
    expect(run("ssr-false-misuse", { "components/Stats.tsx": c })).toHaveLength(0);
  });
});

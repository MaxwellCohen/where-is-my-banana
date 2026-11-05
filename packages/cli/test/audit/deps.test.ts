import { describe, it, expect } from "vitest";
import { run } from "./helpers.js";

const pkg = (o: object) => JSON.stringify(o, null, 2);

describe("heavy-deps", () => {
  it("flags heavy and duplicate libs", () => {
    const f = run("heavy-deps", {
      "package.json": pkg({ dependencies: { moment: "2", "date-fns": "3", swr: "2", "@tanstack/react-query": "5", "react-icons": "5", "lucide-react": "1" } }),
    });
    const ids = f.map((x) => x.id);
    expect(ids).toContain("heavy-deps/moment");
    expect(ids).toContain("heavy-deps/duplicate-fetching");
    expect(ids).toContain("heavy-deps/duplicate-date");
    expect(ids).toContain("heavy-deps/duplicate-icons");
  });
  it("reads workspace package.json files and escalates CMS SDK in client files", () => {
    const f = run("heavy-deps", {
      "apps/web/package.json": pkg({ dependencies: { contentful: "10" } }),
      "apps/web/components/X.tsx": `"use client";\nimport { createClient } from "contentful";`,
    });
    expect(f.find((x) => x.id === "heavy-deps/cms-sdk-client")).toMatchObject({ severity: "high", file: "apps/web/components/X.tsx" });
  });
  it("passes a lean package.json", () => {
    expect(run("heavy-deps", { "package.json": pkg({ dependencies: { next: "15", react: "19" } }) })).toHaveLength(0);
  });
});

describe("old-browserslist", () => {
  it("flags ie 11 as high", () => {
    const f = run("old-browserslist", { "package.json": pkg({ dependencies: { next: "15" }, browserslist: ["> 1%", "ie 11"] }) });
    expect(f[0]).toMatchObject({ id: "old-browserslist/legacy-target", severity: "high" });
  });
  it("does not flag a missing browserslist (Next defaults are modern)", () => {
    expect(run("old-browserslist", { "package.json": pkg({ dependencies: { next: "15" } }) })).toHaveLength(0);
  });
  it("flags core-js imports", () => {
    expect(run("old-browserslist", { "src/p.ts": `import "core-js/stable";` })[0].id).toBe("old-browserslist/core-js-import");
  });
  it("passes modern targets", () => {
    expect(run("old-browserslist", { "package.json": pkg({ dependencies: { next: "15" }, browserslist: ["chrome >= 100", "safari >= 15.4"] }) })).toHaveLength(0);
  });
});

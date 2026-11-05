import { describe, it, expect } from "vitest";
import { run } from "./helpers.js";

describe("fonts", () => {
  it("flags Google Fonts link", () => {
    const f = run("fonts", { "app/layout.tsx": `export default () => <head><link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet" /></head>;` });
    expect(f[0]).toMatchObject({ id: "fonts/google-link", severity: "high" });
  });
  it("flags css @import", () => {
    expect(run("fonts", { "styles/g.css": `@import url("https://fonts.googleapis.com/css?family=Roboto");` })).toHaveLength(1);
  });
  it("flags >4 weights and block display", () => {
    const c = `import { Inter } from "next/font/google";\nconst inter = Inter({ subsets: ["latin"], weight: ["100","200","300","400","500"], display: "block" });`;
    expect(run("fonts", { "app/f.ts": c }).map((x) => x.id).sort()).toEqual(["fonts/display", "fonts/too-many-files"]);
  });
  it("passes a lean next/font", () => {
    const c = `import { Inter } from "next/font/google";\nconst inter = Inter({ subsets: ["latin"], weight: ["400","700"], display: "swap" });`;
    expect(run("fonts", { "app/f.ts": c })).toHaveLength(0);
  });
});

describe("css-weight", () => {
  it("flags many global css imports in layout", () => {
    const c = ["a", "b", "c", "d"].map((n) => `import "./${n}.css";`).join("\n");
    expect(run("css-weight", { "app/layout.tsx": c })[0].id).toBe("css-weight/layout-css-imports");
  });
  it("flags tailwind config without content", () => {
    expect(run("css-weight", { "tailwind.config.js": `module.exports = { theme: {} };` })[0].id).toBe("css-weight/tailwind-content");
  });
  it("flags CSS-in-JS in root layout", () => {
    expect(run("css-weight", { "app/layout.tsx": `import styled from "styled-components";` })[0].id).toBe("css-weight/css-in-js-layout");
  });
  it("passes a tailwind config with content", () => {
    expect(run("css-weight", { "tailwind.config.js": `module.exports = { content: ["./app/**/*.tsx"] };` })).toHaveLength(0);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { extractDirectives } from "../../src/graph/directives.js";
import { fixturePath } from "../helpers.js";

describe("extractDirectives", () => {
  it("does not treat server-only in comments as a directive", () => {
    const source = readFileSync(fixturePath("directives/app/page.tsx"), "utf-8");
    const program = parseSync("page.tsx", source, { sourceType: "module" }).program;
    const directives = extractDirectives(program);
    expect(directives.has("server-only")).toBe(false);
  });

  it("detects server-only import", () => {
    const source = readFileSync(fixturePath("directives/app/server/page.tsx"), "utf-8");
    const program = parseSync("page.tsx", source, { sourceType: "module" }).program;
    const directives = extractDirectives(program);
    expect(directives.has("server-only")).toBe(true);
  });

  it("detects use client prologue after comments", () => {
    const source = `// header\n"use client";\nexport default function X() {}`;
    const program = parseSync("x.tsx", source, { sourceType: "module" }).program;
    const directives = extractDirectives(program);
    expect(directives.has("use client")).toBe(true);
  });
});

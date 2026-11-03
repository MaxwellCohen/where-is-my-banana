import { describe, it, expect } from "vitest";
import { matchesGlob, makeIgnoreMatcher } from "../../src/audit/glob.js";

describe("matchesGlob", () => {
  it.each([
    ["app/a.tsx", "app/*.tsx", true],
    ["app/x/a.tsx", "app/*.tsx", false],
    ["app/x/y/a.tsx", "app/**/*.tsx", true],
    ["app/a.tsx", "app/**/*.tsx", true],
    ["app/legacy", "app/legacy/**", true],
    ["app/legacy/a/b.ts", "app/legacy/**", true],
    ["a.ts", "*.{ts,tsx}", true],
    ["a.tsx", "*.{ts,tsx}", true],
    ["a.js", "*.{ts,tsx}", false],
    ["a1.ts", "a?.ts", true],
    ["ab.ts", "a[!b].ts", false],
    ["ac.ts", "a[!b].ts", true],
    ["app/[slug]/page.tsx", "app/\\[slug\\]/*", true],
  ])("%s ~ %s = %s", (p, g, want) => expect(matchesGlob(p, g)).toBe(want));
});

describe("makeIgnoreMatcher", () => {
  it("matches basenames at any depth and directory contents", () => {
    const m = makeIgnoreMatcher(["*.generated.ts", "legacy", "vendor/**"]);
    expect(m("a/b/x.generated.ts")).toBe(true);
    expect(m("src/legacy/a.tsx")).toBe(true);
    expect(m("vendor/lib/a.js")).toBe(true);
    expect(m("src/a.tsx")).toBe(false);
  });
  it("supports negation, last match wins", () => {
    const m = makeIgnoreMatcher(["src/old/**", "!src/old/keep.ts"]);
    expect(m("src/old/a.ts")).toBe(true);
    expect(m("src/old/keep.ts")).toBe(false);
  });
});

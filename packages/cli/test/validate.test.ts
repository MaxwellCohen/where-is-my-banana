import { describe, it, expect } from "vitest";
import { validateProject } from "../src/validate.js";
import { fixturePath } from "./helpers.js";

describe("validateProject", () => {
  it("accepts a Next.js fixture", () => {
    const result = validateProject(fixturePath("e2e-app"));
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects a non-Next project", () => {
    const result = validateProject(fixturePath("not-next"));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("next"))).toBe(true);
  });
});

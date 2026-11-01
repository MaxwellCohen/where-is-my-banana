import { afterEach, describe, expect, it, vi } from "vitest";
import { childEnv } from "../src/build/child-env.js";

describe("childEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("passes build vars and drops unrelated secrets", () => {
    vi.stubEnv("PATH", "/bin");
    vi.stubEnv("NEXT_PUBLIC_API", "x");
    vi.stubEnv("NPM_TOKEN", "secret");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("GITHUB_TOKEN", "secret");
    const env = childEnv({ TURBOPACK: "1" });
    expect(env.PATH).toBe("/bin");
    expect(env.NEXT_PUBLIC_API).toBe("x");
    expect(env.TURBOPACK).toBe("1");
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("inherits everything with WIMB_INHERIT_ENV=1", () => {
    vi.stubEnv("WIMB_INHERIT_ENV", "1");
    vi.stubEnv("DATABASE_URL", "db");
    expect(childEnv().DATABASE_URL).toBe("db");
  });
});

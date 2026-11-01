import { describe, it, expect, beforeAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const dist = join(pkgRoot, "dist", "index.js");
const fixture = join(pkgRoot, "test", "fixtures", "wins-app");

beforeAll(() => {
  if (!existsSync(dist)) {
    const r = spawnSync("pnpm", ["exec", "tsdown"], { cwd: pkgRoot, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`build failed: ${r.stdout}${r.stderr}`);
  }
}, 120_000);

describe("wimb wins --json", () => {
  it("flushes full JSON through a pipe before exit", async () => {
    const child = spawn(
      process.execPath,
      [dist, "wins", "--json", "--analyze-export", join(fixture, "graph.jsonl"), "--cwd", fixture, "--no-analyze"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.setEncoding("utf-8").on("data", (c: string) => (out += c));
    await new Promise<void>((res) => child.on("close", () => res()));
    const report = JSON.parse(out);
    expect(report.wins.length).toBeGreaterThan(0);
    expect(report.routes.map((r: { route: string }) => r.route).sort()).toEqual(["/", "/dashboard"]);
  });
});

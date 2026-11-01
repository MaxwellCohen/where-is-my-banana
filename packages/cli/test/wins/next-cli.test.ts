import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextHasAnalyze, runNext } from "../../src/wins/next-cli.js";

function projectWithNext(version?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wins-next-"));
  if (version) {
    mkdirSync(join(dir, "node_modules", "next"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "next", "package.json"), JSON.stringify({ version }));
  }
  return dir;
}

describe("nextHasAnalyze", () => {
  it.each(["16.3.0", "16.1.0", "15.6.0-canary.55"])("false for %s", (v) => {
    expect(nextHasAnalyze(projectWithNext(v))).toBe(false);
  });
  it.each(["16.4.0", "16.4.0-canary.2", "17.0.0"])("true for %s", (v) => {
    expect(nextHasAnalyze(projectWithNext(v))).toBe(true);
  });
  it("assumes new when next is not installed", () => {
    expect(nextHasAnalyze(projectWithNext())).toBe(true);
  });
});

describe("runNext failure messages", () => {
  function fakeNext(script: string): string {
    const dir = projectWithNext();
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    const bin = join(dir, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");
    writeFileSync(bin, process.platform === "win32" ? `@echo off\r\nnode -e "${script}"\r\n` : `#!/bin/sh\nexec node -e '${script}'\n`, { mode: 0o755 });
    return dir;
  }

  it.skipIf(process.platform === "win32")("reports signal kills", async () => {
    const dir = fakeNext("process.kill(process.pid,\"SIGTERM\")");
    await expect(runNext(dir, ["build"], { capture: true })).rejects.toThrow(/next build failed \(killed by SIGTERM\)/);
  });

  it("reports exit code and stderr", async () => {
    const dir = fakeNext("console.error(\"boom\");process.exit(3)");
    await expect(runNext(dir, ["build"], { capture: true })).rejects.toThrow(/failed \(exit 3\)\nboom/);
  });
});

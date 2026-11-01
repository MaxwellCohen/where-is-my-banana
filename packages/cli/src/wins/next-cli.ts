import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const NEXT_TIMEOUT_MS = 600_000;

export interface RunNextOptions {
  /** Capture stdout and return it; otherwise inherit stdio. */
  capture?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

const children = new Set<ChildProcess>();
let hooked = false;

function killChild(c: ChildProcess): void {
  if (process.platform === "win32" && c.pid) {
    spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
  } else c.kill("SIGTERM");
}

function hookCleanup(): void {
  if (hooked) return;
  hooked = true;
  const killAll = () => {
    for (const c of children) killChild(c);
  };
  process.on("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      killAll();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}

/** Run the project's `next` via `npx --no-install` (never downloads). Resolves with stdout when `capture` is set. */
export function runNext(projectRoot: string, args: string[], opts: RunNextOptions = {}): Promise<string> {
  hookCleanup();
  const label = `next ${args.slice(0, 2).join(" ")}`;
  const timeoutMs = opts.timeoutMs ?? NEXT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const localNext = join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");
    const [cmd, cmdArgs] = existsSync(localNext) ? [localNext, args] : ["npx", ["--no-install", "next", ...args]];
    const child = spawn(cmd as string, cmdArgs as string[], {
      shell: process.platform === "win32",
      cwd: projectRoot,
      stdio: ["ignore", opts.capture ? "pipe" : "inherit", opts.capture ? "pipe" : "inherit"],
      env: { ...process.env, ...opts.env },
    });
    children.add(child);
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, timeoutMs);
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (c: string) => (out += c));
    child.stderr?.on("data", (c: Buffer | string) => (err = (err + String(c)).slice(-4_000)));
    const done = () => {
      clearTimeout(timer);
      children.delete(child);
    };
    child.on("error", (e) => {
      done();
      reject(e);
    });
    child.on("close", (code, signal) => {
      done();
      if (timedOut) return reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      if (code === 0) return resolve(out);
      reject(new Error(`${label} failed (${signal ? `killed by ${signal}` : `exit ${code}`})${err.trim() ? `\n${err.trim()}` : ""}`));
    });
  });
}

/** `next analyze --output` / `analyze export` need Next 16.4+; fail early with a clear message otherwise. */
export function assertNextAnalyzeSupport(projectRoot: string): void {
  let version: string;
  try {
    version = JSON.parse(readFileSync(join(projectRoot, "node_modules", "next", "package.json"), "utf-8")).version;
  } catch {
    return;
  }
  const [major, minor] = version.split(/[.-]/).map(Number);
  if (major < 16 || (major === 16 && minor < 4)) {
    throw new Error(
      `wimb wins needs Next.js 16.4+ (found ${version}). Upgrade next, pass --analyze-export <file.jsonl>, or use 'wimb scan'.`,
    );
  }
}

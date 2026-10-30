import { spawn, type ChildProcess } from "node:child_process";

export const NEXT_TIMEOUT_MS = 600_000;

export interface RunNextOptions {
  /** Capture stdout and return it; otherwise inherit stdio. */
  capture?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

const children = new Set<ChildProcess>();
let hooked = false;

function hookCleanup(): void {
  if (hooked) return;
  hooked = true;
  const killAll = () => {
    for (const c of children) c.kill("SIGTERM");
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
    const child = spawn("npx", ["--no-install", "next", ...args], {
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
      child.kill("SIGTERM");
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
    child.on("close", (code) => {
      done();
      if (timedOut) return reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      if (code === 0) return resolve(out);
      reject(new Error(`${label} failed (exit ${code})${err.trim() ? `\n${err.trim()}` : ""}`));
    });
  });
}

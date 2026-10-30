#!/usr/bin/env node
/**
 * Build a self-contained @wimb/cli package for install-from-GitHub / npx.
 *
 * Usage:
 *   node scripts/pack-npx.mjs           # build .npm-pack + wimb-cli-*.tgz
 *   node scripts/pack-npx.mjs --push    # also force-push orphan branch `npx`
 *   WIMB_NPX_REMOTE=<url> node scripts/pack-npx.mjs --push --force-remote
 *                                       # required to push to a non-default remote
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, ".npm-pack");
const cliDir = join(root, "packages", "cli");
const shouldPush = process.argv.includes("--push");

execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

cpSync(join(cliDir, "dist"), join(outDir, "dist"), { recursive: true });
cpSync(join(cliDir, "src", "data"), join(outDir, "src", "data"), {
  recursive: true,
});

const pkg = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
const { devDependencies: _dev, scripts: _scripts, ...publishable } = pkg;
delete publishable.dependencies["@wimb/graph-v1"];

writeFileSync(
  join(outDir, "package.json"),
  `${JSON.stringify(publishable, null, 2)}\n`,
);
writeFileSync(
  join(outDir, "README.md"),
  `# @wimb/cli (npx branch)

Installable snapshot of Where Is My Banana. Do not develop here — source lives on \`main\`.

\`\`\`bash
npx --yes github:MaxwellCohen/where-is-my-banana#npx scan --cwd .
\`\`\`
`,
);

const tarball = execFileSync("npm", ["pack", "--pack-destination", root], {
  cwd: outDir,
  encoding: "utf8",
}).trim();

console.log(`\nWrote ${join(root, tarball)}`);
console.log("\nFrom GitHub (after `pnpm pack:npx -- --push`):");
console.log(
  "  npx --yes github:MaxwellCohen/where-is-my-banana#npx scan --cwd <project>",
);
console.log("\nOr a release asset:");
console.log(
  `  npx --yes --package=https://github.com/MaxwellCohen/where-is-my-banana/releases/download/<tag>/${tarball} wimb scan --cwd <project>`,
);

if (!shouldPush) {
  console.log("\nSkip push (pass --push to update origin/npx).");
  process.exit(0);
}

const DEFAULT_REMOTE = "https://github.com/MaxwellCohen/where-is-my-banana.git";
const remote = process.env.WIMB_NPX_REMOTE ?? DEFAULT_REMOTE;
if (remote !== DEFAULT_REMOTE && !process.argv.includes("--force-remote")) {
  console.error(`Refusing to force-push to non-default remote ${remote}. Pass --force-remote to confirm.`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "wimb-npx-"));
try {
  cpSync(outDir, work, { recursive: true });
  const git = (args) =>
    execFileSync("git", args, { cwd: work, encoding: "utf8" });

  git(["init"]);
  git(["checkout", "-b", "npx"]);
  git(["add", "-A"]);
  git([
    "commit",
    "-m",
    `chore: publish @wimb/cli ${publishable.version} for npx`,
  ]);
  execFileSync("git", ["push", "--force", remote, "npx:npx"], {
    cwd: work,
    stdio: "inherit",
  });

  console.log("\nPushed orphan branch npx → origin/npx");
} finally {
  rmSync(work, { recursive: true, force: true });
}

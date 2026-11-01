const ALLOWED = [
  /^(PATH|HOME|USER|USERPROFILE|SHELL|TERM|TMPDIR|TEMP|TMP|LANG|CI|NODE_ENV|FORCE_COLOR|NO_COLOR)$/i,
  /^LC_/,
  /^(NODE|NEXT|TURBO|TURBOPACK|VITE|PNPM|YARN|BUN)_/i,
  /^npm_(config|execpath|node_execpath|lifecycle)/,
  /^(SystemRoot|APPDATA|LOCALAPPDATA|PATHEXT|COMSPEC|ProgramFiles)/i,
];

const SECRET = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH)/i;
const PUBLIC = /^(NEXT_PUBLIC|VITE)_/;

/**
 * Environment for spawned build tools. Passes through only what a build needs
 * (PATH, framework config, NEXT_PUBLIC_*), not unrelated secrets such as cloud
 * or registry tokens. Set WIMB_INHERIT_ENV=1 to pass the full environment.
 */
export function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const source = process.env;
  if (source.WIMB_INHERIT_ENV === "1") return { ...source, ...extra };
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ALLOWED.some((re) => re.test(key)) && (PUBLIC.test(key) || !SECRET.test(key))) out[key] = value;
  }
  return { ...out, ...extra };
}

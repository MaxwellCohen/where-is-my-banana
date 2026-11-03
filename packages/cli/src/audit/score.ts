import type { Effort, Finding, Severity } from "./types.js";
import { isLayoutLike } from "./util.js";

const BASE: Record<Severity, number> = { high: 75, medium: 45, low: 15 };
export const EFFORT_WEIGHT: Record<Effort, number> = { S: 1, M: 2, L: 4 };

/** Checks whose effect is sitewide or hits LCP directly. */
const BOOST: Record<string, number> = {
  "third-party-script": 10,
  "middleware-scope": 10,
  "image-config": 5,
  "lcp-priority": 10,
  "missing-static-params": 5,
};
const DAMPEN: Record<string, number> = {
  "use-client-inventory": -10,
  "old-browserslist/missing": -5,
  "heavy-deps/cms-sdk": -5,
};

export function impactOf(f: Pick<Finding, "id" | "check" | "severity" | "file">): number {
  let n = BASE[f.severity] + (BOOST[f.check] ?? 0) + (DAMPEN[f.id] ?? DAMPEN[f.check] ?? 0);
  if (isLayoutLike(f.file)) n += 10;
  return Math.max(0, Math.min(100, n));
}

const L_DEPS = /^heavy-deps\/(?:moment(?:-timezone)?|jquery|lodash|styled-components|@emotion\/.+|@fortawesome\/.+|@mui\/icons-material|draft-js|react-draft-wysiwyg|rxjs)$/;

export function effortOf(f: Pick<Finding, "id" | "check">): Effort {
  if (L_DEPS.test(f.id) || f.id === "css-weight/css-in-js-layout" || f.id === "heavy-deps/duplicate-date" || f.id === "heavy-deps/duplicate-icons") return "L";
  switch (f.check) {
    case "third-party-script":
    case "raw-img":
    case "lcp-priority":
    case "image-config":
    case "cms-image-params":
    case "ssr-false-misuse":
    case "middleware-scope":
      return "S";
    case "fonts":
      return f.id === "fonts/google-link" ? "M" : "S";
    case "maps-widgets":
      return f.id === "maps-widgets/iframe" ? "S" : "M";
    case "css-weight":
      return f.id === "css-weight/tailwind-content" ? "S" : "M";
    case "heavy-deps":
      return /axios|core-js|regenerator|node-fetch|cross-fetch/.test(f.id) ? "S" : "M";
    case "use-client-inventory":
      return "L";
    default:
      return "M";
  }
}

export function withScore(f: Finding): Finding {
  return { ...f, impactScore: impactOf(f), effort: effortOf(f) };
}

/** Higher = do sooner: impact per unit of effort. */
export function priority(f: Finding): number {
  return (f.impactScore ?? 0) / EFFORT_WEIGHT[f.effort ?? "M"];
}

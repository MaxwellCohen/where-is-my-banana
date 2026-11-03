import { planAssets, imageChecks, type AssetPlan } from "./checks-assets.js";
import { findGtmIds } from "./gtm.js";
import { parseHtml } from "./html.js";
import type { PageInput } from "./types.js";

/** Pure: which asset URLs worth a HEAD for this page, and which GTM containers to fetch. */
export function planAssetsFor(page: PageInput): { assets: AssetPlan[]; gtmIds: string[] } {
  const p = parseHtml(page.html);
  const imgs = imageChecks(page, p, {}).urlsForHead;
  return { assets: planAssets(page, p, imgs), gtmIds: findGtmIds(page.html) };
}

export type Severity = "high" | "medium" | "low";
export type Owner = "code" | "gtm" | "cdn" | "cms";

export interface Finding {
  id: string;
  check: string;
  severity: Severity;
  url: string;
  message: string;
  fix: string;
  owner: Owner;
  evidence?: Record<string, unknown>;
}

export interface Hop {
  url: string;
  status: number;
  location?: string;
  ms: number;
}

/** Everything the pure checks need about one fetched page. */
export interface PageInput {
  url: string;
  finalUrl?: string;
  status?: number;
  html: string;
  /** lower-case header names */
  headers: Record<string, string>;
  ttfbMs: number;
  totalMs?: number;
  redirects?: Hop[];
}

export interface AssetInfo {
  url: string;
  status?: number;
  /** content-length (or content-range total) as reported */
  bytes?: number;
  encoding?: string;
  contentType?: string;
  /** estimated bytes over the wire */
  transferEst?: number;
}
export type AssetMap = Record<string, AssetInfo>;

export interface ScriptInfo {
  url: string;
  host: string;
  thirdParty: boolean;
  vendor?: string;
  mode: "async" | "defer" | "module" | "blocking";
  inHead: boolean;
  bytes?: number;
  transferEst?: number;
}

export interface Detection {
  framework: string[];
  hosting: string[];
  cms: string[];
  buildId?: string;
}

export interface PageMetrics {
  ttfbMs: number;
  totalMs: number;
  htmlRaw: number;
  htmlGzip: number;
  jsCount: number;
  jsTransfer: number;
  thirdPartyCount: number;
  thirdPartyTransfer: number;
  cssBlocking: number;
  imagesTotal: number;
  imagesFlagged: number;
  domNodes: number;
  domDepth: number;
  hydrationMarkers: number;
  redirectHops: number;
  cacheStatus: string;
}

export interface VendorStat {
  vendor: string;
  count: number;
  bytes: number;
}

export interface PageResult {
  url: string;
  finalUrl: string;
  status: number;
  detection: Detection;
  metrics: PageMetrics;
  scripts: ScriptInfo[];
  stylesheets: { url: string; bytes?: number }[];
  vendors: VendorStat[];
  lcp?: { src: string; preloaded: boolean; lazy: boolean; priority: boolean };
  gtm: GtmSummary[];
  findings: Finding[];
}

export interface GtmSummary {
  id: string;
  bytes: number;
  vendors: string[];
  tagTypes: Record<string, number>;
}

export interface LiveOptions {
  urls: string[];
  urlsFile?: string;
  sitemap?: string;
  sample: number;
  concurrency: number;
  timeoutMs: number;
  userAgent: string;
  mobile: boolean;
  maxRequests: number;
  out: string;
  json: boolean;
  failOn?: "high" | "medium";
  lighthouse: boolean;
  lighthouseJson: string[];
}

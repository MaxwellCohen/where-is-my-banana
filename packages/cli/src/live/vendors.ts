export interface VendorDef {
  name: string;
  test: RegExp;
}

/** Matched against the full lower-cased URL. First match wins. */
export const VENDORS: VendorDef[] = [
  { name: "Google Tag Manager", test: /googletagmanager\.com\/(gtm|ns)/ },
  { name: "Google Analytics", test: /google-analytics\.com|analytics\.google\.com|googletagmanager\.com\/gtag/ },
  { name: "Google Ads", test: /googleadservices\.com|googlesyndication\.com|doubleclick\.net|google\.com\/pagead/ },
  { name: "Google Maps", test: /maps\.googleapis\.com|maps\.gstatic\.com/ },
  { name: "reCAPTCHA", test: /google\.com\/recaptcha|gstatic\.com\/recaptcha/ },
  { name: "Google Fonts", test: /fonts\.googleapis\.com|fonts\.gstatic\.com/ },
  { name: "YouTube", test: /youtube(-nocookie)?\.com|ytimg\.com/ },
  { name: "Meta Pixel", test: /connect\.facebook\.net|facebook\.com\/tr/ },
  { name: "TikTok", test: /tiktok\.com|tiktokcdn/ },
  { name: "Hotjar", test: /hotjar\.(com|io)/ },
  { name: "FullStory", test: /fullstory\.com/ },
  { name: "OneTrust", test: /onetrust\.com|cookielaw\.org/ },
  { name: "Cookiebot", test: /cookiebot\.com/ },
  { name: "Optimizely", test: /optimizely\.com|optimizelyedge/ },
  { name: "Intercom", test: /intercom(cdn)?\.(io|com)/ },
  { name: "Calendly", test: /calendly\.com/ },
  { name: "Yext", test: /yext(pages|cdn)?\.(com|net)|yextcdn/ },
  { name: "Birdeye", test: /birdeye\.com/ },
  { name: "Podium", test: /podium(webchat)?\.com|podium\.com/ },
  { name: "CallRail", test: /callrail\.com|calltrk\.com/ },
  { name: "Invoca", test: /invoca(-?cdn)?\.(net|com)/ },
  { name: "LinkedIn", test: /licdn\.com|linkedin\.com\/px|snap\.licdn/ },
  { name: "Microsoft Clarity", test: /clarity\.ms/ },
  { name: "Bing Ads", test: /bat\.bing\.com/ },
  { name: "X/Twitter Ads", test: /ads-twitter\.com|platform\.twitter\.com/ },
  { name: "Pinterest", test: /pinimg\.com\/ct|pinterest\.com\/ct/ },
  { name: "Segment", test: /segment\.(com|io)/ },
  { name: "HubSpot", test: /hs-scripts|hsforms|hubspot\.com|hs-analytics|hsadspixel/ },
  { name: "Drift", test: /drift\.com|driftt\.com/ },
  { name: "Zendesk", test: /zendesk\.com|zdassets\.com/ },
  { name: "LiveChat", test: /livechatinc\.com|livechat\.com/ },
  { name: "Trustpilot", test: /trustpilot\.com/ },
  { name: "Sentry", test: /sentry-cdn|browser\.sentry|sentry\.io/ },
  { name: "Datadog", test: /datadoghq/ },
  { name: "New Relic", test: /nr-data\.net|newrelic\.com/ },
  { name: "Stripe", test: /stripe\.com/ },
  { name: "Vimeo", test: /vimeo\.com|vimeocdn/ },
];

export function vendorFor(url: string): string | undefined {
  const u = url.toLowerCase();
  return VENDORS.find((v) => v.test.test(u))?.name;
}

/** Signatures scanned in a GTM container body. */
export const GTM_SIGNATURES: VendorDef[] = [
  { name: "Meta Pixel", test: /fbq\(|connect\.facebook\.net|facebook\.com\/tr/ },
  { name: "Hotjar", test: /hotjar/ },
  { name: "LinkedIn", test: /linkedin\.com|licdn\.com|snap\.licdn/ },
  { name: "Google Ads", test: /ads\/ga-audiences|googleadservices|doubleclick|conversion\.js|__awct/ },
  { name: "Google Analytics", test: /google-analytics\.com|__ua\b|__gaawc|"__gaawe"/ },
  { name: "Microsoft Clarity", test: /clarity\.ms|clarity\(/ },
  { name: "TikTok", test: /tiktok|ttq\./ },
  { name: "Bing Ads", test: /bat\.bing\.com|uetq/ },
  { name: "Optimizely", test: /optimizely/ },
  { name: "FullStory", test: /fullstory/ },
  { name: "Pinterest", test: /pintrk|pinimg\.com\/ct/ },
  { name: "X/Twitter Ads", test: /ads-twitter|twq\(/ },
  { name: "HubSpot", test: /hs-scripts|hubspot|hs-analytics/ },
  { name: "CallRail", test: /callrail|calltrk/ },
  { name: "Invoca", test: /invoca/ },
  { name: "Yext", test: /yext/ },
  { name: "Birdeye", test: /birdeye/ },
  { name: "Podium", test: /podium/ },
  { name: "Calendly", test: /calendly/ },
  { name: "Intercom", test: /intercom/ },
  { name: "OneTrust", test: /onetrust|cookielaw/ },
  { name: "Cookiebot", test: /cookiebot/ },
  { name: "Segment", test: /segment\.(com|io)|analytics\.js\/v1/ },
];

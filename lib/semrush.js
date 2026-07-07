/**
 * Semrush utility module.
 *
 * Post-migration this file holds only the pure helpers that are still
 * needed by callers — brand detection, URL split/join. All Semrush API
 * calls now go through lib/semrush-rich.js (Apikey auth, /apis/v4/local/v1).
 *
 * The deprecated OAuth Device Authorization flow (Bearer-token-based
 * /apis/v4-raw/listing-management/v1) has been retired. Its removal
 * eliminates the 7-day token expiry / refresh-token rotation problems
 * that had been the main operational pain of this app.
 */

// ---------------------------------------------------------------------------
// URL split/join — website URL and query params are stored separately so
// URL-params bulk edits can preserve each location's base URL. Kept here
// as a re-export for callers that still import from lib/semrush; the same
// helpers exist inside lib/semrush-rich for the rich transform.
// ---------------------------------------------------------------------------

export function splitUrl(fullUrl) {
  if (!fullUrl) return { baseUrl: "", urlParams: "" };
  const qIndex = fullUrl.indexOf("?");
  if (qIndex === -1) return { baseUrl: fullUrl, urlParams: "" };
  return {
    baseUrl: fullUrl.substring(0, qIndex),
    urlParams: fullUrl.substring(qIndex + 1),
  };
}

export function joinUrl(baseUrl, urlParams) {
  if (!baseUrl) return "";
  if (!urlParams || urlParams.trim() === "") return baseUrl;
  const params = urlParams.replace(/^\?/, "").trim();
  if (!params) return baseUrl;
  return `${baseUrl}?${params}`;
}

// ---------------------------------------------------------------------------
// Brand detection
// ---------------------------------------------------------------------------

/**
 * Auto-assign brand based on location name or website URL.
 * Add new patterns here as brands are added to the Semrush account.
 * Order matters — more specific patterns must come first (e.g. Canadian
 * variants before US ones, since US patterns are substrings of Canadian).
 */
const BRAND_PATTERNS = [
  { id: "carstar-ca", patterns: ["carstar canada", "carstar.ca"] },
  { id: "carstar-us", patterns: ["carstar"] },
  { id: "take5-ca", patterns: ["take 5 canada", "take5canada", "take5oilchange.ca"] },
  { id: "take5", patterns: ["take 5", "take5", "take-5"] },
  { id: "autoglass", patterns: ["auto glass now", "autoglassnow", "auto glass"] },
  { id: "abra", patterns: ["abra auto", "abra body", "abraauto", "abra "] },
  { id: "fixauto", patterns: ["fix auto", "fixauto"] },
  { id: "maaco-ca", patterns: ["maaco ca", "maaco canada", "maaco.ca"] },
  { id: "maaco-us", patterns: ["maaco"] },
  { id: "meineke", patterns: ["meineke"] },
  { id: "econo", patterns: ["econo lube", "econolube"] },
  { id: "1800radiator", patterns: ["1-800-radiator", "1800radiator", "800 radiator", "1800-radiator"] },
  { id: "uniban", patterns: ["docteur du pare", "uniban", "pare-brise"] },
  { id: "starlube", patterns: ["star lube", "starlube"] },
];

/**
 * Detect a brand from a location record. Accepts either the app shape
 * ({ name, website }) or the rich API's snake_case shape ({ business_name,
 * website_url }) — matches on any of them so callers don't have to translate.
 */
export function detectBrand(location) {
  const name = (
    location.locationName ||
    location.business_name ||
    location.name ||
    ""
  ).toLowerCase();
  const website = (
    location.websiteUrl ||
    location.website_url ||
    location.website ||
    ""
  ).toLowerCase();
  const searchText = `${name} ${website}`;

  for (const brand of BRAND_PATTERNS) {
    for (const pattern of brand.patterns) {
      if (searchText.includes(pattern)) return brand.id;
    }
  }

  // Fallback: derive a brand slug from a hyphenated location name.
  const dashSplit = name.split(/\s*[-–—]\s*/);
  if (dashSplit.length >= 2) {
    return dashSplit[0].trim().replace(/\s+/g, "").toLowerCase() || "unknown";
  }

  return "unknown";
}

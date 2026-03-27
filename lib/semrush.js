/**
 * Semrush Listing Management API Client
 * Updated: March 2026 — matches developer.semrush.com/api/local/listing-management/
 *
 * API response format (new):
 *   Success: { meta: { success: true, status_code: 200, request_id }, data: ... }
 *   Error:   { meta: { success: false, status_code: 400, request_id }, error: { code, message, details } }
 *
 * Note: Some Listing Management error responses still use the legacy format
 *   { error: { code, message, details }, requestId } — we handle both.
 *
 * OAuth: Device Authorization Grant flow via OAuth 2.0
 *   https://developer.semrush.com/api/get-started/authorization/#oauth-20
 */

const SEMRUSH_API_BASE =
  process.env.SEMRUSH_API_BASE ||
  "https://api.semrush.com/apis/v4-raw/listing-management/v1";

const SEMRUSH_OAUTH_BASE = "https://oauth.semrush.com";

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

/**
 * In production, store tokens in a database or encrypted KV store (Vercel KV,
 * Upstash Redis). In-memory won't survive serverless cold starts.
 */
let tokenCache = {
  accessToken: process.env.SEMRUSH_BEARER_TOKEN || null,
  refreshToken: process.env.SEMRUSH_REFRESH_TOKEN || null,
  expiresAt: null,
};

export function getTokenStatus() {
  return {
    hasToken: !!tokenCache.accessToken,
    expiresAt: tokenCache.expiresAt,
    isExpired: tokenCache.expiresAt
      ? new Date(tokenCache.expiresAt) < new Date()
      : false,
  };
}

export function setTokens({ accessToken, refreshToken, expiresIn }) {
  tokenCache.accessToken = accessToken;
  tokenCache.refreshToken = refreshToken || tokenCache.refreshToken;
  tokenCache.expiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;
}

// ---------------------------------------------------------------------------
// OAuth Device Authorization Flow
// ---------------------------------------------------------------------------

export async function initiateDeviceAuth() {
  const res = await fetch(`${SEMRUSH_OAUTH_BASE}/dag/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      scope: process.env.SEMRUSH_OAUTH_SCOPE || "user.id",
    }),
  });
  if (!res.ok) throw new Error(`Device auth failed: ${res.status}`);
  return res.json();
}

export async function pollForToken(deviceCode) {
  const res = await fetch(`${SEMRUSH_OAUTH_BASE}/dag/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
    }),
  });
  const data = await res.json();
  if (data.access_token) {
    setTokens({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    });
    return { success: true };
  }
  return { success: false, error: data.error };
}

export async function refreshAccessToken() {
  if (!tokenCache.refreshToken) throw new Error("No refresh token available");
  const res = await fetch(`${SEMRUSH_OAUTH_BASE}/dag/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokenCache.refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = await res.json();
  setTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  });
  return data;
}

// ---------------------------------------------------------------------------
// Core request helper
// ---------------------------------------------------------------------------

async function semrushFetch(path, options = {}) {
  // Auto-refresh if expired
  const status = getTokenStatus();
  if (status.isExpired && tokenCache.refreshToken) {
    await refreshAccessToken();
  }

  if (!tokenCache.accessToken) {
    throw new Error(
      "No Semrush API token configured. Set SEMRUSH_BEARER_TOKEN in .env.local"
    );
  }

  const url = `${SEMRUSH_API_BASE}${path}`;

  const makeRequest = async (token) => {
    return fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  };

  let res = await makeRequest(tokenCache.accessToken);

  // 401 — try refresh once
  if (res.status === 401 && tokenCache.refreshToken) {
    try {
      await refreshAccessToken();
      res = await makeRequest(tokenCache.accessToken);
    } catch {
      throw new Error(
        "Semrush token expired and refresh failed. Re-authenticate via OAuth."
      );
    }
  }

  if (res.status === 401) {
    throw new Error(
      "Semrush token is invalid or expired. Update SEMRUSH_BEARER_TOKEN."
    );
  }

  if (res.status === 429) {
    // Retry once after a 2-second backoff
    await new Promise((resolve) => setTimeout(resolve, 2000));
    res = await makeRequest(tokenCache.accessToken);
    if (res.status === 429) {
      // Second retry after 5 seconds
      await new Promise((resolve) => setTimeout(resolve, 5000));
      res = await makeRequest(tokenCache.accessToken);
      if (res.status === 429) {
        throw new Error("Semrush rate limit exceeded after retries. Wait a minute and try again.");
      }
    }
  }

  const body = await res.json();

  // Handle new meta/error format
  if (body.meta && !body.meta.success) {
    const err = body.error || {};
    const detail =
      err.details?.map((d) => d.message).join("; ") || "";
    throw new Error(
      `Semrush API error ${body.meta.status_code}: ${err.message || "Unknown"}${
        detail ? ` — ${detail}` : ""
      }`
    );
  }

  // Handle legacy Listing Management error format
  // { error: { code, message, details }, requestId }
  if (body.error && !body.data) {
    const err = body.error;
    const detail =
      err.details?.map((d) => d.message).join("; ") || "";
    throw new Error(
      `Semrush API error: ${err.message || err.code || "Unknown"}${
        detail ? ` — ${detail}` : ""
      }`
    );
  }

  // For non-2xx that slipped through
  if (!res.ok && !body.data) {
    throw new Error(`Semrush API error ${res.status}: ${body.message || "Unknown"}`);
  }

  return body;
}

// ---------------------------------------------------------------------------
// Listing Management API methods
// ---------------------------------------------------------------------------

/**
 * GET single location by ID
 * Endpoint: GET /external/locations/:locationId
 * Rate limit: 10 req/sec
 * Response: { data: { id, locationName, phone, status, countryCode, errors[], ... }, requested }
 */
export async function getLocation(locationId) {
  const body = await semrushFetch(`/external/locations/${locationId}`);
  return body.data;
}

/**
 * GET paginated locations list
 * Endpoint: GET /external/locations?page=1&size=20
 * Rate limit: 10 req/sec
 * Response: { data: { page, totalElements, totalPages, content: [...] }, requestId }
 */
export async function getLocations({ page = 1, size = 20 } = {}) {
  const body = await semrushFetch(
    `/external/locations?page=${page}&size=${size}`
  );
  return body.data; // { page, totalElements, totalPages, content: [...] }
}

/**
 * GET all locations across all pages
 * Includes a 150ms delay between pages to stay well under the 10 req/sec limit.
 */
export async function getAllLocations() {
  const allLocations = [];
  let page = 1;
  const size = 100;

  while (true) {
    const result = await getLocations({ page, size });
    const content = result.content || [];
    allLocations.push(...content);

    if (page >= (result.totalPages || 1)) break;
    if (content.length < size) break;

    page++;
    if (page > 200) break; // safety

    // Throttle: 150ms between requests (~6.5 req/sec, under the 10/sec limit)
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return allLocations;
}

/**
 * PUT update single location
 * Endpoint: PUT /external/locations/:locationId
 * Rate limit: 5 req/sec
 * Required fields: locationName, city, address, phone
 * Response: { data: { id, locationName, status, countryCode, errors[], ... }, requested }
 */
export async function updateLocation(locationId, data) {
  const body = await semrushFetch(`/external/locations/${locationId}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
  return body.data;
}

/**
 * PUT bulk update up to 50 locations
 * Endpoint: PUT /external/locations
 * Rate limit: 5 req/MINUTE — one request at a time (NOT per second)
 * Payload: { locations: [{ id, locationName, city, address, phone, ... }] }
 * Response: { data: [{ locationId, state: "UPDATED"|"FAILED", error? }], requestId }
 *
 * IMPORTANT:
 * - HTTP 200 even if some locations fail — check per-location state field
 * - Each location ID must be unique in the request
 * - Max 50 locations per request
 */
export async function bulkUpdateLocations(locations) {
  if (locations.length > 50) {
    throw new Error("Bulk update supports max 50 locations per request");
  }

  // Validate unique IDs
  const ids = locations.map((l) => l.id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    throw new Error("Each location ID must be unique in a bulk update request");
  }

  const body = await semrushFetch(`/external/locations`, {
    method: "PUT",
    body: JSON.stringify({ locations }),
  });

  // Response: { data: [{ locationId, state: "UPDATED"|"FAILED", error? }] }
  return body.data;
}

// ---------------------------------------------------------------------------
// Data transformation helpers
// ---------------------------------------------------------------------------

/**
 * Transform a Semrush location object into our app's format.
 * Matches the actual response shape from GetLocation / GetLocations content[].
 *
 * Semrush fields:
 *   id, locationName, phone, region, status ("COMPLETE"), websiteUrl, zip,
 *   additionalAddressInfo, address, city, countryCode, businessHours,
 *   holidayHours, reopenDate, errors[]
 */
export function transformLocation(semrushLoc) {
  return {
    id: semrushLoc.id,
    semrushId: semrushLoc.id,
    name: semrushLoc.locationName || "",
    address: semrushLoc.address || "",
    additionalAddressInfo: semrushLoc.additionalAddressInfo || "",
    city: semrushLoc.city || "",
    state: semrushLoc.region || "",
    zip: semrushLoc.zip || "",
    countryCode: semrushLoc.countryCode || "US",
    phone: semrushLoc.phone || "",
    website: semrushLoc.websiteUrl || "",
    semrushStatus: semrushLoc.status || null, // "COMPLETE" etc.
    status: semrushLoc.reopenDate ? "temp_closed" : "active",
    reopenDate: semrushLoc.reopenDate || null,
    businessHours: semrushLoc.businessHours || null,
    holidayHours: semrushLoc.holidayHours || null,
    semrushErrors: semrushLoc.errors || [],
    // App-level fields:
    brand: null,
    hoursStatus: detectHoursStatus(semrushLoc),
    lastUpdated: null,
    updatedBy: null,
  };
}

function detectHoursStatus(loc) {
  if (loc.reopenDate) return "closed";
  if (loc.holidayHours && loc.holidayHours.length > 0) return "holiday";
  return "standard";
}

/**
 * Transform our app's form data back to Semrush API format.
 *
 * Required by UpdateLocation: locationName, city, address, phone
 *
 * Business hours format:
 *   { monday: [{ from: "HH:mm", to: "HH:mm" }], ... }
 *   Max 2 time ranges per day, no overlapping
 *
 * Holiday hours format:
 *   [{ type: "REGULAR"|"CLOSED"|"OPENED_ALL_DAY"|"RANGE", day: "yyyy-mm-dd", times?: [...] }]
 *   - RANGE requires times[], max 3 time ranges
 *   - CLOSED/REGULAR/OPENED_ALL_DAY must NOT have times
 *   - Each day must be unique
 *   - Holiday hours can only be set if businessHours is specified
 *
 * Reopen date: "yyyy-mm-dd", after today, before 2038-01-01
 */
export function toSemrushFormat(appData) {
  const payload = {};

  // Required fields
  if (appData.name) payload.locationName = appData.name;
  if (appData.city) payload.city = appData.city;
  if (appData.address) payload.address = appData.address;
  if (appData.phone) payload.phone = appData.phone;

  // Optional fields
  if (appData.additionalAddressInfo !== undefined)
    payload.additionalAddressInfo = appData.additionalAddressInfo;
  if (appData.state) payload.region = appData.state;
  if (appData.zip) payload.zip = appData.zip;
  if (appData.website) payload.websiteUrl = appData.website;

  // Business hours
  if (appData.businessHours) {
    payload.businessHours = {};
    for (const [day, val] of Object.entries(appData.businessHours)) {
      if (val.closed) {
        payload.businessHours[day] = [];
      } else {
        payload.businessHours[day] = [{ from: val.open, to: val.close }];
      }
    }
  }

  // Holiday hours — pass through as-is (already in Semrush format)
  if (appData.holidayHours) {
    payload.holidayHours = appData.holidayHours;
  }

  // Reopen date
  if (appData.reopenDate) {
    payload.reopenDate = appData.reopenDate;
  }

  return payload;
}

/**
 * Build a single item for the UpdateLocations bulk payload.
 * Returns: { id, locationName, city, address, phone, ...optional }
 */
export function toBulkSemrushFormat(locationId, appData) {
  const payload = toSemrushFormat(appData);
  payload.id = locationId;
  return payload;
}

/**
 * Auto-assign brand based on location name or website URL.
 * Add new patterns here as you add brands to your Semrush account.
 * Order matters — more specific patterns should come first.
 */
const BRAND_PATTERNS = [
  { id: "carstar", patterns: ["carstar"] },
  { id: "take5", patterns: ["take 5", "take5", "take-5"] },
  { id: "autoglass", patterns: ["auto glass now", "autoglassnow", "auto glass"] },
  { id: "abra", patterns: ["abra auto", "abra body", "abraauto"] },
  { id: "fixauto", patterns: ["fix auto", "fixauto"] },
  { id: "maaco", patterns: ["maaco"] },
  { id: "meineke", patterns: ["meineke"] },
  { id: "econo", patterns: ["econo lube", "econolube"] },
  { id: "1800radiator", patterns: ["1-800-radiator", "1800radiator", "800 radiator"] },
  { id: "starlube", patterns: ["star lube", "starlube"] },
];

export function detectBrand(location) {
  const name = (location.locationName || location.name || "").toLowerCase();
  const website = (location.websiteUrl || location.website || "").toLowerCase();
  const searchText = `${name} ${website}`;

  for (const brand of BRAND_PATTERNS) {
    for (const pattern of brand.patterns) {
      if (searchText.includes(pattern)) return brand.id;
    }
  }

  // If no pattern matches, try to extract a brand from the location name
  // e.g. "SomeBrand - City Name" → "somebrand"
  const dashSplit = name.split(/\s*[-–—]\s*/);
  if (dashSplit.length >= 2) {
    return dashSplit[0].trim().replace(/\s+/g, "").toLowerCase() || "unknown";
  }

  return "unknown";
}

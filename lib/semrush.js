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

import { loadOauthTokens, saveOauthTokens } from "@/lib/db";

const SEMRUSH_API_BASE =
  process.env.SEMRUSH_API_BASE ||
  "https://api.semrush.com/apis/v4-raw/listing-management/v1";

const SEMRUSH_OAUTH_BASE = "https://oauth.semrush.com";

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

/**
 * Token cache lives in two layers:
 *
 *   1. Module-scope `tokenCache` (this object) — fast, in-memory, per worker.
 *      Bootstrapped from env vars so cold instances have *something* before
 *      they reach the DB.
 *
 *   2. Postgres `lm_oauth_tokens` table — durable across cold starts and
 *      shared across serverless instances. Loaded lazily on the first API
 *      call per worker via `ensureTokensLoaded()`; written on every
 *      successful refresh via `setTokens()` so other workers can pick up
 *      the rotated refresh_token.
 *
 * The env vars are intentionally a one-time bootstrap — once the DB has a
 * row, it takes precedence and the env values are ignored. This is what
 * allows refresh-token rotation to work: the original env refresh_token is
 * single-use, and after the first refresh the new one only exists in the DB.
 */
let tokenCache = {
  accessToken: process.env.SEMRUSH_BEARER_TOKEN || null,
  refreshToken: process.env.SEMRUSH_REFRESH_TOKEN || null,
  expiresAt: null,
};

// Coalesces concurrent first-call loads inside a single worker so we hit the
// DB once on cold start, not once per parallel request.
let _tokensLoadedFromDb = false;
let _tokenLoadPromise = null;

async function ensureTokensLoaded() {
  if (_tokensLoadedFromDb) return;
  if (!_tokenLoadPromise) {
    _tokenLoadPromise = (async () => {
      try {
        const stored = await loadOauthTokens();
        if (stored && stored.accessToken) {
          // DB row wins over env once present — env is just bootstrap.
          tokenCache.accessToken = stored.accessToken;
          tokenCache.refreshToken = stored.refreshToken || tokenCache.refreshToken;
          tokenCache.expiresAt = stored.expiresAt;
        } else if (tokenCache.accessToken) {
          // DB empty but env has bootstrap values — seed the DB so future
          // cold workers (and refresh rotations) have somewhere to write.
          await saveOauthTokens({
            accessToken: tokenCache.accessToken,
            refreshToken: tokenCache.refreshToken,
            expiresAt: tokenCache.expiresAt,
          });
        }
      } catch (e) {
        console.error("Token DB init failed:", e.message);
      } finally {
        _tokensLoadedFromDb = true;
      }
    })();
  }
  await _tokenLoadPromise;
}

// Force a re-read on next ensureTokensLoaded — called when our cache might
// be stale (e.g., our refresh failed because another worker beat us to it
// and consumed the refresh_token we were holding).
function invalidateLoadedFlag() {
  _tokensLoadedFromDb = false;
  _tokenLoadPromise = null;
}

// Health telemetry — used by the status badge so it can show whether the
// API is actually responding, not just whether a token is set. In-memory
// per serverless instance; resets on cold start. Good enough for a status
// indicator that's checked on every dashboard load.
let _health = {
  lastSuccessAt: null,     // epoch ms of last 2xx
  lastErrorAt: null,       // epoch ms of last error
  lastErrorMessage: null,  // message from the most recent error
};

export function recordSuccess() {
  _health.lastSuccessAt = Date.now();
}

export function recordError(message) {
  _health.lastErrorAt = Date.now();
  _health.lastErrorMessage = message || "Unknown error";
}

export function getTokenStatus() {
  const hasToken = !!tokenCache.accessToken;
  const lastSuccessAt = _health.lastSuccessAt;
  const lastErrorAt = _health.lastErrorAt;
  // "healthy" means: token configured AND a successful call happened more
  // recently than the most recent error (or no errors at all). Untested =
  // token configured but no call has been made yet from this instance.
  const errorSinceSuccess =
    lastErrorAt && (!lastSuccessAt || lastErrorAt > lastSuccessAt);
  return {
    hasToken,
    expiresAt: tokenCache.expiresAt,
    isExpired: tokenCache.expiresAt
      ? new Date(tokenCache.expiresAt) < new Date()
      : false,
    lastSuccessAt,
    lastErrorAt,
    lastErrorMessage: _health.lastErrorMessage,
    state: !hasToken
      ? "no_token"
      : errorSinceSuccess
      ? "failing"
      : lastSuccessAt
      ? "healthy"
      : "untested",
  };
}

// Internal: mutate in-memory cache with merge semantics (preserves the
// existing refresh_token if the caller doesn't provide a new one). Returns
// the persistable snapshot so the public setters can either await or
// fire-and-forget the DB write.
function applyTokensToCache({ accessToken, refreshToken, expiresIn }) {
  tokenCache.accessToken = accessToken;
  tokenCache.refreshToken = refreshToken || tokenCache.refreshToken;
  tokenCache.expiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;
  _tokensLoadedFromDb = true;
  return {
    accessToken: tokenCache.accessToken,
    refreshToken: tokenCache.refreshToken,
    expiresAt: tokenCache.expiresAt,
  };
}

export function setTokens({ accessToken, refreshToken, expiresIn }) {
  // Fire-and-forget DB persistence — used by the hot path (refresh, OAuth
  // device poll). The in-memory cache is the source of truth for *this*
  // request; DB failure shouldn't break the current API call. The new
  // setTokensAndPersist variant below is for callers (the admin recovery
  // endpoint) that NEED to know whether the DB write succeeded.
  const snapshot = applyTokensToCache({ accessToken, refreshToken, expiresIn });
  saveOauthTokens(snapshot).catch((e) =>
    console.error("Token persist failed:", e.message)
  );
}

/**
 * Awaitable variant of setTokens — returns a Promise<boolean> indicating
 * whether the DB write succeeded. Used by /api/admin/semrush-tokens so a
 * silent DB failure doesn't leave the admin with a misleading 200 OK and
 * stale persistence (which then breaks the next cold worker).
 */
export async function setTokensAndPersist({ accessToken, refreshToken, expiresIn }) {
  const snapshot = applyTokensToCache({ accessToken, refreshToken, expiresIn });
  return saveOauthTokens(snapshot);
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

// In-flight refresh shared across concurrent callers in the same worker.
// Without this, two parallel 401s both try to consume the same refresh_token
// and Semrush rejects the second one with invalid_grant — irreversibly
// breaking the chain. Coalescing means both callers get the same successful
// (or same failed) result from a single network call. Cross-worker races
// are still handled by the existing DB-reload fallback in semrushFetch.
let _refreshPromise = null;

export async function refreshAccessToken() {
  if (_refreshPromise) return _refreshPromise;
  if (!tokenCache.refreshToken) throw new Error("No refresh token available");

  _refreshPromise = (async () => {
    // Build the refresh body. Some OAuth servers (depending on client
    // type) require client_id even for refresh; include it defensively
    // if SEMRUSH_CLIENT_ID is set. The device-auth initial flow doesn't
    // need it, but refresh of a device-issued token sometimes does —
    // this is one of the things we're trying to debug right now.
    const bodyParams = {
      grant_type: "refresh_token",
      refresh_token: (tokenCache.refreshToken || "").trim(),
    };
    if (process.env.SEMRUSH_CLIENT_ID) {
      bodyParams.client_id = process.env.SEMRUSH_CLIENT_ID;
    }

    try {
      const res = await fetch(`${SEMRUSH_OAUTH_BASE}/dag/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(bodyParams),
      });
      if (!res.ok) {
        const errorText = await res.text().catch(() => "");

        // Server console gets the full picture so we can diagnose from
        // Vercel logs even if the truncated error message lacks detail.
        // Refresh token is logged as length + first/last 4 chars only —
        // enough to verify identity without leaking the credential.
        const tokenFingerprint = tokenCache.refreshToken
          ? `${tokenCache.refreshToken.length}ch:${tokenCache.refreshToken.slice(0, 4)}…${tokenCache.refreshToken.slice(-4)}`
          : "null";
        console.error("[semrush] Token refresh failed", {
          status: res.status,
          statusText: res.statusText,
          responseBody: errorText.slice(0, 1000),
          requestBodyParams: Object.keys(bodyParams),
          refreshTokenFingerprint: tokenFingerprint,
          hasClientId: !!process.env.SEMRUSH_CLIENT_ID,
        });

        // The thrown error gets surfaced as lastErrorMessage in the
        // health telemetry. Include the response body verbatim
        // (truncated) so the user-visible diagnostic shows exactly what
        // Semrush returned — error code, description, the works.
        const trimmed = errorText.slice(0, 500).replace(/\s+/g, " ").trim();
        throw new Error(`Token refresh failed: ${res.status}${trimmed ? ` — ${trimmed}` : ""}`);
      }
      const data = await res.json();
      setTokens({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
      });
      return data;
    } finally {
      // Always clear so the next refresh attempt can run. Don't hold a
      // failed promise — that would mean a transient failure permanently
      // breaks refresh on this worker.
      _refreshPromise = null;
    }
  })();

  return _refreshPromise;
}

// ---------------------------------------------------------------------------
// Core request helper
// ---------------------------------------------------------------------------

async function semrushFetch(path, options = {}) {
  try {
    // Pull whatever the DB has before we trust the in-memory cache. First
    // call per worker hits the DB; subsequent calls are no-ops via the
    // _tokensLoadedFromDb flag.
    await ensureTokensLoaded();

    // Proactive refresh on expired-by-cached-expiry was removed — it had
    // no DB-reload fallback (unlike the 401 reactive path below), so a
    // worker with stale in-memory tokens would throw before falling back.
    // The 401 reactive path catches both "actually expired" and "cache
    // is wrong about expiry" with the same robust DB-reload retry logic.
    // Cost is one extra round trip when access is genuinely expired —
    // ~100ms, negligible.

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

    // 401 — try refresh once. If refresh fails, another worker may have
    // beaten us to it and consumed the refresh_token we held; re-read DB
    // and try one more time before giving up.
    if (res.status === 401 && tokenCache.refreshToken) {
      try {
        await refreshAccessToken();
        res = await makeRequest(tokenCache.accessToken);
      } catch {
        invalidateLoadedFlag();
        try {
          await ensureTokensLoaded();
          res = await makeRequest(tokenCache.accessToken);
        } catch {
          throw new Error(
            "Semrush token expired and refresh failed. Re-authenticate via OAuth."
          );
        }
      }
    }

    if (res.status === 401) {
      throw new Error(
        "Semrush token is invalid or expired. Update SEMRUSH_BEARER_TOKEN."
      );
    }

    // Retry transient failures: 429 (rate limit) and 5xx (gateway / server
    // errors — Semrush occasionally returns an HTML 502/503/504 page from
    // its edge). Two retries with 2s then 5s backoff. Without the 5xx case
    // a momentary gateway blip kills a whole 50-location bulk batch.
    const isTransient = (s) => s === 429 || s >= 500;
    if (isTransient(res.status)) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      res = await makeRequest(tokenCache.accessToken);
      if (isTransient(res.status)) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        res = await makeRequest(tokenCache.accessToken);
        if (isTransient(res.status)) {
          throw new Error(
            res.status === 429
              ? "Semrush rate limit exceeded after retries. Wait a minute and try again."
              : `Semrush API returned HTTP ${res.status} (server/gateway error) after retries. This is usually transient — retry in a moment.`
          );
        }
      }
    }

    // Read as text first so a non-JSON response (HTML error page from a
    // gateway, a maintenance page, etc.) produces a clear message instead
    // of a cryptic "Unexpected token '<'" JSON.parse failure.
    const rawText = await res.text();
    let body;
    try {
      body = rawText ? JSON.parse(rawText) : {};
    } catch {
      throw new Error(
        `Semrush API returned non-JSON (HTTP ${res.status}) — likely a transient gateway error. Retry in a moment. Response began: ${rawText.slice(0, 80).replace(/\s+/g, " ").trim()}`
      );
    }

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

    recordSuccess();
    return body;
  } catch (err) {
    recordError(err.message);
    throw err;
  }
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
  const rawUrl = semrushLoc.websiteUrl || "";
  const { baseUrl, urlParams } = splitUrl(rawUrl);

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
    website: baseUrl,
    urlParams: urlParams,
    websiteRaw: rawUrl, // original full URL from Semrush
    semrushStatus: semrushLoc.status || null,
    status: semrushLoc.reopenDate ? "temp_closed" : "active",
    reopenDate: semrushLoc.reopenDate || null,
    businessHours: semrushLoc.businessHours || null,
    holidayHours: semrushLoc.holidayHours || null,
    semrushErrors: semrushLoc.errors || [],
    brand: null,
    hoursStatus: detectHoursStatus(semrushLoc),
    lastUpdated: null,
    updatedBy: null,
  };
}

/**
 * Split a URL into base URL and query parameters.
 * "https://example.com/page?utm_source=google&utm_medium=organic"
 *   → { baseUrl: "https://example.com/page", urlParams: "utm_source=google&utm_medium=organic" }
 */
export function splitUrl(fullUrl) {
  if (!fullUrl) return { baseUrl: "", urlParams: "" };
  const qIndex = fullUrl.indexOf("?");
  if (qIndex === -1) return { baseUrl: fullUrl, urlParams: "" };
  return {
    baseUrl: fullUrl.substring(0, qIndex),
    urlParams: fullUrl.substring(qIndex + 1),
  };
}

/**
 * Rejoin a base URL and query parameters into a full URL.
 * If urlParams is empty, returns just the base URL.
 */
export function joinUrl(baseUrl, urlParams) {
  if (!baseUrl) return "";
  if (!urlParams || urlParams.trim() === "") return baseUrl;
  // Strip leading ? if someone includes it
  const params = urlParams.replace(/^\?/, "").trim();
  if (!params) return baseUrl;
  return `${baseUrl}?${params}`;
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

  // Website URL — rejoin base URL with URL parameters
  if (appData.website !== undefined) {
    payload.websiteUrl = joinUrl(appData.website, appData.urlParams || "");
  }

  // Business hours — handle both formats:
  //   App format:    { monday: { open: "08:00", close: "18:00", closed: false } }
  //   Semrush format: { monday: [{ from: "08:00", to: "18:00" }] }
  if (appData.businessHours) {
    const firstDay = Object.values(appData.businessHours)[0];
    if (Array.isArray(firstDay)) {
      // Already in Semrush format — pass through as-is
      payload.businessHours = appData.businessHours;
    } else {
      // App format — convert to Semrush format
      payload.businessHours = {};
      for (const [day, val] of Object.entries(appData.businessHours)) {
        if (val.closed) {
          payload.businessHours[day] = [];
        } else {
          payload.businessHours[day] = [{ from: val.open, to: val.close }];
        }
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
  // Canadian brands must come before US brands (more specific match first)
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

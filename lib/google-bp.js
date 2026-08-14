/**
 * Google Business Profile API client — Phase 0 scaffold.
 *
 * Sister to lib/semrush.js, scoped to what we need for bulk photo pushes:
 *   - OAuth 2.0 authorization-code flow (start + exchange + refresh)
 *   - Account / location listing (Business Information API)
 *   - Media create (Media API)
 *
 * Auth model:
 *   - Single shared connection across the whole tool (one Driven Brands
 *     admin's Google account, Manager role across all GBP locations).
 *   - Tokens persisted in lm_oauth_tokens with provider='google_bp', same
 *     pattern as the Semrush OAuth tokens — survives cold starts and
 *     refresh-token rotation if Google rotates them.
 *
 * Env vars required for OAuth to actually work:
 *   - GOOGLE_BP_CLIENT_ID
 *   - GOOGLE_BP_CLIENT_SECRET
 *   - GOOGLE_BP_REDIRECT_URI  (defaults to current request's origin + callback)
 *
 * This file works safely without those env vars set — the OAuth functions
 * throw a descriptive error, and the status helper reports "no_credentials"
 * so the UI can show a clear "not configured" state instead of crashing.
 */

import { loadOauthTokens, saveOauthTokens } from "@/lib/db";

const PROVIDER = "google_bp";

const GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

const GOOGLE_BP_SCOPES = ["https://www.googleapis.com/auth/business.manage"];

const BUSINESS_INFO_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";
const ACCOUNT_MGMT_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1";
const MEDIA_API_BASE = "https://mybusiness.googleapis.com/v4"; // media still on v4 namespace

// ---------------------------------------------------------------------------
// Configuration check
// ---------------------------------------------------------------------------

export function isGoogleBpConfigured() {
  return !!(process.env.GOOGLE_BP_CLIENT_ID && process.env.GOOGLE_BP_CLIENT_SECRET);
}

function requireConfigured() {
  if (!isGoogleBpConfigured()) {
    throw new Error("Google Business Profile OAuth not configured — set GOOGLE_BP_CLIENT_ID and GOOGLE_BP_CLIENT_SECRET in env");
  }
}

function resolveRedirectUri(requestOrigin) {
  // Explicit env var wins. Otherwise derive from the incoming request's
  // origin — works for both localhost dev and prod without code changes.
  if (process.env.GOOGLE_BP_REDIRECT_URI) return process.env.GOOGLE_BP_REDIRECT_URI;
  if (!requestOrigin) throw new Error("Cannot derive redirect URI — pass requestOrigin or set GOOGLE_BP_REDIRECT_URI");
  return `${requestOrigin}/api/auth/google-bp/callback`;
}

// ---------------------------------------------------------------------------
// Token cache + health
// ---------------------------------------------------------------------------

let tokenCache = {
  accessToken: null,
  refreshToken: null,
  expiresAt: null,
};

let _tokensLoadedFromDb = false;
let _tokenLoadPromise = null;

let _health = {
  lastSuccessAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
};

function recordSuccess() { _health.lastSuccessAt = Date.now(); }
function recordError(message) {
  _health.lastErrorAt = Date.now();
  _health.lastErrorMessage = message || "Unknown error";
}

async function ensureTokensLoaded() {
  if (_tokensLoadedFromDb) return;
  if (!_tokenLoadPromise) {
    _tokenLoadPromise = (async () => {
      try {
        const stored = await loadOauthTokens(PROVIDER);
        if (stored && stored.accessToken) {
          tokenCache.accessToken = stored.accessToken;
          tokenCache.refreshToken = stored.refreshToken || null;
          tokenCache.expiresAt = stored.expiresAt;
        }
      } catch (e) {
        console.error("[google-bp] Token DB init failed:", e.message);
      } finally {
        _tokensLoadedFromDb = true;
      }
    })();
  }
  await _tokenLoadPromise;
}

function invalidateLoadedFlag() {
  _tokensLoadedFromDb = false;
  _tokenLoadPromise = null;
}

export function setTokens({ accessToken, refreshToken, expiresIn }) {
  tokenCache.accessToken = accessToken;
  tokenCache.refreshToken = refreshToken || tokenCache.refreshToken;
  tokenCache.expiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;

  _tokensLoadedFromDb = true;
  saveOauthTokens(
    {
      accessToken: tokenCache.accessToken,
      refreshToken: tokenCache.refreshToken,
      expiresAt: tokenCache.expiresAt,
    },
    PROVIDER
  ).catch((e) => console.error("[google-bp] Token persist failed:", e.message));
}

/**
 * State for the admin status panel. Returned shape mirrors getTokenStatus
 * and getRichStatus from the other clients so the dashboard badge can read
 * all three with the same code.
 */
export async function getGoogleBpStatus() {
  if (!isGoogleBpConfigured()) {
    return {
      configured: false,
      hasToken: false,
      state: "no_credentials",
      message: "Set GOOGLE_BP_CLIENT_ID and GOOGLE_BP_CLIENT_SECRET in env",
    };
  }

  await ensureTokensLoaded();

  const hasToken = !!tokenCache.accessToken;
  const lastSuccessAt = _health.lastSuccessAt;
  const lastErrorAt = _health.lastErrorAt;
  const errorSinceSuccess =
    lastErrorAt && (!lastSuccessAt || lastErrorAt > lastSuccessAt);

  return {
    configured: true,
    hasToken,
    expiresAt: tokenCache.expiresAt,
    isExpired: tokenCache.expiresAt
      ? new Date(tokenCache.expiresAt) < new Date()
      : false,
    lastSuccessAt,
    lastErrorAt,
    lastErrorMessage: _health.lastErrorMessage,
    state: !hasToken
      ? "not_connected"
      : errorSinceSuccess
      ? "failing"
      : lastSuccessAt
      ? "healthy"
      : "untested",
  };
}

// ---------------------------------------------------------------------------
// OAuth 2.0 authorization-code flow
// ---------------------------------------------------------------------------

/**
 * Build the consent-screen URL the user gets redirected to when starting
 * the OAuth flow. `state` is opaque to Google — we use it for CSRF.
 *
 * Google-specific niceties:
 *   - access_type=offline → returns a refresh_token on first consent
 *   - prompt=consent → forces re-consent even if user previously authorized
 *     (needed to reliably get refresh_token on subsequent connects)
 */
export function buildAuthorizationUrl({ state, requestOrigin }) {
  requireConfigured();
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_BP_CLIENT_ID,
    redirect_uri: resolveRedirectUri(requestOrigin),
    response_type: "code",
    scope: GOOGLE_BP_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: state || "",
  });
  return `${GOOGLE_OAUTH_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange the authorization code from the callback for an access+refresh
 * token pair, then persist via setTokens().
 */
export async function exchangeCodeForTokens(code, { requestOrigin } = {}) {
  requireConfigured();
  if (!code) throw new Error("Authorization code is required");

  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_BP_CLIENT_ID,
    client_secret: process.env.GOOGLE_BP_CLIENT_SECRET,
    redirect_uri: resolveRedirectUri(requestOrigin),
    grant_type: "authorization_code",
  });

  const res = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Google token exchange failed: ${data.error_description || data.error || res.status}`);
  }
  setTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token, // may be absent if user previously consented; prompt=consent above mitigates
    expiresIn: data.expires_in,
  });
  return { success: true, expiresIn: data.expires_in, hasRefreshToken: !!data.refresh_token };
}

export async function refreshAccessToken() {
  requireConfigured();
  if (!tokenCache.refreshToken) throw new Error("No Google refresh token available");

  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_BP_CLIENT_ID,
    client_secret: process.env.GOOGLE_BP_CLIENT_SECRET,
    refresh_token: tokenCache.refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Google token refresh failed: ${data.error_description || data.error || res.status}`);
  }
  setTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token, // Google sometimes returns a new one, sometimes not — setTokens preserves existing if undefined
    expiresIn: data.expires_in,
  });
  return data;
}

// ---------------------------------------------------------------------------
// Core request helper — Phase 1 will use this for listing/media calls
// ---------------------------------------------------------------------------

/**
 * Authenticated GET/POST to a GBP API base. Auto-refreshes on 401, retries
 * once on 5xx, parses defensively (HTML error pages become readable errors
 * just like in lib/semrush.js).
 *
 * Not used by the scaffolding routes — the OAuth-flow endpoints handle
 * their own POSTs to the token endpoint directly. This is here so Phase 1
 * (account/location listing) and Phase 3 (media create) can drop in.
 */
export async function googleBpFetch(url, options = {}) {
  try {
    requireConfigured();
    await ensureTokensLoaded();

    const status = await getGoogleBpStatus();
    if (status.isExpired && tokenCache.refreshToken) {
      await refreshAccessToken();
    }

    if (!tokenCache.accessToken) {
      throw new Error("Google account not connected — visit /api/auth/google-bp/start");
    }

    const makeRequest = async (token) =>
      fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      });

    let res = await makeRequest(tokenCache.accessToken);

    if (res.status === 401 && tokenCache.refreshToken) {
      try {
        await refreshAccessToken();
        res = await makeRequest(tokenCache.accessToken);
      } catch {
        invalidateLoadedFlag();
        await ensureTokensLoaded();
        res = await makeRequest(tokenCache.accessToken);
      }
    }

    const isTransient = (s) => s === 429 || s >= 500;
    if (isTransient(res.status)) {
      await new Promise((r) => setTimeout(r, 2000));
      res = await makeRequest(tokenCache.accessToken);
      if (isTransient(res.status)) {
        await new Promise((r) => setTimeout(r, 5000));
        res = await makeRequest(tokenCache.accessToken);
      }
    }

    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        `Google API returned non-JSON (HTTP ${res.status}) — likely a transient gateway error. Response began: ${text.slice(0, 80).replace(/\s+/g, " ").trim()}`
      );
    }

    if (!res.ok) {
      const message = body.error?.message || body.error || `HTTP ${res.status}`;
      throw new Error(`Google API error ${res.status}: ${message}`);
    }

    recordSuccess();
    return body;
  } catch (err) {
    recordError(err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// API surface (Phase 1+ — these are stubs but signatures are stable)
// ---------------------------------------------------------------------------

export const API_BASES = {
  businessInfo: BUSINESS_INFO_BASE,
  accountMgmt: ACCOUNT_MGMT_BASE,
  media: MEDIA_API_BASE,
};

// GBP APIs return `name` fields that already carry the resource prefix
// ("accounts/12345", "locations/67890"). Our DB stores them verbatim.
// These normalizers let helpers accept either the prefixed form (what
// we store) or a bare numeric ID (what a caller might construct
// manually), and produce the correct URL segment in both cases.
// Without this defense, url-construction that adds "accounts/" ends up
// double-prefixing when handed the stored value → HTTP 404 "Requested
// entity was not found." Root cause of the initial bulk-post failure.
function withAccountsPrefix(a) {
  const s = String(a || "");
  return s.startsWith("accounts/") ? s : `accounts/${s}`;
}
function withLocationsPrefix(l) {
  const s = String(l || "");
  return s.startsWith("locations/") ? s : `locations/${l}`;
}

/**
 * List all GBP accounts the connected user can manage. Phase 1.
 *   GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts
 */
export async function listAccounts() {
  return googleBpFetch(`${ACCOUNT_MGMT_BASE}/accounts`);
}

/**
 * List all locations under one GBP account. Phase 1.
 *   GET https://mybusinessbusinessinformation.googleapis.com/v1/{parent=accounts/*}/locations
 * Required readMask: must include at least name + title + storefrontAddress
 * for matching to our shops. paginated via pageToken.
 */
export async function listLocations(accountName, { pageSize = 100, pageToken = null, readMask = "name,title,storefrontAddress,phoneNumbers,websiteUri" } = {}) {
  const params = new URLSearchParams({ pageSize: String(pageSize), readMask });
  if (pageToken) params.set("pageToken", pageToken);
  return googleBpFetch(`${BUSINESS_INFO_BASE}/${accountName}/locations?${params.toString()}`);
}

/**
 * Create a media item for one location. Phase 3.
 *   POST https://mybusiness.googleapis.com/v4/accounts/{accountId}/locations/{locationId}/media
 * Body: { mediaFormat, locationAssociation: { category }, sourceUrl }
 */
export async function createLocationMedia({ gbpAccountId, gbpLocationId, sourceUrl, category = "ADDITIONAL" }) {
  if (!gbpAccountId || !gbpLocationId) throw new Error("gbpAccountId and gbpLocationId are required");
  if (!sourceUrl) throw new Error("sourceUrl is required (use a publicly fetchable URL)");

  const path = `${MEDIA_API_BASE}/${withAccountsPrefix(gbpAccountId)}/${withLocationsPrefix(gbpLocationId)}/media`;
  return googleBpFetch(path, {
    method: "POST",
    body: JSON.stringify({
      mediaFormat: "PHOTO",
      locationAssociation: { category },
      sourceUrl,
    }),
  });
}

// ---------------------------------------------------------------------------
// Local Posts — bulk-post feature
// ---------------------------------------------------------------------------
//
// Endpoint namespace is `mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/localPosts`,
// same v4 base as the media endpoint. STANDARD and OFFER post types are
// what we support in v1 per the scoping decision (see gbp-bulk-posts-scoped
// memory). EVENT and ALERT are omitted from the UI but the raw
// createLocalPost helper below accepts any well-formed body, so we're not
// closing the door on future v2 additions.
//
// Rate-limit context: GBP docs quote 10 edits/minute per Business Profile.
// It's ambiguous whether localPost creation counts as an "edit" for that
// quota — treat as yes to be safe. At the project level we're capped
// around 300 QPM. The bulk-post server route throttles per-shop
// accordingly.

/**
 * Args accepted by the two build* helpers below. Deliberately app-shape
 * (camelCase, human-friendly) instead of the raw Google API shape, since
 * the UI is what constructs these.
 */

/**
 * Build a STANDARD post body from app-shape input. Optional image via
 * `mediaUrl`; optional CTA via `cta` = { actionType, url }.
 *
 * Google requires:
 *   - languageCode (we default to en-US)
 *   - summary (≤1500 chars)
 * All other fields are optional for STANDARD.
 */
export function buildStandardPost({ summary, mediaUrl, cta, languageCode = "en-US" }) {
  if (!summary || typeof summary !== "string") throw new Error("summary is required");
  if (summary.length > 1500) throw new Error("summary exceeds 1500-character limit");

  const body = {
    languageCode,
    summary,
    topicType: "STANDARD",
  };
  if (mediaUrl) {
    body.media = [{ mediaFormat: "PHOTO", sourceUrl: mediaUrl }];
  }
  if (cta && cta.actionType) {
    body.callToAction = { actionType: cta.actionType };
    // CTA URL is required for every actionType EXCEPT "CALL" (which uses
    // the location's own primary phone). Enforce that at the boundary so
    // Google doesn't reject us with a generic error later.
    if (cta.actionType !== "CALL") {
      if (!cta.url) throw new Error(`cta.url is required for actionType=${cta.actionType}`);
      body.callToAction.url = cta.url;
    }
  }
  return body;
}

/**
 * Build an OFFER post body. Offers REQUIRE:
 *   - event.title
 *   - event.schedule.startDate + endDate (each { year, month, day })
 * Offer-specific optional fields: coupon code, redeem URL, terms.
 *
 * `startDate` / `endDate` accepted as ISO date strings ("YYYY-MM-DD") for
 * caller ergonomics; converted here to Google's { year, month, day } shape.
 */
export function buildOfferPost({
  summary,
  title,
  startDate,
  endDate,
  mediaUrl,
  couponCode,
  redeemUrl,
  termsConditions,
  languageCode = "en-US",
}) {
  if (!summary) throw new Error("summary is required");
  if (summary.length > 1500) throw new Error("summary exceeds 1500-character limit");
  if (!title) throw new Error("title is required for OFFER posts");
  if (!startDate || !endDate) throw new Error("startDate and endDate are required for OFFER posts (YYYY-MM-DD)");

  const body = {
    languageCode,
    summary,
    topicType: "OFFER",
    event: {
      title,
      schedule: {
        startDate: isoDateToParts(startDate),
        endDate: isoDateToParts(endDate),
      },
    },
  };
  if (mediaUrl) body.media = [{ mediaFormat: "PHOTO", sourceUrl: mediaUrl }];

  const offer = {};
  if (couponCode) offer.couponCode = couponCode;
  if (redeemUrl) offer.redeemOnlineUrl = redeemUrl;
  if (termsConditions) offer.termsConditions = termsConditions;
  if (Object.keys(offer).length > 0) body.offer = offer;

  return body;
}

function isoDateToParts(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error(`Invalid date "${iso}" — expected YYYY-MM-DD`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/**
 * Create a Local Post on one location. Body is either the output of a
 * build* helper above, or any well-formed post body if the caller knows
 * the raw Google shape.
 *
 * Response includes `name` (the post's `accounts/x/locations/y/localPosts/z`
 * identifier — save this if you want to delete or edit later) and `state`
 * (LIVE, REJECTED, PROCESSING).
 *
 * Rejected posts happen when Google's automated review flags content — we
 * surface that as a per-shop success-with-state-REJECTED in the bulk UI
 * so the admin can see it without treating it as a hard failure.
 */
export async function createLocalPost({ gbpAccountId, gbpLocationId, body }) {
  if (!gbpAccountId || !gbpLocationId) throw new Error("gbpAccountId and gbpLocationId are required");
  if (!body || typeof body !== "object") throw new Error("post body is required");

  const path = `${MEDIA_API_BASE}/${withAccountsPrefix(gbpAccountId)}/${withLocationsPrefix(gbpLocationId)}/localPosts`;
  return googleBpFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * List the Local Posts on one location. Paginated via pageToken. Not
 * strictly needed for v1 bulk-post but useful for the verify-after-fail
 * pattern (create returned 4xx but the post actually landed) and for a
 * future "history per shop" UI.
 */
export async function listLocalPosts({ gbpAccountId, gbpLocationId, pageSize = 50, pageToken = null } = {}) {
  if (!gbpAccountId || !gbpLocationId) throw new Error("gbpAccountId and gbpLocationId are required");
  const params = new URLSearchParams({ pageSize: String(pageSize) });
  if (pageToken) params.set("pageToken", pageToken);
  const path = `${MEDIA_API_BASE}/${withAccountsPrefix(gbpAccountId)}/${withLocationsPrefix(gbpLocationId)}/localPosts?${params.toString()}`;
  return googleBpFetch(path);
}

/**
 * List reviews on one location. Paginated; call this in a loop until
 * `nextPageToken` is absent. Google returns 50 per page by default;
 * `pageSize` can be up to 50.
 *
 * Response shape:
 *   {
 *     reviews: [
 *       {
 *         name: "accounts/x/locations/y/reviews/z",
 *         reviewer: { profilePhotoUrl, displayName, isAnonymous },
 *         starRating: "FIVE" | "FOUR" | "THREE" | "TWO" | "ONE",
 *         comment?,       // absent for pure star-rating reviews (no text)
 *         createTime,     // ISO with Z (UTC)
 *         updateTime,     // ISO with Z (UTC); doesn't change on OUR reply
 *         reviewReply?: { comment, updateTime }
 *       },
 *       ...
 *     ],
 *     averageRating,
 *     totalReviewCount,
 *     nextPageToken?
 *   }
 *
 * starRating is a string enum, not a number — `starRatingToInt` below
 * translates. Same v4 namespace as media/localPosts; same
 * withAccountsPrefix/withLocationsPrefix defensive normalization to
 * avoid the double-prefix 404 bug we hit on the first localPosts call.
 */
export async function listReviews({ gbpAccountId, gbpLocationId, pageSize = 50, pageToken = null, orderBy = "updateTime desc" } = {}) {
  if (!gbpAccountId || !gbpLocationId) throw new Error("gbpAccountId and gbpLocationId are required");
  const params = new URLSearchParams({ pageSize: String(pageSize) });
  if (pageToken) params.set("pageToken", pageToken);
  if (orderBy) params.set("orderBy", orderBy);
  const path = `${MEDIA_API_BASE}/${withAccountsPrefix(gbpAccountId)}/${withLocationsPrefix(gbpLocationId)}/reviews?${params.toString()}`;
  return googleBpFetch(path);
}

/**
 * Translate Google's starRating enum to a 1-5 integer for the DB layer.
 * Returns null for missing/invalid values so a bad API response doesn't
 * poison the aggregation.
 */
export function starRatingToInt(starRating) {
  switch (starRating) {
    case "ONE": return 1;
    case "TWO": return 2;
    case "THREE": return 3;
    case "FOUR": return 4;
    case "FIVE": return 5;
    default: return null;
  }
}

/**
 * Delete a Local Post. `postName` is the full `accounts/x/locations/y/localPosts/z`
 * string returned by createLocalPost. Used by the optional "delete this post
 * from all shops" undo flow — walks lm_gbp_post_pushes rows and calls this
 * for each successful push.
 *
 * Returns {} on success (Google returns HTTP 200 with empty body).
 */
export async function deleteLocalPost(postName) {
  if (!postName) throw new Error("postName is required");
  const path = `${MEDIA_API_BASE}/${postName}`;
  return googleBpFetch(path, { method: "DELETE" });
}

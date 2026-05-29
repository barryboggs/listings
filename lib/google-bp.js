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

  const path = `${MEDIA_API_BASE}/accounts/${encodeURIComponent(gbpAccountId)}/locations/${encodeURIComponent(gbpLocationId)}/media`;
  return googleBpFetch(path, {
    method: "POST",
    body: JSON.stringify({
      mediaFormat: "PHOTO",
      locationAssociation: { category },
      sourceUrl,
    }),
  });
}

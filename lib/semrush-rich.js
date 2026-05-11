/**
 * Semrush Local Listing Management API client (the "rich" API).
 *
 * This is a SUPPLEMENT to lib/semrush.js, not a replacement. The new API
 * exposes fields the deprecated API doesn't (description, categories,
 * coordinates, social handles, featured_message) but has no bulk endpoint
 * and uses different location IDs — see CLAUDE.md.
 *
 * Auth:
 *   Authorization: Apikey <SEMRUSH_API_KEY>
 *   The Apikey comes from the Semrush Subscription Info page (NOT the
 *   OAuth Device Authorization flow used by the deprecated API).
 *
 * Response envelope:
 *   success: { meta: { success: true, status_code, request_id }, data: ... }
 *   error:   { meta: { success: false, status_code, request_id }, error: { code, message, retryable } }
 *
 * Phase-0 verification confirmed: GET works, PATCH works with update_mask,
 * validate_only=true is honored. No bulk endpoint exists at any probed path.
 */

const RICH_API_BASE =
  process.env.SEMRUSH_RICH_API_BASE ||
  "https://api.semrush.com/apis/v4/local/v1";

// ---------------------------------------------------------------------------
// Auth / status
// ---------------------------------------------------------------------------

export function getRichApiKey() {
  return process.env.SEMRUSH_API_KEY || null;
}

export function getRichStatus() {
  const key = getRichApiKey();
  return {
    hasKey: !!key,
    keyHint: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : null,
  };
}

// ---------------------------------------------------------------------------
// Core request helper
// ---------------------------------------------------------------------------

async function richFetch(path, options = {}) {
  const key = getRichApiKey();
  if (!key) {
    throw new Error(
      "No Semrush API key configured. Set SEMRUSH_API_KEY in .env.local"
    );
  }

  const url = `${RICH_API_BASE}${path}`;

  const makeRequest = () =>
    fetch(url, {
      ...options,
      headers: {
        Authorization: `Apikey ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...options.headers,
      },
    });

  let res = await makeRequest();

  // 429 — back off and retry once, then twice
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 2000));
    res = await makeRequest();
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 5000));
      res = await makeRequest();
      if (res.status === 429) {
        throw new Error(
          "Semrush rich API rate limit exceeded after retries. Wait and try again."
        );
      }
    }
  }

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Semrush rich API returned non-JSON ${res.status}: ${text.slice(0, 200)}`);
  }

  if (body?.meta?.success === false) {
    const err = body.error || {};
    throw new Error(
      `Semrush rich API error ${body.meta.status_code}: ${err.message || "Unknown"}`
    );
  }

  if (!res.ok && body?.data === undefined) {
    throw new Error(
      `Semrush rich API error ${res.status}: ${JSON.stringify(body).slice(0, 200)}`
    );
  }

  return body;
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

/**
 * GET a single location by new-API location_id.
 * Returns the raw snake_case object — transform via transformRichLocation()
 * if merging into the app's location shape.
 */
export async function getRichLocation(locationId) {
  const body = await richFetch(`/locations/${locationId}`);
  return body.data;
}

/**
 * GET one page of locations. Default page_size 50 (well under any practical
 * limit, fast enough that pagination loops finish quickly).
 *
 * Response shape (observed):
 *   { meta: {...}, data: [ { location_id, business_name, ... }, ... ] }
 *
 * Whether the response carries a total count / page metadata depends on the
 * API version — we don't assume it does. The list iterator terminates when
 * a short page comes back.
 */
export async function getRichLocations({ page = 1, page_size = 50 } = {}) {
  const body = await richFetch(
    `/locations?page=${page}&page_size=${page_size}`
  );
  return {
    items: Array.isArray(body.data) ? body.data : [],
    page,
    page_size,
    // Pass through any pagination hints if the API provides them
    meta: body.meta || null,
  };
}

/**
 * Walk every page of /locations. 250 ms delay between pages keeps us
 * comfortably under any reasonable rate limit (the deprecated API's read
 * limit was 10/sec; we stay near 4/sec).
 *
 * Safety cap at 500 pages × page_size to prevent runaway loops.
 */
export async function getAllRichLocations({ page_size = 100 } = {}) {
  const all = [];
  let page = 1;
  const MAX_PAGES = 500;

  while (page <= MAX_PAGES) {
    const { items } = await getRichLocations({ page, page_size });
    all.push(...items);

    if (items.length < page_size) break; // short page = last page
    page++;
    await new Promise((r) => setTimeout(r, 250));
  }

  return all;
}

/**
 * PATCH a location. Only fields named in `updateMask` are touched.
 *
 * @param {string} locationId - new-API location_id
 * @param {object} fields - snake_case fields to update (e.g. { description, category_ids, coordinates })
 * @param {string[]} updateMask - field names to include in update_mask (must match fields keys)
 * @param {object} options
 * @param {boolean} options.validateOnly - if true, the API validates but does NOT persist
 */
export async function updateRichLocation(locationId, fields, updateMask, { validateOnly = false } = {}) {
  if (!locationId) throw new Error("locationId is required");
  if (!Array.isArray(updateMask) || updateMask.length === 0) {
    throw new Error("updateMask must be a non-empty array of field names");
  }

  const params = new URLSearchParams();
  params.set("update_mask", updateMask.join(","));
  if (validateOnly) params.set("validate_only", "true");

  const body = await richFetch(
    `/locations/${locationId}?${params.toString()}`,
    {
      method: "PATCH",
      body: JSON.stringify(fields),
    }
  );
  return body.data;
}

// ---------------------------------------------------------------------------
// Categories (for the picker)
// ---------------------------------------------------------------------------

let _categoriesCache = null;
let _categoriesCachedAt = 0;
const CATEGORIES_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Fetch the full category list. Cached in-process for 24 hours.
 * The actual endpoint path is best-effort — Semrush docs reference a
 * "Get Categories" call but the exact path may need adjusting once
 * tested against the live API.
 */
export async function getCategories({ force = false } = {}) {
  if (!force && _categoriesCache && Date.now() - _categoriesCachedAt < CATEGORIES_TTL_MS) {
    return _categoriesCache;
  }

  const body = await richFetch(`/categories`);
  _categoriesCache = body.data || [];
  _categoriesCachedAt = Date.now();
  return _categoriesCache;
}

// ---------------------------------------------------------------------------
// Transformation helpers — rich fields only
// ---------------------------------------------------------------------------

/**
 * Extract the rich fields from a new-API location into the app's camelCase
 * shape. Fields the old API already covers (name, address, hours, etc.) are
 * intentionally NOT included here — those still come from lib/semrush.js's
 * transformLocation(). Use mergeRichFields() to fold these onto an existing
 * location object.
 */
export function transformRichLocation(rich) {
  if (!rich) return null;
  return {
    semrushNewId: rich.location_id,
    description: rich.description || "",
    categoryIds: Array.isArray(rich.category_ids) ? rich.category_ids : [],
    coordinates: rich.coordinates || null, // { latitude, longitude } or null
    suppressAddress: !!rich.suppress_address,
    featuredMessage: rich.featured_message || "",
    featuredMessageUrl: rich.featured_message_url || "",
    youtubeVideo: rich.youtube_video || "",
    instagramUsername: rich.instagram_username || "",
    twitterUsername: rich.twitter_username || "",
    serviceAreaPlaces: Array.isArray(rich.service_area_places) ? rich.service_area_places : [],
    locationStatus: rich.location_status || null,
    submitDate: rich.submit_date || null,
    richErrors: Array.isArray(rich.errors) ? rich.errors : [],
  };
}

/**
 * Build a PATCH payload + update_mask from a partial app-format change set.
 *
 * Input keys (camelCase, app-side): description, categoryIds, coordinates,
 *   suppressAddress, featuredMessage, featuredMessageUrl, youtubeVideo,
 *   instagramUsername, twitterUsername, serviceAreaPlaces
 *
 * Output: { fields: { snake_case_keys }, updateMask: ["snake_case_keys", ...] }
 *
 * Only keys present in `changes` are emitted — the caller controls the mask
 * by deciding what to send.
 */
export function toRichUpdate(changes) {
  const fields = {};
  const updateMask = [];

  const map = {
    description: "description",
    categoryIds: "category_ids",
    coordinates: "coordinates",
    suppressAddress: "suppress_address",
    featuredMessage: "featured_message",
    featuredMessageUrl: "featured_message_url",
    youtubeVideo: "youtube_video",
    instagramUsername: "instagram_username",
    twitterUsername: "twitter_username",
    serviceAreaPlaces: "service_area_places",
  };

  for (const [appKey, apiKey] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(changes, appKey)) {
      fields[apiKey] = changes[appKey];
      updateMask.push(apiKey);
    }
  }

  return { fields, updateMask };
}

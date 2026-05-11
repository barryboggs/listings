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

// Health telemetry — mirrors lib/semrush.js. Used by the status badge so it
// can show whether the rich API is actually responding, not just whether
// SEMRUSH_API_KEY is configured.
let _health = {
  lastSuccessAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
};

function recordRichSuccess() {
  _health.lastSuccessAt = Date.now();
}

function recordRichError(message) {
  _health.lastErrorAt = Date.now();
  _health.lastErrorMessage = message || "Unknown error";
}

export function getRichStatus() {
  const key = getRichApiKey();
  const hasKey = !!key;
  const lastSuccessAt = _health.lastSuccessAt;
  const lastErrorAt = _health.lastErrorAt;
  const errorSinceSuccess =
    lastErrorAt && (!lastSuccessAt || lastErrorAt > lastSuccessAt);
  return {
    hasKey,
    keyHint: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : null,
    lastSuccessAt,
    lastErrorAt,
    lastErrorMessage: _health.lastErrorMessage,
    state: !hasKey
      ? "no_key"
      : errorSinceSuccess
      ? "failing"
      : lastSuccessAt
      ? "healthy"
      : "untested",
  };
}

// ---------------------------------------------------------------------------
// Core request helper
// ---------------------------------------------------------------------------

async function richFetch(path, options = {}) {
  try {
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

    recordRichSuccess();
    return body;
  } catch (err) {
    recordRichError(err.message);
    throw err;
  }
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
 * GET one page of locations.
 *
 * The new API uses offset/limit pagination (NOT page/page_size — that
 * parameter is silently ignored). Hard server cap of 50 per request;
 * larger `limit` values are clamped.
 *
 * Response shape:
 *   { meta: { success, status_code, request_id }, data: [ {...}, ... ] }
 */
export async function getRichLocations({ offset = 0, limit = 50 } = {}) {
  const body = await richFetch(
    `/locations?limit=${limit}&offset=${offset}`
  );
  return {
    items: Array.isArray(body.data) ? body.data : [],
    offset,
    limit,
    meta: body.meta || null,
  };
}

/**
 * Walk every page of /locations using offset/limit. 250 ms delay between
 * requests keeps us well under any reasonable rate limit.
 *
 * Terminates when a page returns fewer items than the limit (i.e. last
 * partial page) OR returns zero items.
 *
 * Safety cap at offset 100,000 prevents runaway loops (2000+ pages at 50
 * each — well beyond any realistic listing count).
 */
export async function getAllRichLocations({ limit = 50 } = {}) {
  const all = [];
  let offset = 0;
  const MAX_OFFSET = 100000;

  while (offset <= MAX_OFFSET) {
    const { items } = await getRichLocations({ offset, limit });
    if (items.length === 0) break;
    all.push(...items);
    if (items.length < limit) break; // last page
    offset += limit;
    await new Promise((r) => setTimeout(r, 250));
  }

  if (offset > MAX_OFFSET) {
    console.warn(
      `[semrush-rich] getAllRichLocations hit MAX_OFFSET (${MAX_OFFSET}) — returned ${all.length} items but more may exist`
    );
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

const CATEGORIES_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Fetch the category list. Cached in-process for 24 hours per country.
 *
 * Confirmed via Phase 3 probes:
 *   - Required: ?country=<ISO2>, case-sensitive (US works, us → 400)
 *   - Default response caps near 1000 items; request limit explicitly
 *   - Item shape: { id, name, full_name, parent_id }
 *
 * @param {{ force?: boolean, country?: string }} opts
 */
const _categoriesCacheByCountry = new Map(); // country → { items, fetchedAt }

export async function getCategories({ force = false, country = "US" } = {}) {
  const cached = _categoriesCacheByCountry.get(country);
  if (!force && cached && Date.now() - cached.fetchedAt < CATEGORIES_TTL_MS) {
    return cached.items;
  }

  const body = await richFetch(
    `/categories?country=${encodeURIComponent(country)}&limit=1000`
  );
  const items = Array.isArray(body.data) ? body.data : [];
  _categoriesCacheByCountry.set(country, { items, fetchedAt: Date.now() });
  return items;
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

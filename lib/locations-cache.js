import { getAllRichLocations } from "@/lib/semrush-rich";
import { detectBrand } from "@/lib/semrush";
import { replaceLocationsCache, getLocationsCacheMeta } from "@/lib/db";

/**
 * Locations-cache refresh.
 *
 * The Semrush rich API's /locations endpoint caps at 50 items/page and has
 * no brand filter, so assembling the full list takes ~60 sequential requests
 * at a 250ms throttle — roughly 30 seconds. That used to run on every
 * dashboard page load. Now it runs here, on a cron (and on demand), and the
 * app reads from lm_locations instead.
 */

// How old the cache can get before an opportunistic refresh is worthwhile.
// The cron runs every 2h; this is only consulted by callers that want to
// top up a cache nobody has refreshed in a long while.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Fetch every location from Semrush and replace the cache contents.
 *
 * Returns { fetched, stored, removed, pruned, durationMs }. Throws if the
 * Semrush walk itself fails — callers decide whether that's fatal or just
 * means "serve what's already cached".
 */
export async function refreshLocationsCache() {
  const startedAt = Date.now();

  const raw = await getAllRichLocations({ limit: 50 });

  const rows = raw
    .filter((rich) => rich && rich.location_id)
    .map((rich) => ({
      locationId: rich.location_id,
      // detectBrand takes the rich shape directly (business_name/website_url).
      brand: detectBrand(rich),
      payload: rich,
    }));

  const result = await replaceLocationsCache(rows);

  return {
    fetched: raw.length,
    durationMs: Date.now() - startedAt,
    ...result,
  };
}

/**
 * True when the cache is empty or old enough to be worth refreshing. Used to
 * decide whether a read path should populate the cache before serving rather
 * than handing back nothing.
 */
export async function isLocationsCacheStale() {
  const meta = await getLocationsCacheMeta();
  if (!meta.available) return false; // no Postgres — nothing to refresh into
  if (meta.count === 0) return true;
  if (!meta.lastSyncedAt) return true;
  return Date.now() - new Date(meta.lastSyncedAt).getTime() > STALE_AFTER_MS;
}

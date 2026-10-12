import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { detectBrand } from "@/lib/semrush";
import {
  getAllRichLocations,
  getRichStatus,
  appLocationFromRich,
} from "@/lib/semrush-rich";
import { LOCATIONS as DEMO_LOCATIONS, getBrandConfig } from "@/lib/data";
import {
  getShopNumberMap,
  getCachedLocations,
  getCachedLocationsSummary,
  getLocationsCacheMeta,
} from "@/lib/db";

// Only the cache-miss path walks the Semrush API, but when it does it needs
// the same headroom as the refresh route.
export const maxDuration = 300;

/**
 * GET /api/semrush/locations
 *
 * Reads from the lm_locations cache (see lib/locations-cache.js). The live
 * Semrush walk is ~30s for a few thousand shops, so it only happens when the
 * cache is empty — otherwise this is one indexed query.
 *
 * Query params:
 *   (none)        → every location the user can see. Unchanged response shape;
 *                   this is what the health, shops, map-markers,
 *                   holiday-import and admin pages all rely on.
 *   ?brand=a,b    → scope to those brands. Served by an indexed lookup, so a
 *                   single brand returns in a fraction of the full set's time.
 *   ?summary=1    → brand counts + status distribution only, no `locations`
 *                   array. Lets the dashboard paint its brand picker and
 *                   status cards without transferring any shop rows.
 *
 * Response adds `cachedAt` (ISO timestamp of the last sync) whenever the data
 * came from the cache, so the UI can show how stale it is.
 */
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await verifyToken(token);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const wantSummary = url.searchParams.get("summary") === "1";
  const brandParam = (url.searchParams.get("brand") || "")
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);

  const hasAllAccess = user.brands.includes("*");
  const canSee = (brandId) => hasAllAccess || user.brands.includes(brandId);

  // Requested brands intersected with what this user is allowed to see.
  const requestedBrands = brandParam.filter(canSee);
  // An explicit brand filter that the user has no access to must not fall
  // through to "all brands" — return nothing instead.
  const brandFilterBlocked = brandParam.length > 0 && requestedBrands.length === 0;

  // Load shop number mappings
  let shopMap = { bySemrushId: new Map(), byShopId: new Map(), byNewSemrushId: new Map(), all: [] };
  try {
    shopMap = await getShopNumberMap();
  } catch {}

  const { hasKey } = getRichStatus();

  if (!hasKey) {
    return NextResponse.json(demoPayload(user, shopMap, {
      message: "Using demo data — set SEMRUSH_API_KEY in .env.local to connect the Semrush API",
    }));
  }

  // --- Summary mode: counts straight out of SQL, no rows transferred ------
  if (wantSummary) {
    try {
      const summary = await getCachedLocationsSummary();
      if (summary && summary.length > 0) {
        const meta = await getLocationsCacheMeta();
        const visible = summary.filter((s) => canSee(s.brand));
        const brands = visible
          .map((s) => {
            const config = getBrandConfig(s.brand || "unknown");
            return {
              id: config.id,
              name: config.name,
              color: config.color,
              locationCount: s.count,
            };
          })
          .sort((a, b) => b.locationCount - a.locationCount);
        const statusCounts = visible.reduce(
          (acc, s) => ({
            total: acc.total + s.count,
            healthy: acc.healthy + s.healthy,
            withErrors: acc.withErrors + s.withErrors,
            tempClosed: acc.tempClosed + s.tempClosed,
          }),
          { total: 0, healthy: 0, withErrors: 0, tempClosed: 0 }
        );
        return NextResponse.json({
          summary: true,
          brands,
          statusCounts,
          source: "cache",
          cachedAt: meta.lastSyncedAt,
        });
      }
    } catch (error) {
      console.error("locations summary error:", error.message);
    }
    // Cache not populated yet — fall through so the live path can both
    // answer this request and give the caller real brand counts.
  }

  // --- Cached read --------------------------------------------------------
  try {
    const meta = await getLocationsCacheMeta();
    if (meta.available && meta.count > 0) {
      if (brandFilterBlocked) {
        return NextResponse.json({
          locations: [],
          brands: [],
          source: "cache",
          cachedAt: meta.lastSyncedAt,
        });
      }
      // No explicit filter: scope to the user's own brands so a restricted
      // user never pulls rows they can't see out of the database.
      const scope = requestedBrands.length > 0
        ? requestedBrands
        : (hasAllAccess ? null : user.brands);

      const payloads = await getCachedLocations({ brands: scope });
      const locations = payloads.map(toAppLocation).filter((loc) => canSee(loc.brand));

      mergeShopNumbers(locations, shopMap);

      return NextResponse.json({
        locations,
        brands: deriveBrands(locations),
        source: "cache",
        cachedAt: meta.lastSyncedAt,
        total: locations.length,
      });
    }
  } catch (error) {
    console.error("locations cache read error:", error.message);
    // Fall through to live.
  }

  // --- Live fetch (cache empty, or cache read failed) ---------------------
  try {
    const raw = await getAllRichLocations({ limit: 50 });
    const all = raw.map(toAppLocation);

    mergeShopNumbers(all, shopMap);

    let filtered = all.filter((loc) => canSee(loc.brand));
    if (brandFilterBlocked) {
      filtered = [];
    } else if (requestedBrands.length > 0) {
      filtered = filtered.filter((loc) => requestedBrands.includes(loc.brand));
    }

    const brands = deriveBrands(filtered);

    if (wantSummary) {
      return NextResponse.json({
        summary: true,
        brands,
        statusCounts: countStatuses(filtered),
        source: "semrush",
        cachedAt: null,
      });
    }

    return NextResponse.json({
      locations: filtered,
      brands,
      source: "semrush",
      total: raw.length,
      cachedAt: null,
    });
  } catch (error) {
    console.error("Semrush API error:", error.message);
    return NextResponse.json(demoPayload(user, shopMap, {
      error: error.message,
      message: "Semrush API error — falling back to demo data",
    }));
  }
}

/** Rich-API payload → app shape, with brand derived. */
function toAppLocation(rich) {
  const app = appLocationFromRich(rich);
  // detectBrand accepts either shape ({ name/website } or {business_name/website_url})
  app.brand = detectBrand(app);
  return app;
}

/**
 * Demo-mode response. Kept as a single helper because three paths need it and
 * the UI treats this fallback as load-bearing (see CLAUDE.md).
 */
function demoPayload(user, shopMap, extra = {}) {
  const filtered = DEMO_LOCATIONS.filter((loc) =>
    user.brands.includes("*") || user.brands.includes(loc.brand)
  );
  mergeShopNumbers(filtered, shopMap);
  return {
    locations: filtered,
    brands: deriveBrands(filtered),
    // Included unconditionally so a ?summary=1 caller gets usable counts even
    // on this path — the dashboard's status cards read statusCounts and would
    // otherwise show zeros once the row list is scoped to a brand.
    statusCounts: countStatuses(filtered),
    source: "demo",
    ...extra,
  };
}

/** Status distribution over app-shape locations. Buckets can overlap. */
function countStatuses(locations) {
  return locations.reduce(
    (acc, loc) => {
      const hasErrors = Array.isArray(loc.semrushErrors) && loc.semrushErrors.length > 0;
      const isTempClosed = loc.status === "temp_closed";
      return {
        total: acc.total + 1,
        healthy: acc.healthy + (!hasErrors && !isTempClosed ? 1 : 0),
        withErrors: acc.withErrors + (hasErrors ? 1 : 0),
        tempClosed: acc.tempClosed + (isTempClosed ? 1 : 0),
      };
    },
    { total: 0, healthy: 0, withErrors: 0, tempClosed: 0 }
  );
}

/**
 * Merge shop numbers into location data.
 *
 * Post-migration: location.id is the rich-API location_id, so the primary
 * lookup key is byNewSemrushId. bySemrushId (old-API ID) is retained as a
 * secondary lookup for legacy demo data / any shops not yet re-synced.
 *
 * Fallbacks by URL and phone remain because some shops in lm_shop_numbers
 * won't have a semrush_new_id populated yet (sync-rich-mappings hasn't
 * been re-run since they were imported).
 */
function mergeShopNumbers(locations, shopMap) {
  const allShops = shopMap.all || [];
  const byShopId = shopMap.byShopId || new Map();

  // Also attach gbpLocationId (and account) from the matched shop row
  // when we find a match — clients like the map-markers page use this
  // to build deep-links into the GBP dashboard without a second query.
  // Same for shop-owned coordinates (populated via CSV import) so the
  // page can indicate "DB coords available" without another round-trip.
  const attachGbp = (loc, shopRow) => {
    if (!shopRow) return;
    if (shopRow.gbp_location_id) loc.gbpLocationId = shopRow.gbp_location_id;
    if (shopRow.gbp_account_id) loc.gbpAccountId = shopRow.gbp_account_id;
    if (typeof shopRow.latitude === "number") loc.shopLatitude = shopRow.latitude;
    if (typeof shopRow.longitude === "number") loc.shopLongitude = shopRow.longitude;
  };

  for (const loc of locations) {
    // Primary: matched by new-API ID
    const byNewId = shopMap.byNewSemrushId?.get(loc.id);
    if (byNewId) {
      loc.shopId = byNewId.shop_id;
      attachGbp(loc, byNewId);
      continue;
    }

    // Secondary: match by legacy old-API ID (demo data, or if a shop row
    // happens to carry the old ID we're now using as loc.id — shouldn't
    // normally happen post-migration but harmless if it does).
    const byOldId = shopMap.bySemrushId?.get(loc.id);
    if (byOldId) {
      loc.shopId = byOldId.shop_id;
      attachGbp(loc, byOldId);
      continue;
    }

    // Fallback: URL substring match
    const url = (loc.websiteRaw || loc.website || "").toLowerCase();
    if (url) {
      let found = false;
      for (const s of allShops) {
        if (s.shop_id && url.includes(s.shop_id.toLowerCase())) {
          loc.shopId = s.shop_id;
          attachGbp(loc, s);
          found = true;
          break;
        }
      }
      if (found) continue;
    }

    // Fallback: phone match
    const locPhone = (loc.phone || "").replace(/[^0-9]/g, "").slice(-10);
    if (locPhone.length >= 10) {
      for (const s of allShops) {
        const shopPhone = (s.phone || "").replace(/[^0-9]/g, "").slice(-10);
        if (shopPhone.length >= 10 && shopPhone === locPhone) {
          loc.shopId = s.shop_id;
          attachGbp(loc, s);
          break;
        }
      }
      if (loc.shopId) continue;
    }

    loc.shopId = null;
  }
}

/**
 * Build a brands summary array from the actual location data.
 * Returns: [{ id, name, color, locationCount }]
 */
function deriveBrands(locations) {
  const brandMap = new Map();

  for (const loc of locations) {
    const brandId = loc.brand || "unknown";
    if (!brandMap.has(brandId)) {
      brandMap.set(brandId, { count: 0 });
    }
    brandMap.get(brandId).count++;
  }

  const brands = [];
  for (const [brandId, { count }] of brandMap) {
    const config = getBrandConfig(brandId);
    brands.push({
      id: config.id,
      name: config.name,
      color: config.color,
      locationCount: count,
    });
  }

  brands.sort((a, b) => b.locationCount - a.locationCount);
  return brands;
}

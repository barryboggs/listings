import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { detectBrand } from "@/lib/semrush";
import {
  getAllRichLocations,
  getRichStatus,
  appLocationFromRich,
} from "@/lib/semrush-rich";
import { LOCATIONS as DEMO_LOCATIONS, getBrandConfig } from "@/lib/data";
import { getShopNumberMap } from "@/lib/db";

export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await verifyToken(token);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Load shop number mappings
  let shopMap = { bySemrushId: new Map(), byShopId: new Map(), byNewSemrushId: new Map(), all: [] };
  try {
    shopMap = await getShopNumberMap();
  } catch {}

  const { hasKey } = getRichStatus();

  if (!hasKey) {
    const filtered = DEMO_LOCATIONS.filter((loc) =>
      user.brands.includes("*") || user.brands.includes(loc.brand)
    );
    mergeShopNumbers(filtered, shopMap);
    const brands = deriveBrands(filtered);
    return NextResponse.json({
      locations: filtered,
      brands,
      source: "demo",
      message: "Using demo data — set SEMRUSH_API_KEY in .env.local to connect the Semrush API",
    });
  }

  try {
    const raw = await getAllRichLocations({ limit: 50 });

    const locations = raw.map((rich) => {
      const app = appLocationFromRich(rich);
      // detectBrand accepts either shape ({ name/website } or {locationName/websiteUrl})
      app.brand = detectBrand(app);
      return app;
    });

    mergeShopNumbers(locations, shopMap);

    const hasAllAccess = user.brands.includes("*");
    const filtered = hasAllAccess
      ? locations
      : locations.filter((loc) => user.brands.includes(loc.brand));

    const brands = deriveBrands(filtered);

    return NextResponse.json({
      locations: filtered,
      brands,
      source: "semrush",
      total: raw.length,
    });
  } catch (error) {
    console.error("Semrush API error:", error.message);

    const filtered = DEMO_LOCATIONS.filter((loc) =>
      user.brands.includes("*") || user.brands.includes(loc.brand)
    );
    mergeShopNumbers(filtered, shopMap);
    const brands = deriveBrands(filtered);
    return NextResponse.json({
      locations: filtered,
      brands,
      source: "demo",
      error: error.message,
      message: "Semrush API error — falling back to demo data",
    });
  }
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

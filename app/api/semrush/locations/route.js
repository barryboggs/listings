import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import {
  getAllLocations,
  getTokenStatus,
  transformLocation,
  detectBrand,
} from "@/lib/semrush";
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
  let shopMap = { bySemrushId: new Map(), byShopId: new Map(), all: [] };
  try {
    shopMap = await getShopNumberMap();
  } catch {}

  const { hasToken } = getTokenStatus();

  if (!hasToken) {
    const filtered = DEMO_LOCATIONS.filter((loc) =>
      user.brands.includes("*") || user.brands.includes(loc.brand)
    );
    mergeShopNumbers(filtered, shopMap);
    const brands = deriveBrands(filtered);
    return NextResponse.json({
      locations: filtered,
      brands,
      source: "demo",
      message: "Using demo data — set SEMRUSH_BEARER_TOKEN in .env.local to connect live API",
    });
  }

  try {
    const raw = await getAllLocations();

    const locations = raw.map((loc) => {
      const transformed = transformLocation(loc);
      transformed.brand = detectBrand(loc);
      return transformed;
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
 * Primary: match by semrush_location_id in the database.
 * Fallback: check if the shop ID appears in the location's website URL.
 * Fallback 2: match by normalized phone number.
 */
function mergeShopNumbers(locations, shopMap) {
  // Build a reverse lookup: all shop records indexed by shop_id
  const allShops = shopMap.all || [];

  for (const loc of locations) {
    // Primary: already matched in database
    const shop = shopMap.bySemrushId.get(loc.id);
    if (shop) {
      loc.shopId = shop.shop_id;
      continue;
    }

    // Fallback: check if any shop ID appears in this location's URL
    const url = (loc.websiteRaw || loc.website || "").toLowerCase();
    if (url) {
      let found = false;
      for (const s of allShops) {
        if (s.shop_id && url.includes(s.shop_id.toLowerCase())) {
          loc.shopId = s.shop_id;
          found = true;
          break;
        }
      }
      if (found) continue;
    }

    // Fallback 2: phone number match
    const locPhone = (loc.phone || "").replace(/[^0-9]/g, "").slice(-10);
    if (locPhone.length >= 10) {
      for (const s of allShops) {
        const shopPhone = (s.phone || "").replace(/[^0-9]/g, "").slice(-10);
        if (shopPhone.length >= 10 && shopPhone === locPhone) {
          loc.shopId = s.shop_id;
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

  // Sort by location count descending
  brands.sort((a, b) => b.locationCount - a.locationCount);
  return brands;
}

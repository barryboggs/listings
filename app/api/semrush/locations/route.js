import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import {
  getAllLocations,
  getTokenStatus,
  transformLocation,
  detectBrand,
} from "@/lib/semrush";
import { LOCATIONS as DEMO_LOCATIONS, getBrandConfig } from "@/lib/data";

export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await verifyToken(token);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { hasToken } = getTokenStatus();

  if (!hasToken) {
    const filtered = DEMO_LOCATIONS.filter((loc) =>
      user.brands.includes("*") || user.brands.includes(loc.brand)
    );
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

    // Admin users (brands: ["*"]) see everything, others are filtered
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

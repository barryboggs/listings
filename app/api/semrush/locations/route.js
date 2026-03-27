import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import {
  getAllLocations,
  getTokenStatus,
  transformLocation,
  detectBrand,
} from "@/lib/semrush";
import { LOCATIONS as DEMO_LOCATIONS } from "@/lib/data";

export async function GET(request) {
  // Verify auth
  const token = request.cookies.get("auth-token")?.value;
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await verifyToken(token);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check if Semrush API is configured
  const { hasToken } = getTokenStatus();

  if (!hasToken) {
    const filtered = DEMO_LOCATIONS.filter((loc) =>
      user.brands.includes(loc.brand)
    );
    return NextResponse.json({
      locations: filtered,
      source: "demo",
      message:
        "Using demo data — set SEMRUSH_BEARER_TOKEN in .env.local to connect live API",
    });
  }

  // Fetch live data from Semrush
  // getAllLocations() paginates through data.content[] across all pages
  try {
    const raw = await getAllLocations();

    const locations = raw.map((loc) => {
      const transformed = transformLocation(loc);
      transformed.brand = detectBrand(loc);
      return transformed;
    });

    // Filter by user's brand access
    const filtered = locations.filter(
      (loc) => user.brands.includes(loc.brand) || loc.brand === "unknown"
    );

    return NextResponse.json({
      locations: filtered,
      source: "semrush",
      total: raw.length,
    });
  } catch (error) {
    console.error("Semrush API error:", error.message);

    // Fallback to demo data
    const filtered = DEMO_LOCATIONS.filter((loc) =>
      user.brands.includes(loc.brand)
    );
    return NextResponse.json({
      locations: filtered,
      source: "demo",
      error: error.message,
      message: "Semrush API error — falling back to demo data",
    });
  }
}

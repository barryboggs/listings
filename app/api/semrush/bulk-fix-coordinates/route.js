import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getGbpLocation, getGoogleBpStatus } from "@/lib/google-bp";
import {
  updateRichLocation,
  getRichStatus,
} from "@/lib/semrush-rich";
import {
  getShopNumbers,
  initDatabase,
  logActivity,
} from "@/lib/db";

// Vercel Pro function timeout. Per shop: 1 GBP GET + 1 Semrush PATCH +
// 250ms throttle ≈ 1s. 30 shops per call ≈ 30s, fits under 60s Pro cap.
export const maxDuration = 90;
const THROTTLE_MS = 250;

/**
 * POST /api/semrush/bulk-fix-coordinates
 *
 * Admin-only. For each requested shop:
 *   1. Source coordinates from lm_shop_numbers.latitude/longitude first
 *      (populated via CSV import — most authoritative for internal shops)
 *   2. Fall back to GBP location's `latlng` via getGbpLocation()
 *   3. PATCH Semrush's `coordinates` field with whatever we sourced
 *
 * Fixes shops where Semrush's `coordinates` field is empty ({} in their
 * API response) — the "map pin not set up" state. Bypasses Semrush's
 * own sync from GBP (which is what's broken for many shops).
 *
 * Source priority:
 *   - DB coords (from admin's CSV import on /dashboard/map-markers)
 *   - GBP latlng (~90% of verified locations have this)
 *   - SKIPPED (neither source has coords — needs CSV import or GBP fix)
 *
 * Request:
 *   { shopIds: ["1234", "1235", ...] }  // Driven Brands shop_ids
 *
 * Response:
 *   {
 *     total, succeeded, skipped, failed,
 *     results: [{ shopId, semrushLocationId, state, source?, latlng?, error? }],
 *   }
 *   source = "db" | "gbp" (only on SUCCESS rows)
 *   state = SUCCESS | SKIPPED | FAILED
 */
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  await initDatabase();

  const gbpStatus = await getGoogleBpStatus();
  if (gbpStatus.state === "no_credentials" || gbpStatus.state === "not_connected") {
    return NextResponse.json(
      { error: `GBP not ready: ${gbpStatus.state}` },
      { status: 412 }
    );
  }

  const richStatus = getRichStatus();
  if (!richStatus.hasKey) {
    return NextResponse.json(
      { error: "SEMRUSH_API_KEY not configured" },
      { status: 412 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const shopIds = Array.isArray(body.shopIds) ? body.shopIds : [];
  if (shopIds.length === 0) {
    return NextResponse.json({ error: "shopIds array is required" }, { status: 400 });
  }
  if (shopIds.length > 50) {
    return NextResponse.json(
      { error: `Max 50 shops per call (got ${shopIds.length}); chunk on the client` },
      { status: 400 }
    );
  }

  const allShops = await getShopNumbers();
  const shopMap = new Map(allShops.map((s) => [s.shop_id, s]));

  const results = [];
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < shopIds.length; i++) {
    const shopId = shopIds[i];
    const shop = shopMap.get(shopId);

    if (!shop) {
      skipped++;
      results.push({ shopId, state: "SKIPPED", error: "Shop not in lm_shop_numbers" });
      if (i < shopIds.length - 1) await new Promise((r) => setTimeout(r, THROTTLE_MS));
      continue;
    }
    if (!shop.semrush_new_id) {
      skipped++;
      results.push({ shopId, state: "SKIPPED", error: "No Semrush new-ID mapping" });
      if (i < shopIds.length - 1) await new Promise((r) => setTimeout(r, THROTTLE_MS));
      continue;
    }

    try {
      // Source priority: DB coords (from admin's CSV import) →
      // GBP latlng → skip. DB wins because the internal shop database
      // has the authoritative lat/lng for company-owned locations;
      // GBP occasionally has stale or missing pins.
      let latitude = null, longitude = null, source = null;
      if (typeof shop.latitude === "number" && typeof shop.longitude === "number") {
        latitude = shop.latitude;
        longitude = shop.longitude;
        source = "db";
      } else if (shop.gbp_location_id) {
        const gbpLoc = await getGbpLocation(shop.gbp_location_id);
        const latlng = gbpLoc?.latlng;
        if (latlng && typeof latlng.latitude === "number" && typeof latlng.longitude === "number") {
          latitude = latlng.latitude;
          longitude = latlng.longitude;
          source = "gbp";
        }
      }

      if (source === null) {
        skipped++;
        results.push({
          shopId,
          semrushLocationId: shop.semrush_new_id,
          state: "SKIPPED",
          error: shop.gbp_location_id
            ? "No DB coordinates for this shop, and GBP has no latlng either. Import via CSV on this page."
            : "No DB coordinates and no GBP mapping. Import via CSV or run GBP mapping sync.",
        });
        if (i < shopIds.length - 1) await new Promise((r) => setTimeout(r, THROTTLE_MS));
        continue;
      }

      // PATCH Semrush's coordinates field. Semrush and GBP both use
      // a plain {latitude, longitude} object — direct pass-through.
      await updateRichLocation(
        shop.semrush_new_id,
        { coordinates: { latitude, longitude } },
        ["coordinates"]
      );

      succeeded++;
      results.push({
        shopId,
        semrushLocationId: shop.semrush_new_id,
        state: "SUCCESS",
        source,
        latlng: { latitude, longitude },
      });
    } catch (err) {
      failed++;
      results.push({
        shopId,
        semrushLocationId: shop.semrush_new_id,
        state: "FAILED",
        error: err.message || "Unknown error",
      });
    }

    if (i < shopIds.length - 1) await new Promise((r) => setTimeout(r, THROTTLE_MS));
  }

  logActivity({
    user: user.name,
    action: "Bulk-fixed Semrush coordinates from GBP",
    location: "",
    brand: "system",
    details: `total:${shopIds.length} succeeded:${succeeded} skipped:${skipped} failed:${failed}`,
  }).catch(() => {});

  return NextResponse.json({
    total: shopIds.length,
    succeeded,
    skipped,
    failed,
    results,
  });
}

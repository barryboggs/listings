import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import {
  updateRichLocation,
  getRichStatus,
  appChangesToRichPatch,
} from "@/lib/semrush-rich";
import { recordPendingPushes } from "@/lib/db";

// See /api/semrush/bulk-update — same shape and same reasoning for these.
export const maxDuration = 90;
const PATCH_THROTTLE_MS = 250;

/**
 * POST - Push a single batch of holiday hour updates to Semrush.
 *
 * Post-migration: loops per-location PATCH on the rich API. The client
 * (dashboard/holiday-import/page.js) already chunks CSV rows into 50-shop
 * batches with inter-batch sleeps; this route handles one batch and
 * throttles per-shop within it.
 *
 * Body: { updates: [{ loc, holidayHours, shopId? }] }
 *   - loc: full app-shape location (must have `id` = rich-API location_id
 *          and, for the business-hours safety belt, businessHours)
 *   - holidayHours: array of special-hours entries to apply
 *   - shopId (optional): Driven Brands shop # for pending-approval record
 */
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { updates } = body;

  if (!updates || !Array.isArray(updates) || updates.length === 0) {
    return NextResponse.json({ error: "updates array is required" }, { status: 400 });
  }

  if (updates.length > 50) {
    return NextResponse.json({ error: "Max 50 updates per batch" }, { status: 400 });
  }

  const { hasKey } = getRichStatus();
  if (!hasKey) {
    return NextResponse.json({
      pushed: 0,
      pushErrors: updates.length,
      errors: updates.map((u) => ({
        locationId: u.loc?.id,
        shopId: u.shopId || u.loc?.shopId || "unknown",
        locationName: u.loc?.name || "",
        error: "SEMRUSH_API_KEY not configured",
      })),
    });
  }

  let pushed = 0;
  let pushErrors = 0;
  const errors = [];
  const successPending = [];

  for (let i = 0; i < updates.length; i++) {
    const update = updates[i];
    const loc = update.loc || {};

    // Holiday-hours-needs-business-hours safety belt — mirrors the old
    // API's requirement; harmless if rich API doesn't need it.
    const changes = { holidayHours: update.holidayHours };
    if (loc.businessHours) changes.businessHours = loc.businessHours;

    const { fields, updateMask } = appChangesToRichPatch(changes);

    try {
      await updateRichLocation(loc.id, fields, updateMask);
      pushed++;
      successPending.push({
        semrushLocationId: loc.id,
        locationName: loc.name || "",
        shopId: update.shopId || loc.shopId || "",
        brand: loc.brand || "",
        fields: "holiday_hours (CSV import)",
        pushedBy: user.name,
      });
    } catch (err) {
      pushErrors++;
      errors.push({
        locationId: loc.id,
        shopId: update.shopId || loc.shopId || "unknown",
        locationName: loc.name || "",
        error: err.message || "Unknown error",
      });
    }

    if (i < updates.length - 1) {
      await new Promise((r) => setTimeout(r, PATCH_THROTTLE_MS));
    }
  }

  if (successPending.length > 0) {
    recordPendingPushes(successPending).catch((e) =>
      console.error("recordPendingPushes (holiday-push):", e.message)
    );
  }

  return NextResponse.json({
    pushed,
    pushErrors,
    errors: errors.length > 0 ? errors : undefined,
  });
}

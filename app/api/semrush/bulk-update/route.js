import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import {
  updateRichLocation,
  getRichStatus,
  appChangesToRichPatch,
} from "@/lib/semrush-rich";
import { recordPendingPushes } from "@/lib/db";

// Vercel Pro function timeout. 50 shops × ~500ms/shop network + 250ms throttle
// = ~37.5s worst case; 90s headroom is plenty and matches the bulk-image route.
export const maxDuration = 90;

// Delay between per-location PATCHes. Rich API doesn't publish a specific
// rate limit; 250ms mirrors what the bulk-image push has been running with
// for months without 429s.
const PATCH_THROTTLE_MS = 250;

// Semrush wants E.164 ("+<digits>"). Mirrors the client-side normalizer
// in components/BulkModal.js — keeping this here too so any caller
// (CSV import, future routes, hand-rolled curl) gets the same lenient
// input handling.
function normalizePhone(input) {
  if (!input) return "";
  const trimmed = String(input).trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) return "+" + trimmed.slice(1).replace(/\D/g, "");
  const digits = trimmed.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

/**
 * PUT /api/semrush/bulk-update
 *
 * Post-migration this loops per-location PATCHes against the rich API
 * (which has no bulk endpoint). Server-side throttled at 250ms/shop; the
 * client (BulkModal) still batches into ≤50-shop chunks so any single
 * call fits inside the Vercel function timeout.
 *
 * Request body:
 *   locationIds: string[]                       // rich-API location_ids
 *   field: "hours" | "phone" | "phone_per_location" | "website" |
 *          "url_params" | "temp_closure" | "holiday_hours" |
 *          "description" | ...rich fields...
 *   value: any                                  // shared value (most fields)
 *   perLocationValues?: { [locationId]: value } // for phone_per_location
 *   existingLocations?: [{ id, businessHours, ... }]  // used only for the
 *       holiday-hours-needs-business-hours safety belt (see below)
 *
 * Response:
 *   { success, source, updated, failed, skipped, results, errors,
 *     updatedBy, updatedAt }
 *   results = [{ locationId, state: "UPDATED"|"FAILED"|"SKIPPED", error? }]
 */
export async function PUT(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!["admin", "manager"].includes(user.role)) {
    return NextResponse.json(
      { error: "Only admins and managers can perform bulk updates" },
      { status: 403 }
    );
  }

  const body = await request.json();
  const { locationIds, field, value, perLocationValues, existingLocations } = body;

  if (!locationIds || !Array.isArray(locationIds) || locationIds.length === 0) {
    return NextResponse.json({ error: "locationIds array is required" }, { status: 400 });
  }

  if (locationIds.length > 50) {
    return NextResponse.json(
      { error: "Maximum 50 locations per bulk update call (client-side chunking)" },
      { status: 400 }
    );
  }

  if (field === "phone_per_location") {
    if (!perLocationValues || typeof perLocationValues !== "object") {
      return NextResponse.json(
        { error: "perLocationValues map is required for phone_per_location" },
        { status: 400 }
      );
    }
    const missing = locationIds.filter((id) => !perLocationValues[id]);
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Missing phone value for ${missing.length} location(s)` },
        { status: 400 }
      );
    }
  }

  const { hasKey } = getRichStatus();
  if (!hasKey) {
    return NextResponse.json({
      success: true,
      source: "demo",
      updated: locationIds.length,
      failed: 0,
      skipped: 0,
      results: locationIds.map((id) => ({ locationId: id, state: "UPDATED" })),
      message: "Demo mode — no actual API calls made.",
      updatedBy: user.name,
      updatedAt: new Date().toISOString(),
    });
  }

  // Existing-hours lookup for the holiday-hours-needs-business-hours safety
  // belt. The old API required businessHours in the payload for a holiday
  // update; we replay it defensively for rich too. If rich turns out to
  // NOT need this, the extra field in the mask is harmless (writes the
  // same value back). Only wired for `holiday_hours` field.
  const existingMap = new Map(
    (existingLocations || []).map((loc) => [loc.id, loc])
  );

  const results = [];
  const successfulRows = [];

  for (let i = 0; i < locationIds.length; i++) {
    const id = locationIds[i];
    const existing = existingMap.get(id) || {};

    // Build the change set for this shop — one entry per app-shape key.
    // Only fields we intend to change go in; the rich PATCH mask is
    // derived from exactly this set.
    const changes = buildChangesForField({ field, value, perLocationValues, existing, id });

    // If nothing to change (e.g. per-location map missing an entry we
    // failed to catch), skip cleanly.
    if (Object.keys(changes).length === 0) {
      results.push({ locationId: id, state: "SKIPPED", error: { message: "No value to apply" } });
      continue;
    }

    const { fields, updateMask } = appChangesToRichPatch(changes);
    if (updateMask.length === 0) {
      results.push({ locationId: id, state: "SKIPPED", error: { message: "No mask emitted for changes" } });
      continue;
    }

    try {
      await updateRichLocation(id, fields, updateMask);
      results.push({ locationId: id, state: "UPDATED" });
      successfulRows.push({
        semrushLocationId: id,
        locationName: existing.name || "",
        shopId: existing.shopId || "",
        brand: body.brand || existing.brand || "",
        fields: field,
        pushedBy: user.name,
      });
    } catch (err) {
      results.push({
        locationId: id,
        state: "FAILED",
        error: { message: err.message || "Unknown error" },
      });
    }

    // Throttle between calls — skip the wait after the last one.
    if (i < locationIds.length - 1) {
      await new Promise((r) => setTimeout(r, PATCH_THROTTLE_MS));
    }
  }

  const updated = results.filter((r) => r.state === "UPDATED").length;
  const failed = results.filter((r) => r.state === "FAILED").length;
  const skipped = results.filter((r) => r.state === "SKIPPED").length;

  if (successfulRows.length > 0) {
    recordPendingPushes(successfulRows).catch((e) =>
      console.error("recordPendingPushes (bulk):", e.message)
    );
  }

  const errors = results
    .filter((r) => r.state === "FAILED")
    .map((r) => ({
      locationId: r.locationId,
      error: r.error?.message || "Unknown error",
    }));

  if (failed > 0) {
    console.error("[bulk-update] Rich API rejected items:", JSON.stringify({
      field,
      failed,
      updated,
      skipped,
      firstFailure: errors[0],
    }, null, 2));
  }

  return NextResponse.json({
    success: failed === 0,
    source: "semrush",
    updated,
    failed,
    skipped,
    results,
    errors: errors.length > 0 ? errors : undefined,
    updatedBy: user.name,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Translate the BulkModal's field/value/perLocationValues protocol into a
 * per-shop app-shape change set. Adding a new bulk field means adding a
 * case here + (if it's a rich-only field) making sure appChangesToRichPatch
 * knows the key.
 *
 * The holiday-hours case defensively piggybacks businessHours if the shop
 * has existing hours — mirrors the old-API workaround for its
 * "you must set business hours for holiday hours setup" quirk. If rich
 * turns out to not need this, the extra key is a no-op (identity write).
 */
function buildChangesForField({ field, value, perLocationValues, existing, id }) {
  switch (field) {
    case "hours":
      return { businessHours: value };
    case "phone":
      return { phone: normalizePhone(typeof value === "string" ? value : value?.phone || "") };
    case "phone_per_location":
      return { phone: normalizePhone(perLocationValues?.[id]) };
    case "website":
      return {
        website: typeof value === "string" ? value : value?.website || "",
        urlParams: existing.urlParams || "",
      };
    case "url_params":
      return {
        website: existing.website || "",
        urlParams: typeof value === "string" ? value : "",
      };
    case "temp_closure":
      return { reopenDate: value?.reopenDate || null };
    case "holiday_hours": {
      const out = { holidayHours: value };
      if (existing.businessHours) out.businessHours = existing.businessHours;
      return out;
    }
    default:
      // Pass-through for anything else (rich fields, ad-hoc). value must be
      // an object whose keys are already in app-shape.
      return (value && typeof value === "object") ? { ...value } : {};
  }
}

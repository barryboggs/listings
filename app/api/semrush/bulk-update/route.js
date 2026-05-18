import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import {
  bulkUpdateLocations,
  getTokenStatus,
  toSemrushFormat,
} from "@/lib/semrush";

// Semrush requires E.164 ("+<digits>"). Mirrors the client-side normalizer
// in components/BulkModal.js — kept here too so any caller (CSV import,
// future routes, hand-rolled curl) gets the same lenient input handling.
function normalizePhone(input) {
  if (!input) return "";
  const trimmed = String(input).trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) return "+" + trimmed.slice(1).replace(/\D/g, "");
  const digits = trimmed.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

export async function PUT(request) {
  // Verify auth
  const token = request.cookies.get("auth-token")?.value;
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await verifyToken(token);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Only admin/manager can bulk update
  if (!["admin", "manager"].includes(user.role)) {
    return NextResponse.json(
      { error: "Only admins and managers can perform bulk updates" },
      { status: 403 }
    );
  }

  const body = await request.json();
  // Expected shape from frontend:
  // {
  //   locationIds: ["id1", "id2", ...],
  //   field: "hours" | "phone" | "phone_per_location" | "website" | "temp_closure" | "holiday_hours",
  //   value: { ... }                                  // shared value (most fields)
  //   perLocationValues: { id: newPhone }             // phone_per_location only
  //   existingLocations: [{ id, name, city, address, phone, ... }]  // current data for required fields
  // }

  const { locationIds, field, value, perLocationValues, existingLocations } = body;

  if (!locationIds || !Array.isArray(locationIds) || locationIds.length === 0) {
    return NextResponse.json(
      { error: "locationIds array is required" },
      { status: 400 }
    );
  }

  if (locationIds.length > 50) {
    return NextResponse.json(
      { error: "Maximum 50 locations per bulk update (Semrush API limit)" },
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

  const { hasToken } = getTokenStatus();

  if (!hasToken) {
    return NextResponse.json({
      success: true,
      source: "demo",
      updated: locationIds.length,
      failed: 0,
      results: locationIds.map((id) => ({ locationId: id, state: "UPDATED" })),
      message: "Demo mode — no actual API calls made.",
      updatedBy: user.name,
      updatedAt: new Date().toISOString(),
    });
  }

  // Build the bulk payload: { locations: [{ id, locationName, city, address, phone, ...changes }] }
  // Required fields (locationName, city, address, phone) must be present on every item.
  // We merge the change into existing location data to satisfy required fields.
  try {
    const existingMap = new Map(
      (existingLocations || []).map((loc) => [loc.id, loc])
    );

    const locations = locationIds.map((id) => {
      const existing = existingMap.get(id) || {};

      // Build the update — start with existing required fields, then overlay the change.
      //
      // We include zip + state even though CLAUDE.md previously said only
      // name/city/address/phone were required. Empirically Semrush also
      // validates `zip` as part of the bulk update — sending nothing fails
      // a US location with "Zip code has invalid US format" because their
      // regex check treats empty as non-matching. Sending the existing
      // value satisfies the validator without changing anything.
      //
      // businessHours rides along because Semrush rejects holiday-hours
      // updates with "You must set business hours for holiday hours setup"
      // when the payload doesn't include them. Same defensive replay as
      // zip — sending the location's current businessHours back unchanged
      // is a no-op for hours but satisfies the validator for any field.
      // If the location has no hours set, we skip the field (so a
      // hours-less location bulk-updating holiday hours will still fail —
      // correct behavior, the user must set business hours first).
      let updateData = {
        name: existing.name || existing.locationName || "",
        city: existing.city || "",
        state: existing.state || "",
        zip: existing.zip || "",
        address: existing.address || "",
        phone: existing.phone || "",
      };
      if (existing.businessHours) {
        updateData.businessHours = existing.businessHours;
      }

      // Apply the specific field change
      switch (field) {
        case "hours":
          updateData.businessHours = value;
          break;
        case "phone":
          updateData.phone = normalizePhone(typeof value === "string" ? value : value?.phone || "");
          break;
        case "phone_per_location":
          // Each location gets its own new phone from the perLocationValues map.
          updateData.phone = normalizePhone(perLocationValues[id]);
          break;
        case "website":
          updateData.website = typeof value === "string" ? value : value?.website || "";
          // Preserve existing URL params when only changing the base URL
          updateData.urlParams = existing.urlParams || "";
          break;
        case "url_params":
          // Keep each location's existing base URL, replace just the parameters
          updateData.website = existing.website || "";
          updateData.urlParams = typeof value === "string" ? value : "";
          break;
        case "temp_closure":
          updateData.reopenDate = value?.reopenDate || null;
          break;
        case "holiday_hours":
          updateData.holidayHours = value;
          break;
        default:
          Object.assign(updateData, value || {});
      }

      const semrushPayload = toSemrushFormat(updateData);
      semrushPayload.id = id;
      return semrushPayload;
    });

    // Single API call — UpdateLocations endpoint
    // Rate limit: 5 req/minute, max 50 locations
    const results = await bulkUpdateLocations(locations);

    // results = [{ locationId, state: "UPDATED"|"FAILED", error? }]
    const updated = results.filter((r) => r.state === "UPDATED").length;
    const failed = results.filter((r) => r.state === "FAILED").length;
    const errors = results
      .filter((r) => r.state === "FAILED")
      .map((r) => ({
        locationId: r.locationId,
        error: r.error?.message || "Unknown error",
        code: r.error?.code,
        details: r.error?.details || [],
      }));

    // If anything failed, log the exact request payload + Semrush response so
    // a developer can see which field Semrush rejected (the per-item "error"
    // message is often the generic "invalid data provided"; `details[]` may
    // pin it to a specific field, or the payload diff may reveal the cause).
    if (failed > 0) {
      console.error("[bulk-update] Semrush rejected items:", JSON.stringify({
        field,
        failed,
        updated,
        firstFailedItem: locations.find((p) => errors.some((e) => e.locationId === p.id)),
        errors,
      }, null, 2));
    }

    return NextResponse.json({
      success: failed === 0,
      source: "semrush",
      updated,
      failed,
      results,
      errors: errors.length > 0 ? errors : undefined,
      updatedBy: user.name,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Semrush bulk update error:", error.message);
    console.error("[bulk-update] Exception during call. Field:", field, "locationIds:", locationIds.length);
    return NextResponse.json(
      {
        success: false,
        error: error.message,
        source: "semrush",
      },
      { status: 502 }
    );
  }
}

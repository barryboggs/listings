import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import {
  bulkUpdateLocations,
  getTokenStatus,
  toSemrushFormat,
} from "@/lib/semrush";

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
  //   field: "hours" | "phone" | "website" | "temp_closure" | "holiday_hours",
  //   value: { ... }
  //   existingLocations: [{ id, name, city, address, phone, ... }]  // current data for required fields
  // }

  const { locationIds, field, value, existingLocations } = body;

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

      // Build the update — start with existing required fields, then overlay the change
      let updateData = {
        name: existing.name || existing.locationName || "",
        city: existing.city || "",
        address: existing.address || "",
        phone: existing.phone || "",
      };

      // Apply the specific field change
      switch (field) {
        case "hours":
          updateData.businessHours = value;
          break;
        case "phone":
          updateData.phone = typeof value === "string" ? value : value?.phone || "";
          break;
        case "website":
          updateData.website = typeof value === "string" ? value : value?.website || "";
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
        details: r.error?.details || [],
      }));

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

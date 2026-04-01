import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { bulkUpdateLocations, toSemrushFormat } from "@/lib/semrush";

/**
 * POST - Push a single batch of holiday hour updates to Semrush.
 * The client calls this repeatedly (one batch at a time) to avoid
 * serverless function timeouts on the free Vercel plan.
 *
 * Body: { updates: [{ loc, holidayHours }] }
 * Each update contains the full location object and the new holiday hours.
 * Max 50 per request (Semrush bulk limit).
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

  // Build Semrush payloads
  const semrushPayloads = updates.map((update) => {
    const loc = update.loc;
    const payload = toSemrushFormat({
      name: loc.name,
      address: loc.address,
      additionalAddressInfo: loc.additionalAddressInfo,
      city: loc.city,
      state: loc.state,
      zip: loc.zip,
      phone: loc.phone,
      website: loc.website,
      urlParams: loc.urlParams,
      businessHours: loc.businessHours,
      holidayHours: update.holidayHours,
      reopenDate: loc.reopenDate,
    });
    payload.id = loc.id;
    return payload;
  });

  let pushed = 0;
  let pushErrors = 0;
  const errors = [];

  try {
    const batchResults = await bulkUpdateLocations(semrushPayloads);

    if (Array.isArray(batchResults)) {
      for (const r of batchResults) {
        if (r.state === "UPDATED") {
          pushed++;
        } else {
          pushErrors++;
          // Find the shop ID for this location
          const update = updates.find((u) => u.loc.id === r.locationId);
          errors.push({
            locationId: r.locationId,
            shopId: update?.shopId || "unknown",
            locationName: update?.loc?.name || "",
            error: r.error?.message || r.state || "Unknown",
          });
        }
      }
    } else {
      pushed = semrushPayloads.length;
    }
  } catch (error) {
    // Entire batch failed — report all locations in this batch
    pushErrors = semrushPayloads.length;
    for (const update of updates) {
      errors.push({
        locationId: update.loc.id,
        shopId: update.shopId || "unknown",
        locationName: update.loc?.name || "",
        error: error.message,
      });
    }
  }

  return NextResponse.json({ pushed, pushErrors, errors: errors.length > 0 ? errors : undefined });
}

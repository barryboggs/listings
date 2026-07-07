import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import {
  getRichLocation,
  updateRichLocation,
  getRichStatus,
  appChangesToRichPatch,
} from "@/lib/semrush-rich";
import { recordPendingPushes } from "@/lib/db";

/**
 * GET /api/semrush/locations/[id]?raw=1  (admin-only diagnostic)
 *
 * Returns the unfiltered upstream payload from the rich API's GET
 * /locations/{id}. Used to probe what fields Semrush is actually
 * returning for a given location without the app-shape transform in
 * the way.
 */
export async function GET(request, { params }) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const wantRaw = new URL(request.url).searchParams.get("raw") === "1";
  if (!wantRaw) {
    return NextResponse.json({ error: "Pass ?raw=1 to receive the upstream payload" }, { status: 400 });
  }
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Admin required for raw=1" }, { status: 403 });
  }

  const { hasKey } = getRichStatus();
  if (!hasKey) {
    return NextResponse.json({ error: "SEMRUSH_API_KEY not configured" }, { status: 412 });
  }

  try {
    const raw = await getRichLocation(params.id);
    return NextResponse.json({ raw });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
}

/**
 * PUT /api/semrush/locations/[id]
 *
 * Post-migration this is really a PATCH: only fields the client sends in
 * `body.changes` (if provided) — or all supplied fields (legacy shape) —
 * are updated. `params.id` is the rich-API location_id.
 *
 * Legacy client shape (still supported):
 *   { name, phone, address, city, ... }  // all top-level = changed
 * New client shape (preferred):
 *   { changes: { phone: "+1..." }, brand?, shopId? }  // only phone changes
 *
 * The PATCH mask is built from whichever keys are present.
 */
export async function PUT(request, { params }) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (user.role === "viewer") {
    return NextResponse.json({ error: "Viewers cannot edit locations" }, { status: 403 });
  }

  const locationId = params.id;
  const body = await request.json();

  const { hasKey } = getRichStatus();
  if (!hasKey) {
    return NextResponse.json({
      success: true,
      source: "demo",
      locationId,
      message: "Demo mode — no actual API call made. Set SEMRUSH_API_KEY to go live.",
      updatedBy: user.name,
      updatedAt: new Date().toISOString(),
    });
  }

  // Accept either shape: an explicit `changes` object OR a legacy flat
  // payload where the whole body is the change set. Strip out non-field
  // metadata (brand, shopId) so they don't confuse the mask builder.
  const rawChanges = body.changes && typeof body.changes === "object"
    ? body.changes
    : (() => {
        const { brand, shopId, ...rest } = body;
        return rest;
      })();

  const { fields, updateMask } = appChangesToRichPatch(rawChanges);

  if (updateMask.length === 0) {
    return NextResponse.json(
      { error: "No editable fields in request. Send at least one field to update." },
      { status: 400 }
    );
  }

  try {
    const result = await updateRichLocation(locationId, fields, updateMask);

    // Record in the pending-approval queue so the user can find this shop
    // later in /dashboard/pending-approval without hunting in Semrush.
    recordPendingPushes([{
      semrushLocationId: locationId,
      locationName: rawChanges.name || body.name || "",
      shopId: body.shopId || "",
      brand: body.brand || "",
      fields: `single edit: ${updateMask.join(", ")}`,
      pushedBy: user.name,
    }]).catch((e) => console.error("recordPendingPushes (single):", e.message));

    return NextResponse.json({
      success: true,
      source: "semrush",
      locationId,
      updatedFields: updateMask,
      result,
      updatedBy: user.name,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Semrush update error:", error.message);
    return NextResponse.json(
      { success: false, error: error.message, locationId },
      { status: 502 }
    );
  }
}

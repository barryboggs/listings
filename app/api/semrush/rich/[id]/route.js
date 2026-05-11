import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getNewIdForOldId, logActivity } from "@/lib/db";
import {
  getRichLocation,
  getRichStatus,
  toRichUpdate,
  transformRichLocation,
  updateRichLocation,
} from "@/lib/semrush-rich";

/**
 * GET /api/semrush/rich/[id]
 *
 * The [id] path segment is the OLD-API location id (what EditModal has on
 * hand). This route looks up the corresponding new-API location_id via
 * the lm_shop_numbers mapping, fetches the rich payload, and returns the
 * app-shaped subset (description, categories, coordinates, featured
 * message, social handles, etc.).
 *
 * Response shapes:
 *   200 — { rich: { ...transformRichLocation output... } }
 *   200 — { rich: null, reason: "no_mapping" | "no_apikey" }
 *         (these are user-facing-warnable states, not errors)
 *   502 — { error } (upstream API error)
 */
export async function GET(request, { params }) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: oldId } = params;
  if (!oldId) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const richStatus = getRichStatus();
  if (!richStatus.hasKey) {
    return NextResponse.json({
      rich: null,
      reason: "no_apikey",
      message: "SEMRUSH_API_KEY not configured — rich fields unavailable",
    });
  }

  const newId = await getNewIdForOldId(oldId);
  if (!newId) {
    return NextResponse.json({
      rich: null,
      reason: "no_mapping",
      message: "No new-API mapping for this location. Run the rich-field mapping sync on /dashboard/admin.",
    });
  }

  try {
    const raw = await getRichLocation(newId);
    return NextResponse.json({ rich: transformRichLocation(raw) });
  } catch (error) {
    return NextResponse.json(
      { error: error.message, newId },
      { status: 502 }
    );
  }
}

/**
 * PATCH /api/semrush/rich/[id]
 *
 * Update rich fields on the new API. `[id]` is still the OLD-API id —
 * we resolve to the new-API location_id via the mapping table.
 *
 * Request body:
 *   { changes: { description?, categoryIds?, coordinates?, featuredMessage?,
 *                featuredMessageUrl?, youtubeVideo?, instagramUsername?,
 *                twitterUsername?, suppressAddress?, serviceAreaPlaces? },
 *     validateOnly?: boolean,
 *     locationName?: string  // for the activity log entry only
 *   }
 *
 * Only fields present in `changes` are sent in the PATCH — toRichUpdate
 * builds both the payload and the update_mask from the same input keys.
 *
 * Roles: any logged-in user (mirrors the read route). If you want this
 * gated to editors+, add a role check here — for now, viewers can't open
 * EditModal so this is effectively editor-gated by the UI.
 */
export async function PATCH(request, { params }) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "viewer") {
    return NextResponse.json({ error: "Viewers cannot edit locations" }, { status: 403 });
  }

  const { id: oldId } = params;
  if (!oldId) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const changes = body.changes || {};
  const validateOnly = !!body.validateOnly;
  const locationName = body.locationName || "";

  if (!Object.keys(changes).length) {
    return NextResponse.json({ error: "No changes provided" }, { status: 400 });
  }

  if (!getRichStatus().hasKey) {
    return NextResponse.json(
      { error: "SEMRUSH_API_KEY not configured" },
      { status: 412 }
    );
  }

  const newId = await getNewIdForOldId(oldId);
  if (!newId) {
    return NextResponse.json(
      {
        error: "No new-API mapping for this location. Run the rich-field mapping sync on /dashboard/admin.",
        reason: "no_mapping",
      },
      { status: 404 }
    );
  }

  const { fields, updateMask } = toRichUpdate(changes);
  if (updateMask.length === 0) {
    return NextResponse.json({ error: "No recognized rich fields in changes" }, { status: 400 });
  }

  try {
    const raw = await updateRichLocation(newId, fields, updateMask, { validateOnly });
    const rich = transformRichLocation(raw);

    if (!validateOnly) {
      await logActivity({
        user: user.name,
        action: "Updated rich fields",
        location: locationName || oldId,
        brand: "system",
        details: `Fields: ${updateMask.join(", ")}`,
      });
    }

    return NextResponse.json({ rich, updateMask });
  } catch (error) {
    return NextResponse.json(
      { error: error.message, newId, updateMask },
      { status: 502 }
    );
  }
}

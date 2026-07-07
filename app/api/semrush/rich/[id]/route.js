import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { logActivity } from "@/lib/db";
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
 * Post-migration `[id]` IS the rich-API location_id (same as everywhere
 * else). Kept as a distinct route from `/api/semrush/locations/[id]?raw=1`
 * because EditModal's Extras tab calls this specific URL — retained for
 * compatibility. New code should read rich fields directly from the
 * app-shape location object built by appLocationFromRich().
 *
 * Query params:
 *   ?raw=1  (admin only) — includes the unfiltered upstream payload
 *           in `raw` alongside the transformed `rich`. Diagnostic.
 *
 * Response shapes:
 *   200 — { rich: { ...transformRichLocation output... }, raw?: {...} }
 *   200 — { rich: null, reason: "no_apikey" }
 *   502 — { error } (upstream API error)
 */
export async function GET(request, { params }) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = params;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const wantRaw = new URL(request.url).searchParams.get("raw") === "1";
  if (wantRaw && user.role !== "admin") {
    return NextResponse.json({ error: "Admin required for raw=1" }, { status: 403 });
  }

  if (!getRichStatus().hasKey) {
    return NextResponse.json({
      rich: null,
      reason: "no_apikey",
      message: "SEMRUSH_API_KEY not configured — rich fields unavailable",
    });
  }

  try {
    const raw = await getRichLocation(id);
    return NextResponse.json(
      wantRaw
        ? { rich: transformRichLocation(raw), raw }
        : { rich: transformRichLocation(raw) }
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
}

/**
 * PATCH /api/semrush/rich/[id]
 *
 * Update rich fields on the new API. `[id]` is the rich-API location_id.
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
 * Roles: any logged-in user (mirrors the read route). Viewers rejected.
 */
export async function PATCH(request, { params }) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "viewer") {
    return NextResponse.json({ error: "Viewers cannot edit locations" }, { status: 403 });
  }

  const { id } = params;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

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

  const { fields, updateMask } = toRichUpdate(changes);
  if (updateMask.length === 0) {
    return NextResponse.json({ error: "No recognized rich fields in changes" }, { status: 400 });
  }

  try {
    const raw = await updateRichLocation(id, fields, updateMask, { validateOnly });
    const rich = transformRichLocation(raw);

    if (!validateOnly) {
      await logActivity({
        user: user.name,
        action: "Updated rich fields",
        location: locationName || id,
        brand: "system",
        details: `Fields: ${updateMask.join(", ")}`,
      });
    }

    return NextResponse.json({ rich, updateMask });
  } catch (error) {
    return NextResponse.json(
      { error: error.message, updateMask },
      { status: 502 }
    );
  }
}

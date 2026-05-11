import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getNewIdForOldId } from "@/lib/db";
import {
  getRichLocation,
  getRichStatus,
  transformRichLocation,
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

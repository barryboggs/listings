import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getNewIdForOldId } from "@/lib/db";
import { listLocationImages, createLocationImage } from "@/lib/semrush-rich";

/**
 * Admin-only diagnostic for the (newly-discovered) image endpoints on
 * Semrush's Listing Management API. Use this to verify request/response
 * shapes before we build the bulk-push UI.
 *
 *   GET  /api/admin/probe-images?shopId=31941
 *        → lists images currently on that shop
 *        Side-effect free.
 *
 *   POST /api/admin/probe-images
 *        Body: { shopId, sourceUrl, category?, validateOnly? }
 *        → attempts upload via POST /locations/:id/images
 *        Set validateOnly: true first to see if the shape works without
 *        committing. If Semrush honors validate_only here as they do on
 *        the location PATCH endpoint, nothing is stored. If not, the
 *        image actually uploads — start with a placeholder.
 *
 * Both modes accept either `shopId` (Driven Brands shop #) OR
 * `oldLocationId` (the deprecated-API location_id). The route resolves
 * to the rich-API location_id via the existing lm_shop_numbers mapping.
 *
 * Returns the raw Semrush response so we can see the actual field
 * names and use them to drive the bulk-push UI's request building.
 */

async function requireAdmin(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const user = await verifyToken(token);
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (user.role !== "admin") {
    return { error: NextResponse.json({ error: "Admin access required" }, { status: 403 }) };
  }
  return { user };
}

// Resolve shopId → rich-API location_id by reusing the existing
// /api/semrush/locations route (which merges shop numbers onto the raw
// locations response). Cheaper and more correct than re-implementing
// the merge here.
async function findByShopIdViaLocationsRoute(shopId, request) {
  const origin = new URL(request.url).origin;
  const res = await fetch(`${origin}/api/semrush/locations`, {
    headers: { Cookie: request.headers.get("cookie") || "" },
  });
  const data = await res.json();
  const match = (data.locations || []).find((l) => String(l.shopId) === String(shopId));
  return match || null;
}

export async function GET(request) {
  const { error } = await requireAdmin(request);
  if (error) return error;

  const url = new URL(request.url);
  const shopId = url.searchParams.get("shopId");
  const oldLocationId = url.searchParams.get("oldLocationId");

  // Simpler path for shopId — use the locations route (which handles
  // shop merge for us) instead of re-implementing the merge here.
  let newId = null;
  let foundLocation = null;
  if (oldLocationId) {
    newId = await getNewIdForOldId(oldLocationId);
    if (!newId) {
      return NextResponse.json({ error: "No rich-API mapping for that location. Run the rich-mappings sync." }, { status: 404 });
    }
  } else if (shopId) {
    const loc = await findByShopIdViaLocationsRoute(shopId, request);
    if (!loc) {
      return NextResponse.json({ error: `No location found for shopId=${shopId}` }, { status: 404 });
    }
    newId = await getNewIdForOldId(loc.id);
    if (!newId) {
      return NextResponse.json({ error: `Found ${loc.name} (semrushId=${loc.id}) but no rich-API mapping. Run the rich-mappings sync.` }, { status: 404 });
    }
    foundLocation = { semrushId: loc.id, name: loc.name };
  } else {
    return NextResponse.json({ error: "Provide ?shopId=... or ?oldLocationId=..." }, { status: 400 });
  }

  try {
    const raw = await listLocationImages(newId);
    return NextResponse.json({ newId, foundLocation, raw });
  } catch (e) {
    return NextResponse.json({ error: e.message, newId, foundLocation }, { status: 502 });
  }
}

export async function POST(request) {
  const { error } = await requireAdmin(request);
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const { shopId, oldLocationId, sourceUrl, category = "ADDITIONAL", validateOnly = false } = body;

  if (!sourceUrl) {
    return NextResponse.json({ error: "sourceUrl is required" }, { status: 400 });
  }

  let newId = null;
  let foundLocation = null;
  if (oldLocationId) {
    newId = await getNewIdForOldId(oldLocationId);
    if (!newId) {
      return NextResponse.json({ error: "No rich-API mapping for that location" }, { status: 404 });
    }
  } else if (shopId) {
    const loc = await findByShopIdViaLocationsRoute(shopId, request);
    if (!loc) {
      return NextResponse.json({ error: `No location found for shopId=${shopId}` }, { status: 404 });
    }
    newId = await getNewIdForOldId(loc.id);
    if (!newId) {
      return NextResponse.json({ error: `Found ${loc.name} but no rich-API mapping` }, { status: 404 });
    }
    foundLocation = { semrushId: loc.id, name: loc.name };
  } else {
    return NextResponse.json({ error: "Provide shopId or oldLocationId in body" }, { status: 400 });
  }

  try {
    const raw = await createLocationImage(newId, { sourceUrl, category, validateOnly });
    return NextResponse.json({
      newId,
      foundLocation,
      requestSent: {
        path: `/locations/${newId}/images${validateOnly ? "?validate_only=true" : ""}`,
        body: { sourceUrl, category },
      },
      raw,
    });
  } catch (e) {
    return NextResponse.json({
      error: e.message,
      newId,
      foundLocation,
      requestAttempted: { sourceUrl, category, validateOnly },
    }, { status: 502 });
  }
}

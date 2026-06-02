import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getNewIdForOldId } from "@/lib/db";
import { listLocationImages, createLocationImage, createLocationImageRaw, uploadLocationImage } from "@/lib/semrush-rich";

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
  const {
    shopId, oldLocationId,
    sourceUrl, category = "ADDITIONAL", validateOnly = false,
    body: rawBody,
    multipartUrl, // NEW: if provided, fetch this URL server-side and upload as multipart
  } = body;

  // Three modes:
  //   1. JSON typed: createLocationImage(newId, { sourceUrl, category, validateOnly })
  //   2. JSON raw: createLocationImageRaw(newId, body, { validateOnly })
  //   3. Multipart (matches what Semrush's own UI does): server fetches
  //      `multipartUrl`, wraps as multipart/form-data with a `file` part,
  //      POSTs to /images. Confirmed working in their UI; this tests
  //      whether it works on the public API too.
  if (!rawBody && !sourceUrl && !multipartUrl) {
    return NextResponse.json({ error: "Provide `multipartUrl` (multipart mode), `sourceUrl` (typed JSON), or `body` (raw JSON)" }, { status: 400 });
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

  // Multipart mode — server fetches the image, wraps as multipart/form-data
  if (multipartUrl) {
    let fileBytes, contentType, filename;
    try {
      const imgRes = await fetch(multipartUrl);
      if (!imgRes.ok) {
        return NextResponse.json({
          error: `Failed to fetch multipartUrl: HTTP ${imgRes.status}`,
          multipartUrl,
        }, { status: 400 });
      }
      const arrayBuffer = await imgRes.arrayBuffer();
      fileBytes = arrayBuffer;
      contentType = imgRes.headers.get("content-type") || "application/octet-stream";
      const urlPath = new URL(multipartUrl).pathname;
      filename = urlPath.substring(urlPath.lastIndexOf("/") + 1) || "image";
    } catch (e) {
      return NextResponse.json({ error: `Fetching multipartUrl failed: ${e.message}` }, { status: 400 });
    }

    try {
      const raw = await uploadLocationImage(newId, { fileBytes, filename, contentType });
      return NextResponse.json({
        newId,
        foundLocation,
        requestSent: {
          path: `/locations/${newId}/images`,
          contentType,
          filename,
          sizeBytes: fileBytes.byteLength || fileBytes.size,
        },
        raw,
      });
    } catch (e) {
      return NextResponse.json({
        error: e.message,
        newId,
        foundLocation,
        requestAttempted: {
          path: `/locations/${newId}/images`,
          mode: "multipart",
          contentType,
          filename,
          sizeBytes: fileBytes.byteLength || fileBytes.size,
        },
      }, { status: 502 });
    }
  }

  // JSON mode (existing typed + raw paths)
  const requestPath = `/locations/${newId}/images${validateOnly ? "?validate_only=true" : ""}`;
  const sentBody = rawBody ? rawBody : { sourceUrl, category };

  try {
    const raw = rawBody
      ? await createLocationImageRaw(newId, rawBody, { validateOnly })
      : await createLocationImage(newId, { sourceUrl, category, validateOnly });

    return NextResponse.json({
      newId,
      foundLocation,
      requestSent: { path: requestPath, body: sentBody },
      raw,
    });
  } catch (e) {
    return NextResponse.json({
      error: e.message,
      newId,
      foundLocation,
      requestAttempted: { path: requestPath, body: sentBody, validateOnly },
    }, { status: 502 });
  }
}

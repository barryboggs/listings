import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { createLocationImage, listLocationImages } from "@/lib/semrush-rich";
import { recordImagePush, resolveImagePush, getShopNumberMap } from "@/lib/db";

// If an image POST appears to fail, do one GET on the shop's images and
// check whether a fresh image was added in this window. We hit a pattern
// with ~1.4MB payloads where Semrush returned 400 "Invalid request" but
// actually stored the image — verify-after-fail rescues those.
const VERIFY_WINDOW_SECONDS = 60;

// Semrush returns createDate as "2026-06-02T18:25:46.485" — bare ISO
// with no timezone marker. JS Date parses these inconsistently (local
// vs UTC). Force UTC by appending Z if missing.
function parseSemrushDate(str) {
  if (!str || typeof str !== "string") return NaN;
  const hasTimezone = /[Zz]$/.test(str) || /[+-]\d{2}:?\d{2}$/.test(str);
  return new Date(hasTimezone ? str : `${str}Z`).getTime();
}

// Bump the Vercel function timeout from the 60s Pro default to 90s.
// Each per-shop call typically takes 1-2s (250ms throttle + Semrush
// response). At 30 shops/batch we expect ~32s of work; the extra
// headroom absorbs slow shops or transient Semrush latency without
// killing the batch midway. Pro accounts can go up to 300s if needed.
export const maxDuration = 90;

/**
 * POST /api/semrush/bulk-image
 *
 * Pushes one image to every selected shop. Workflow:
 *
 *   1. Resolve eligible shops — those passed in `shopIds[]` (filtered to
 *      ones that have a semrush_new_id mapping) OR every shop with a
 *      mapping in the named brand. Shops without a rich-API mapping
 *      can't receive an image push and are reported as "skipped".
 *
 *   2. Fetch sourceUrl ONCE server-side and base64-encode ONCE. The
 *      same buffer is reused for every shop's request, so we don't
 *      pay network+encode cost N times.
 *
 *   3. Loop sequentially with a small throttle. Each iteration:
 *      records a PENDING audit row → POSTs to Semrush → resolves
 *      the row to SUCCESS|FAILED with returned image_id / url or
 *      the error message.
 *
 * Body:
 *   { brand: string, sourceUrl: string, type?: "PHOTO", description?: string,
 *     shopIds?: string[] }      // optional — if omitted, pushes to every
 *                                 // shop in the brand with a new-API mapping
 *
 * Response:
 *   { success: boolean, total, succeeded, failed, skipped,
 *     errors: [{ shopId, semrushNewId, error }],
 *     pushIds: [number]        // audit row ids for the run, for follow-up queries
 *   }
 */

// Conservative throttle between sequential POSTs. Semrush hasn't
// published a per-second limit for the rich /images endpoint; the
// general rich-API throttle elsewhere uses 250ms so we mirror it.
const PER_SHOP_DELAY_MS = 250;

export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["admin", "manager"].includes(user.role)) {
    return NextResponse.json({ error: "Admin or manager access required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const { brand, sourceUrl, type = "PHOTO", description, shopIds } = body;

  if (!brand) return NextResponse.json({ error: "brand is required" }, { status: 400 });
  if (!sourceUrl) return NextResponse.json({ error: "sourceUrl is required" }, { status: 400 });

  // Fetch the source bytes once, base64 once. Big throughput win for the
  // common "same logo across 200 shops" case.
  let contentBase64;
  let sourceContentType;
  let sourceSize;
  try {
    const imgRes = await fetch(sourceUrl);
    if (!imgRes.ok) {
      return NextResponse.json({ error: `Failed to fetch sourceUrl: HTTP ${imgRes.status}` }, { status: 400 });
    }
    const arrayBuffer = await imgRes.arrayBuffer();
    contentBase64 = Buffer.from(arrayBuffer).toString("base64");
    sourceContentType = imgRes.headers.get("content-type") || "application/octet-stream";
    sourceSize = arrayBuffer.byteLength;
  } catch (error) {
    return NextResponse.json({ error: `Fetching sourceUrl failed: ${error.message}` }, { status: 400 });
  }

  // Find eligible target shops in lm_shop_numbers. Need to have a
  // semrush_new_id (rich-API mapping) to be pushable.
  const { all: allShops } = await getShopNumberMap();
  const filteredByBrand = allShops.filter((s) => s.brand === brand);
  const shopIdSet = Array.isArray(shopIds) && shopIds.length > 0
    ? new Set(shopIds.map(String))
    : null;
  const targets = filteredByBrand.filter((s) => {
    if (shopIdSet && !shopIdSet.has(String(s.shop_id))) return false;
    return !!s.semrush_new_id;
  });

  // For accurate "skipped" reporting, count brand shops missing the mapping
  const eligibleBrandShops = filteredByBrand.filter((s) => !shopIdSet || shopIdSet.has(String(s.shop_id)));
  const skippedNoMapping = eligibleBrandShops.length - targets.length;

  if (targets.length === 0) {
    return NextResponse.json({
      success: false,
      error: skippedNoMapping > 0
        ? `No shops with a rich-API mapping. ${skippedNoMapping} shops were eligible by brand/shopIds but lack semrush_new_id. Run Sync Rich Mappings from the Admin page.`
        : "No matching shops",
      total: 0,
      succeeded: 0,
      failed: 0,
      skipped: skippedNoMapping,
      errors: [],
      pushIds: [],
    }, { status: 400 });
  }

  let succeeded = 0;
  let failed = 0;
  const errors = [];
  const pushIds = [];

  for (let i = 0; i < targets.length; i++) {
    const shop = targets[i];

    let pushId = null;
    try {
      pushId = await recordImagePush({
        shopId: shop.shop_id,
        brand: shop.brand,
        semrushNewId: shop.semrush_new_id,
        sourceUrl,
        type,
        description,
        pushedBy: user.name,
      });
      if (pushId) pushIds.push(pushId);

      const raw = await createLocationImage(shop.semrush_new_id, { contentBase64, type, description });
      // Semrush returns { id, url, type, createDate }
      await resolveImagePush(pushId, {
        success: true,
        semrushImageId: raw?.id || raw?.data?.id || null,
        semrushImageUrl: raw?.url || raw?.data?.url || null,
      });
      succeeded++;
    } catch (error) {
      const errMsg = error.message || String(error);
      const pushedAtMs = Date.now();

      // Verify-after-fail: under load Semrush sometimes returns a 400
      // "Invalid request" body after actually storing the image (see
      // memory). Before marking FAILED, do one GET to see if our image
      // landed within the verify window. If so, mark SUCCESS instead.
      let actuallyLanded = null;
      try {
        const existing = await listLocationImages(shop.semrush_new_id);
        const items = Array.isArray(existing?.data) ? existing.data : [];
        // Find an image whose createDate is within the verify window.
        for (const it of items) {
          const created = parseSemrushDate(it?.createDate);
          if (!isNaN(created) && Math.abs(pushedAtMs - created) < VERIFY_WINDOW_SECONDS * 1000) {
            actuallyLanded = it;
            break;
          }
        }
      } catch (_verifyErr) {
        // GET also failed — fall through to genuine failure recording.
      }

      if (actuallyLanded) {
        if (pushId) {
          await resolveImagePush(pushId, {
            success: true,
            semrushImageId: actuallyLanded.id || null,
            semrushImageUrl: actuallyLanded.url || null,
          });
        }
        succeeded++;
        // Quietly absorb — this isn't a real failure for the user.
      } else {
        failed++;
        if (pushId) {
          await resolveImagePush(pushId, { success: false, errorMessage: errMsg });
        }
        if (errors.length < 50) {
          errors.push({
            shopId: shop.shop_id,
            semrushNewId: shop.semrush_new_id,
            error: errMsg,
          });
        }
      }
    }

    if (i < targets.length - 1) {
      await new Promise((r) => setTimeout(r, PER_SHOP_DELAY_MS));
    }
  }

  return NextResponse.json({
    success: failed === 0,
    total: targets.length,
    succeeded,
    failed,
    skipped: skippedNoMapping,
    errors,
    pushIds,
    sourceBytes: sourceSize,
    sourceContentType,
  });
}

/**
 * GET /api/semrush/bulk-image?brand=foo&state=SUCCESS&limit=100
 *
 * Reads from lm_image_pushes for the history panel on the page.
 */
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const brand = url.searchParams.get("brand") || null;
  const state = url.searchParams.get("state") || null;
  const sourceUrl = url.searchParams.get("sourceUrl") || null;
  const limit = parseInt(url.searchParams.get("limit") || "100", 10);

  const { getImagePushes } = await import("@/lib/db");
  const rows = await getImagePushes({ brand, state, sourceUrl, limit });
  return NextResponse.json({ rows, count: rows.length });
}

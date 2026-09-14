import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { updateLocalPost, getGoogleBpStatus } from "@/lib/google-bp";
import {
  getGbpPostPushes,
  getShopNumbers,
  initDatabase,
  logActivity,
} from "@/lib/db";

export const maxDuration = 90;
const THROTTLE_MS = 250;
const MAX_PER_CALL = 50;

/**
 * POST /api/gbp/bulk-update-link
 *
 * Admin-only. PATCHes an existing bulk-post batch's CTA URL (STANDARD)
 * or Redeem URL (OFFER) across shops. Reuses per-shop URL + UTM mode
 * from the create flow — the request body tells the route how the new
 * URL should be sourced per shop.
 *
 * Preserves other fields (couponCode, terms, actionType) by reading
 * them from the audit row's stored post_body and only replacing the
 * URL. Uses fine-grained updateMask so unrelated fields on Google's
 * side aren't touched either.
 *
 * Client chunks 30 shops per call, server processes up to 50 per
 * invocation, returns remainingShopIds so client can loop.
 *
 * Request:
 *   {
 *     batchId: string,
 *     shopIds?: string[],       // omit on first call; server returns
 *                                // remainingShopIds for subsequent calls
 *     newUrl?: string,          // fixed URL for every shop
 *     useShopWebsite?: boolean, // OR: shop.website + UTM per-shop
 *     utmSuffix?: string,       // required (or defaulted) when
 *                                // useShopWebsite is true
 *   }
 *
 * Response:
 *   {
 *     batchId, total, succeeded, failed, skipped,
 *     results: [{ shopId, gbpPostName, state, error?, gbpPostState? }],
 *     remainingShopIds: [...]
 *   }
 */
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || !["admin", "manager"].includes(user.role)) {
    return NextResponse.json({ error: "Admin or manager access required" }, { status: 403 });
  }

  await initDatabase();

  const gbpStatus = await getGoogleBpStatus();
  if (gbpStatus.state === "no_credentials" || gbpStatus.state === "not_connected") {
    return NextResponse.json(
      { error: `GBP not ready: ${gbpStatus.state}` },
      { status: 412 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const { batchId, newUrl, useShopWebsite, utmSuffix } = body;
  const explicitShopIds = Array.isArray(body.shopIds) && body.shopIds.length > 0
    ? new Set(body.shopIds)
    : null;

  if (!batchId) return NextResponse.json({ error: "batchId is required" }, { status: 400 });
  if (!useShopWebsite && !(typeof newUrl === "string" && newUrl.trim())) {
    return NextResponse.json(
      { error: "Either newUrl (fixed URL) or useShopWebsite=true is required" },
      { status: 400 }
    );
  }

  // Load batch rows. Only SUCCESS/REJECTED with gbp_post_name are
  // valid targets — FAILED never landed on Google, so nothing to
  // update; AUTO_DELETED was already removed.
  const allRows = await getGbpPostPushes({ batchId, limit: 5000 });
  let candidates = allRows.filter((r) =>
    (r.state === "SUCCESS" || r.state === "REJECTED") &&
    r.gbp_post_name &&
    r.gbp_account_id &&
    r.gbp_location_id
  );
  if (explicitShopIds) candidates = candidates.filter((r) => explicitShopIds.has(r.shop_id));

  if (candidates.length === 0) {
    return NextResponse.json({
      batchId, total: 0, succeeded: 0, failed: 0, skipped: 0,
      results: [], remainingShopIds: [],
      note: "No live posts in this batch — nothing to update.",
    });
  }

  // Pull shop rows to resolve per-shop websites when useShopWebsite=true.
  const allShops = await getShopNumbers();
  const shopMap = new Map(allShops.map((s) => [s.shop_id, s]));

  const allCandidateShopIds = candidates.map((r) => r.shop_id);
  const processing = candidates.slice(0, MAX_PER_CALL);
  const remainingShopIds = allCandidateShopIds.slice(MAX_PER_CALL);

  const results = [];
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < processing.length; i++) {
    const row = processing[i];
    const shop = shopMap.get(row.shop_id);

    // Determine the URL to push for this specific shop.
    let resolvedUrl;
    if (useShopWebsite) {
      if (!shop || !shop.website) {
        skipped++;
        results.push({
          shopId: row.shop_id,
          gbpPostName: row.gbp_post_name,
          state: "SKIPPED",
          error: "Shop has no website in the DB — can't resolve per-shop URL",
        });
        if (i < processing.length - 1) await new Promise((r) => setTimeout(r, THROTTLE_MS));
        continue;
      }
      resolvedUrl = buildShopUrl(shop.website, utmSuffix);
    } else {
      resolvedUrl = newUrl.trim();
    }

    // Load the stored post_body so we can preserve non-URL fields
    // (actionType for STANDARD, coupon/terms/title for OFFER). If
    // it's missing/malformed, we degrade to sensible defaults.
    const storedBody = row.post_body || {};
    let patchBody = null;
    let updateMask = null;

    if (row.topic_type === "STANDARD") {
      const existingCta = storedBody.callToAction || {};
      const actionType = existingCta.actionType || "LEARN_MORE";
      patchBody = { callToAction: { actionType, url: resolvedUrl } };
      updateMask = "callToAction";
    } else if (row.topic_type === "OFFER") {
      const existingOffer = storedBody.offer || {};
      patchBody = { offer: { ...existingOffer, redeemOnlineUrl: resolvedUrl } };
      updateMask = "offer";
    } else {
      skipped++;
      results.push({
        shopId: row.shop_id,
        gbpPostName: row.gbp_post_name,
        state: "SKIPPED",
        error: `topic_type=${row.topic_type} isn't link-updateable`,
      });
      if (i < processing.length - 1) await new Promise((r) => setTimeout(r, THROTTLE_MS));
      continue;
    }

    try {
      const response = await updateLocalPost({
        postName: row.gbp_post_name,
        body: patchBody,
        updateMask,
      });
      succeeded++;
      results.push({
        shopId: row.shop_id,
        gbpPostName: row.gbp_post_name,
        state: "SUCCESS",
        gbpPostState: response?.state || null,
      });
    } catch (err) {
      failed++;
      results.push({
        shopId: row.shop_id,
        gbpPostName: row.gbp_post_name,
        state: "FAILED",
        error: err.message || "Unknown error",
      });
    }

    if (i < processing.length - 1) await new Promise((r) => setTimeout(r, THROTTLE_MS));
  }

  logActivity({
    user: user.name,
    action: "Bulk-updated GBP post link",
    location: "",
    brand: allRows[0]?.brand || "system",
    details: `batch:${batchId} processed:${processing.length} succeeded:${succeeded} failed:${failed} skipped:${skipped} useShopWebsite:${!!useShopWebsite}`,
  }).catch(() => {});

  return NextResponse.json({
    batchId,
    total: processing.length,
    succeeded,
    failed,
    skipped,
    results,
    remainingShopIds,
  });
}

/**
 * Duplicated from /api/gbp/bulk-post — appends UTM suffix to a shop's
 * URL, stripping any existing query string first so the admin's UTM
 * is the sole query on the resulting URL.
 */
function buildShopUrl(shopWebsite, utmSuffix) {
  if (!shopWebsite) return "";
  const base = shopWebsite.split("?")[0];
  const suffix = (utmSuffix || "").trim().replace(/^[?&]+/, "");
  if (!suffix) return base;
  return `${base}?${suffix}`;
}

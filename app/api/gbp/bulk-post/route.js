import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import {
  createLocalPost,
  buildStandardPost,
  buildOfferPost,
  getGoogleBpStatus,
} from "@/lib/google-bp";
import {
  getShopNumbers,
  recordGbpPostPush,
  resolveGbpPostPush,
  getGbpPostBatches,
  initDatabase,
  logActivity,
} from "@/lib/db";

// Vercel Pro function timeout. Per-shop createLocalPost is ~400-800ms;
// with 250ms throttle, a 30-shop chunk lands in ~30-40s comfortably
// inside the 90s ceiling. Client batches at 30 shops/call.
export const maxDuration = 90;

// Throttle between per-shop createLocalPost calls. Google's docs are
// ambiguous whether localPosts count against the 10-edits/min-per-profile
// quota; each shop is a distinct profile so serial calls to different
// shops don't stack on any single profile's quota — the ceiling is the
// project-level 300 QPM (~200ms floor). We use 250ms for headroom.
const POST_THROTTLE_MS = 250;

/**
 * POST /api/gbp/bulk-post
 *
 * Bulk-post to every eligible shop in a brand (or a specified shop_ids
 * subset). Loops per-shop, throttled, writes an audit row per attempt
 * to lm_gbp_post_pushes grouped by batchId.
 *
 * Request body:
 *   {
 *     brand: "maaco-us",
 *     shopIds?: ["1234", "1235", ...],       // if omitted → all shops in brand
 *                                              // with a gbp_location_id populated
 *     topicType: "STANDARD" | "OFFER",
 *     post: {                                  // app-shape post fields
 *       summary,           // ≤1500 chars, required
 *       mediaUrl?,         // optional image URL
 *       cta?: { actionType, url? },  // STANDARD only
 *       title?,            // OFFER only, required for OFFER
 *       startDate?, endDate?,        // OFFER only, YYYY-MM-DD, required for OFFER
 *       couponCode?, redeemUrl?, termsConditions?  // OFFER only, all optional
 *     },
 *     batchId: "<uuid or timestamp-string>"    // client-generated so a resumed run
 *                                                can join the same audit group
 *   }
 *
 * Response:
 *   {
 *     batchId, brand, topicType, total, succeeded, failed, rejected, skipped,
 *     results: [{ shopId, state, gbpPostName?, gbpPostState?, error? }],
 *     errors: [{ shopId, error }]   // only failures, capped
 *   }
 */
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["admin", "manager"].includes(user.role)) {
    return NextResponse.json({ error: "Only admins and managers can bulk-post to GBP" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const { brand, shopIds, topicType, post, batchId } = body;

  if (!brand || !topicType || !post || !batchId) {
    return NextResponse.json(
      { error: "brand, topicType, post, and batchId are required" },
      { status: 400 }
    );
  }
  if (topicType !== "STANDARD" && topicType !== "OFFER") {
    return NextResponse.json(
      { error: `topicType must be STANDARD or OFFER (got ${topicType})` },
      { status: 400 }
    );
  }

  const status = await getGoogleBpStatus();
  if (status.state === "no_credentials" || status.state === "not_connected") {
    return NextResponse.json(
      { error: `GBP not ready: ${status.state}`, hint: "Visit /api/auth/google-bp/start" },
      { status: 412 }
    );
  }

  // Defensive schema init — makes sure lm_gbp_post_pushes exists before
  // we attempt any audit write. Idempotent (CREATE TABLE IF NOT EXISTS),
  // ~50ms per cold worker, guarantees audit rows can't be silently
  // stranded if the admin forgot to POST /api/db after a schema addition.
  await initDatabase();

  // Upfront validation. We can't fully-build the post body up here anymore
  // because per-shop URL modes (cta.useShopWebsite / offer.useShopWebsite)
  // require substituting each shop's own website in. Instead we do a
  // "trial build" with a dummy website so summary-length / date / etc.
  // errors 400 the whole request before we touch any shop; then rebuild
  // per shop inside the loop with real URLs.
  try {
    const trialPost = resolvePerShopUrls(post, { website: "https://example.com" }, topicType);
    if (topicType === "STANDARD") buildStandardPost(trialPost);
    else buildOfferPost(trialPost);
  } catch (e) {
    return NextResponse.json({ error: `Invalid post body: ${e.message}` }, { status: 400 });
  }

  // Resolve target shops. Client can pass explicit shopIds (typical when
  // the UI has already filtered / de-selected); otherwise we take every
  // shop in the brand with a gbp_location_id populated.
  const allShops = await getShopNumbers();
  const brandShops = allShops.filter((s) => s.brand === brand);
  const targetShops = shopIds && Array.isArray(shopIds) && shopIds.length > 0
    ? brandShops.filter((s) => shopIds.includes(s.shop_id))
    : brandShops;

  if (targetShops.length === 0) {
    return NextResponse.json({ error: `No shops found for brand=${brand}` }, { status: 400 });
  }
  if (targetShops.length > 50) {
    return NextResponse.json(
      { error: `Maximum 50 shops per bulk-post call (got ${targetShops.length}); chunk on the client` },
      { status: 400 }
    );
  }

  const results = [];
  const errors = [];
  let succeeded = 0;
  let failed = 0;
  let rejected = 0;
  let skipped = 0;

  for (let i = 0; i < targetShops.length; i++) {
    const shop = targetShops[i];

    // Skip cleanly if this shop lacks a GBP mapping — reported as
    // SKIPPED (distinct from FAILED) so the UI can tell the admin
    // "N shops need mapping" rather than treating it as a Google error.
    if (!shop.gbp_location_id) {
      skipped++;
      results.push({
        shopId: shop.shop_id,
        state: "SKIPPED",
        error: "No gbp_location_id — run mapping sync on /dashboard/admin",
      });
      continue;
    }

    // Resolve per-shop URLs (CTA and/or redeem may be shop-website-mode).
    // If the shop lacks a website in that mode, skip cleanly — same shape
    // as the "no gbp_location_id" skip above so the UI treats both
    // consistently.
    let perShopPost;
    try {
      perShopPost = resolvePerShopUrls(post, shop, topicType);
    } catch (e) {
      skipped++;
      results.push({
        shopId: shop.shop_id,
        state: "SKIPPED",
        error: e.message,
      });
      continue;
    }

    let postBody;
    try {
      postBody = topicType === "STANDARD" ? buildStandardPost(perShopPost) : buildOfferPost(perShopPost);
    } catch (e) {
      // Should not happen — validated upfront — but if a shop's data
      // produces a build error (e.g. malformed URL), report as failed.
      failed++;
      results.push({ shopId: shop.shop_id, state: "FAILED", error: `Build error: ${e.message}` });
      continue;
    }

    const auditId = await recordGbpPostPush({
      batchId,
      shopId: shop.shop_id,
      brand: shop.brand,
      gbpAccountId: shop.gbp_account_id,
      gbpLocationId: shop.gbp_location_id,
      topicType,
      summary: post.summary,
      postBody,
      // Store the offer's end date so the cleanup cron can find and
      // delete this post from Google once the offer expires. STANDARD
      // posts don't expire (this stays null).
      offerEndDate: topicType === "OFFER" ? post.endDate : null,
      pushedBy: user.name,
    });

    try {
      const response = await createLocalPost({
        gbpAccountId: shop.gbp_account_id,
        gbpLocationId: shop.gbp_location_id,
        body: postBody,
      });

      // Google can return state=REJECTED even on a 200 response (their
      // automated review deemed the content unfit). Surface as its own
      // bucket so the admin can review — it's neither a hard failure
      // nor a clean success. LIVE and PROCESSING both count as success.
      const gbpPostState = response?.state || "PROCESSING";
      const isRejected = gbpPostState === "REJECTED";

      if (isRejected) {
        rejected++;
        await resolveGbpPostPush(auditId, {
          state: "REJECTED",
          gbpPostName: response?.name || null,
          gbpPostState,
        });
        results.push({
          shopId: shop.shop_id,
          state: "REJECTED",
          gbpPostName: response?.name || null,
          gbpPostState,
        });
      } else {
        succeeded++;
        await resolveGbpPostPush(auditId, {
          state: "SUCCESS",
          gbpPostName: response?.name || null,
          gbpPostState,
        });
        results.push({
          shopId: shop.shop_id,
          state: "SUCCESS",
          gbpPostName: response?.name || null,
          gbpPostState,
        });
      }
    } catch (err) {
      failed++;
      const message = err.message || "Unknown error";
      await resolveGbpPostPush(auditId, { state: "FAILED", error: message });
      results.push({ shopId: shop.shop_id, state: "FAILED", error: message });
      if (errors.length < 20) errors.push({ shopId: shop.shop_id, error: message });
    }

    // Throttle between shops — skip the wait after the last one.
    if (i < targetShops.length - 1) {
      await new Promise((r) => setTimeout(r, POST_THROTTLE_MS));
    }
  }

  // Only log an activity entry from THIS server call. The client can
  // fire multiple chunked calls per bulk run; each will log separately,
  // which is fine — batch_id in the audit table stitches them back
  // together for the history UI.
  logActivity({
    user: user.name,
    action: `Bulk GBP post (${topicType})`,
    location: `${brand} — ${targetShops.length} shops`,
    brand,
    details: `succeeded:${succeeded} failed:${failed} rejected:${rejected} skipped:${skipped} · batch:${batchId}`,
  }).catch((e) => console.error("logActivity (gbp-bulk-post):", e.message));

  return NextResponse.json({
    batchId,
    brand,
    topicType,
    total: targetShops.length,
    succeeded,
    failed,
    rejected,
    skipped,
    results,
    errors: errors.length > 0 ? errors : undefined,
  });
}

// ---------------------------------------------------------------------------
// Per-shop URL resolution — CTA and Redeem URLs can be a global constant
// (same for every shop) or resolved from each shop's own website column
// with an optional UTM suffix appended for campaign attribution.
// ---------------------------------------------------------------------------

/**
 * Return a copy of the post object with any per-shop-website URL modes
 * substituted for this specific shop. Throws if the shop lacks a website
 * value while a per-shop mode is enabled — caller should treat that as
 * SKIPPED with a "no website" reason.
 */
function resolvePerShopUrls(post, shop, topicType) {
  const out = { ...post };

  if (topicType === "STANDARD" && out.cta) {
    const cta = { ...out.cta };
    if (cta.useShopWebsite) {
      if (!shop.website) {
        throw new Error("Shop record has no website — cannot use as CTA URL");
      }
      cta.url = buildShopUrl(shop.website, cta.utmSuffix);
      delete cta.useShopWebsite;
      delete cta.utmSuffix;
    }
    out.cta = cta;
  }

  if (topicType === "OFFER") {
    if (out.useShopWebsite) {
      if (!shop.website) {
        throw new Error("Shop record has no website — cannot use as Redeem URL");
      }
      out.redeemUrl = buildShopUrl(shop.website, out.utmSuffix);
      delete out.useShopWebsite;
      delete out.utmSuffix;
    }
  }

  return out;
}

/**
 * Replace a shop's URL query string with a UTM suffix. Any existing
 * query params on shopWebsite (e.g. utm_source baked in from the
 * Semrush marketing feed) get stripped before the suffix is appended
 * so the shop's post ends up with EXACTLY the UTM the admin entered —
 * no doubled/conflicting params that break campaign attribution.
 *
 * Suffix is accepted with or without a leading "?" or "&" for caller
 * ergonomics — user can paste "?utm_source=..." or "utm_source=..."
 * and either works.
 */
function buildShopUrl(shopWebsite, utmSuffix) {
  if (!shopWebsite) return "";
  // Strip any existing querystring (and fragment after it) so the
  // admin's UTM is the SOLE query string on the resulting URL.
  const base = shopWebsite.split("?")[0];
  const suffix = (utmSuffix || "").trim().replace(/^[?&]+/, "");
  if (!suffix) return base;
  return `${base}?${suffix}`;
}

/**
 * GET /api/gbp/bulk-post?limit=50
 *
 * Recent bulk-post batches for the history panel. Each row is aggregated
 * from lm_gbp_post_pushes grouped by batch_id, with counts by state.
 * Any logged-in user can read (viewers see, don't act).
 */
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = Number(new URL(request.url).searchParams.get("limit")) || 50;
  const batches = await getGbpPostBatches({ limit: Math.min(Math.max(limit, 1), 200) });
  return NextResponse.json({ batches });
}

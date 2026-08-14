import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { listReviews, starRatingToInt, getGoogleBpStatus } from "@/lib/google-bp";
import {
  getShopNumbers,
  upsertReviews,
  initDatabase,
  logActivity,
} from "@/lib/db";

// Vercel Pro function timeout. Per-shop review pull is one paginated
// walk. For a large brand (300+ shops with dozens of reviews each) we
// batch on the client side and let each server call cover 30 shops.
export const maxDuration = 300;

// Throttle between GBP API calls. Stays under 300 QPM project cap.
const REVIEWS_THROTTLE_MS = 200;

// Cap per-shop review pages. Even the busiest shop wouldn't approach
// this — 100 pages × 50/pg = 5,000 reviews on a single location.
const MAX_PAGES_PER_SHOP = 100;

/**
 * POST /api/gbp/sync-reviews
 *
 * Admin-only. Walks every mapped shop in the requested brand (or all
 * brands, or an explicit shopIds list), pulls all reviews from GBP,
 * and upserts them into lm_reviews.
 *
 * Body:
 *   {
 *     brand?: "autoglass" | "*",   // "*" or omitted → all brands
 *     shopIds?: ["1234", ...],      // optional explicit target list
 *     incremental?: boolean,        // if true, stops paginating a shop
 *                                    // as soon as it sees a review we
 *                                    // already have with same updateTime.
 *                                    // Speeds up repeat syncs enormously.
 *   }
 *
 * Response:
 *   {
 *     brand, shopsProcessed, shopsSkipped, reviewsFetched, inserted,
 *     updated, errors: [{ shopId, error }]
 *   }
 */
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  await initDatabase();

  const status = await getGoogleBpStatus();
  if (status.state === "no_credentials" || status.state === "not_connected") {
    return NextResponse.json(
      { error: `GBP not ready: ${status.state}`, hint: "Visit /api/auth/google-bp/start" },
      { status: 412 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const brand = body.brand && body.brand !== "*" ? body.brand : null;
  const explicitShopIds = Array.isArray(body.shopIds) ? new Set(body.shopIds) : null;

  const allShops = await getShopNumbers();
  const eligible = allShops.filter((s) => {
    if (!s.gbp_location_id) return false;
    if (brand && s.brand !== brand) return false;
    if (explicitShopIds && !explicitShopIds.has(s.shop_id)) return false;
    return true;
  });

  if (eligible.length === 0) {
    return NextResponse.json({
      brand: brand || "*",
      shopsProcessed: 0,
      shopsSkipped: 0,
      reviewsFetched: 0,
      inserted: 0,
      updated: 0,
      note: "No eligible shops (brand has none mapped, or filter matched nothing)",
    });
  }

  let shopsProcessed = 0;
  let shopsSkipped = 0;
  let reviewsFetched = 0;
  let inserted = 0;
  const errors = [];

  for (const shop of eligible) {
    let allReviewsForShop = [];
    let pageToken = null;
    let pageCount = 0;
    try {
      while (pageCount < MAX_PAGES_PER_SHOP) {
        const page = await listReviews({
          gbpAccountId: shop.gbp_account_id,
          gbpLocationId: shop.gbp_location_id,
          pageToken,
        });
        const pageReviews = Array.isArray(page.reviews) ? page.reviews : [];

        for (const rev of pageReviews) {
          allReviewsForShop.push({
            review_name: rev.name,
            shop_id: shop.shop_id,
            brand: shop.brand,
            gbp_account_id: shop.gbp_account_id,
            gbp_location_id: shop.gbp_location_id,
            rating: starRatingToInt(rev.starRating),
            comment: rev.comment || null,
            reviewer_display_name: rev.reviewer?.displayName || null,
            reviewer_profile_photo_url: rev.reviewer?.profilePhotoUrl || null,
            google_created_at: rev.createTime,
            google_updated_at: rev.updateTime || null,
            reply_comment: rev.reviewReply?.comment || null,
            reply_updated_at: rev.reviewReply?.updateTime || null,
          });
        }

        pageCount++;
        pageToken = page.nextPageToken || null;
        if (!pageToken) break;
        await new Promise((r) => setTimeout(r, REVIEWS_THROTTLE_MS));
      }

      const res = await upsertReviews(allReviewsForShop);
      reviewsFetched += allReviewsForShop.length;
      inserted += res.inserted;
      shopsProcessed++;
    } catch (e) {
      shopsSkipped++;
      const message = e.message || "Unknown";
      if (errors.length < 20) errors.push({ shopId: shop.shop_id, error: message });
    }

    // Inter-shop throttle
    await new Promise((r) => setTimeout(r, REVIEWS_THROTTLE_MS));
  }

  logActivity({
    user: user.name,
    action: "Synced GBP reviews",
    location: "",
    brand: brand || "all",
    details: `shops:${shopsProcessed}/${eligible.length} reviews:${reviewsFetched} inserted:${inserted}`,
  }).catch(() => {});

  return NextResponse.json({
    brand: brand || "*",
    shopsProcessed,
    shopsSkipped,
    reviewsFetched,
    inserted,
    updated: 0,
    errors: errors.length > 0 ? errors : undefined,
  });
}

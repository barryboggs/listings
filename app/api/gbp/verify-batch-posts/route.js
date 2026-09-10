import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { listLocalPosts, getGoogleBpStatus } from "@/lib/google-bp";
import {
  getGbpPostPushes,
  initDatabase,
  logActivity,
} from "@/lib/db";

// Vercel Pro function timeout. Per shop: 1 listLocalPosts GET +
// 250ms throttle ≈ 0.75-1s. Client chunks 30 shops per call so each
// invocation fits well under 60s Pro cap.
export const maxDuration = 90;
const THROTTLE_MS = 250;
const MAX_PER_CALL = 50;

/**
 * POST /api/gbp/verify-batch-posts
 *
 * Admin-only. Cross-checks a bulk-post batch against Google's current
 * state for each shop's GBP profile. Distinguishes shops where the
 * post is genuinely present on Google from shops where our audit says
 * SUCCESS but the post isn't actually there (Google removed it, our
 * write silently dropped, etc.).
 *
 * Only checks rows the batch previously recorded as SUCCESS or REJECTED
 * with a gbp_post_name. FAILED rows are already known-missing — no
 * need to re-check.
 *
 * Request:
 *   { batchId: string, shopIds?: string[] }  // shopIds optional; when
 *                                              omitted, verifies every
 *                                              recorded row in the batch
 *
 * Response:
 *   {
 *     batchId,
 *     total, verified, missing, errored,
 *     results: [
 *       { shopId, gbpPostName, state: "VERIFIED" | "MISSING" | "ERROR",
 *         gbpPostState?, error? },
 *       ...
 *     ],
 *   }
 *
 * `state`:
 *   VERIFIED — GBP returned a post with the same `name` we stored
 *   MISSING  — GBP returned posts but not that one (or an empty list)
 *   ERROR    — the listLocalPosts call itself failed
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
  const batchId = body.batchId;
  const explicitShopIds = Array.isArray(body.shopIds) && body.shopIds.length > 0
    ? new Set(body.shopIds)
    : null;

  if (!batchId) {
    return NextResponse.json({ error: "batchId is required" }, { status: 400 });
  }

  // Pull the batch's audit rows. Filter to rows that (a) were recorded
  // as landed on Google (SUCCESS or REJECTED) and (b) have a
  // gbp_post_name to check against. FAILED rows are already known
  // missing and don't need a Google roundtrip.
  const allRows = await getGbpPostPushes({ batchId, limit: 5000 });
  let candidates = allRows.filter((r) =>
    (r.state === "SUCCESS" || r.state === "REJECTED") &&
    r.gbp_post_name &&
    r.gbp_location_id
  );
  if (explicitShopIds) {
    candidates = candidates.filter((r) => explicitShopIds.has(r.shop_id));
  }

  if (candidates.length === 0) {
    return NextResponse.json({
      batchId,
      total: 0,
      verified: 0,
      missing: 0,
      errored: 0,
      results: [],
      note: "No verifiable rows in this batch — nothing was recorded as landing on Google.",
    });
  }

  // Chunk-friendly: server processes up to MAX_PER_CALL rows per
  // invocation and reports which shop_ids remain for the client to
  // send back on subsequent calls. Client can loop until
  // remainingShopIds is empty.
  const allCandidateShopIds = candidates.map((r) => r.shop_id);
  const processingSlice = candidates.slice(0, MAX_PER_CALL);
  const remainingShopIds = allCandidateShopIds.slice(MAX_PER_CALL);
  candidates = processingSlice;

  const results = [];
  let verified = 0;
  let missing = 0;
  let errored = 0;

  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i];
    try {
      const page = await listLocalPosts({
        gbpAccountId: row.gbp_account_id,
        gbpLocationId: row.gbp_location_id,
      });
      const posts = Array.isArray(page.localPosts) ? page.localPosts : [];
      const match = posts.find((p) => p.name === row.gbp_post_name);
      if (match) {
        verified++;
        results.push({
          shopId: row.shop_id,
          gbpPostName: row.gbp_post_name,
          state: "VERIFIED",
          gbpPostState: match.state || null,
        });
      } else {
        missing++;
        results.push({
          shopId: row.shop_id,
          gbpPostName: row.gbp_post_name,
          state: "MISSING",
          error: `Post not found on GBP (checked ${posts.length} posts on this location)`,
        });
      }
    } catch (err) {
      errored++;
      results.push({
        shopId: row.shop_id,
        gbpPostName: row.gbp_post_name,
        state: "ERROR",
        error: err.message || "listLocalPosts call failed",
      });
    }

    if (i < candidates.length - 1) {
      await new Promise((r) => setTimeout(r, THROTTLE_MS));
    }
  }

  logActivity({
    user: user.name,
    action: "Verified GBP batch posts",
    location: "",
    brand: allRows[0]?.brand || "system",
    details: `batch:${batchId} verified:${verified} missing:${missing} errored:${errored}`,
  }).catch(() => {});

  return NextResponse.json({
    batchId,
    total: candidates.length,
    verified,
    missing,
    errored,
    results,
    // Client loops until this is empty. Empty on the first call
    // means we processed everything in one round.
    remainingShopIds,
  });
}

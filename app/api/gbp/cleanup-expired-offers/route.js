import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { deleteLocalPost, getGoogleBpStatus } from "@/lib/google-bp";
import {
  findExpiredOfferPushes,
  updateGbpPostPushState,
  initDatabase,
  logActivity,
} from "@/lib/db";

// Same throttle pattern as bulk-post. Delete is a single API call per
// row and lands quickly, but stay under 300 QPM at project level.
const DELETE_THROTTLE_MS = 250;

// Vercel Pro function timeout — this route walks up to LIMIT expired
// posts per invocation; 500 rows × ~350ms = ~3 min worst case. We cap
// LIMIT at 500 so a single tick can't blow past maxDuration.
export const maxDuration = 300;
const LIMIT = 500;

/**
 * GET|POST /api/gbp/cleanup-expired-offers
 *
 * Daily cron target: finds OFFER posts whose offer_end_date has passed
 * and deletes each one from Google, then flips the audit row to
 * AUTO_DELETED (or AUTO_DELETE_FAILED with the error message).
 *
 * Auth:
 *   - Vercel Cron: hits with `Authorization: Bearer <CRON_SECRET>` header.
 *     We verify against process.env.CRON_SECRET.
 *   - Admin: signed-in admin session (auth-token cookie). Manual trigger
 *     from the UI or a curl call for testing.
 *   Either path is accepted; both are logged so a leaked CRON_SECRET
 *   would show up in the activity feed.
 *
 * Query params:
 *   ?dry=1                 → find rows and report counts, don't delete
 *   ?before=YYYY-MM-DD     → override "today" for backfill / test runs
 *
 * Response:
 *   {
 *     ranAt: "2026-08-01T08:00:12.345Z",
 *     dryRun: false,
 *     found: 47,           // rows matching the expired-offer filter
 *     deleted: 45,         // GBP DELETE succeeded (or 404 → treated as success)
 *     failed: 2,           // GBP DELETE failed with non-404 error
 *     errors: [{ shopId, gbpPostName, error }],  // first 20 failures
 *     cutoffDate: "2026-08-01"
 *   }
 *
 * Idempotent: rows marked AUTO_DELETED are filtered out on the next run.
 */

function isAuthorized(request, user) {
  if (user && user.role === "admin") return true;
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const secret = process.env.CRON_SECRET;
  return !!(secret && match && match[1] === secret);
}

async function runCleanup(request) {
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry") === "1";
  const beforeDate = url.searchParams.get("before") || null;

  // Determine auth: try admin cookie first, then CRON_SECRET header.
  let user = null;
  const token = request.cookies.get("auth-token")?.value;
  if (token) {
    try { user = await verifyToken(token); } catch {}
  }
  if (!isAuthorized(request, user)) {
    return NextResponse.json(
      { error: "Unauthorized — needs admin auth cookie or CRON_SECRET bearer" },
      { status: 401 }
    );
  }

  await initDatabase();

  const status = await getGoogleBpStatus();
  if (status.state === "no_credentials" || status.state === "not_connected") {
    return NextResponse.json(
      { error: `GBP not ready: ${status.state}` },
      { status: 412 }
    );
  }

  const cutoffDate = beforeDate || new Date().toISOString().slice(0, 10);
  const expired = await findExpiredOfferPushes({ beforeDate: cutoffDate, limit: LIMIT });

  if (dryRun) {
    return NextResponse.json({
      ranAt: new Date().toISOString(),
      dryRun: true,
      found: expired.length,
      deleted: 0,
      failed: 0,
      cutoffDate,
      sampleRows: expired.slice(0, 5).map((r) => ({
        id: r.id,
        shopId: r.shop_id,
        brand: r.brand,
        offerEndDate: r.offer_end_date,
        gbpPostName: r.gbp_post_name,
      })),
    });
  }

  let deleted = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < expired.length; i++) {
    const row = expired[i];
    try {
      await deleteLocalPost(row.gbp_post_name);
      await updateGbpPostPushState(row.id, { state: "AUTO_DELETED", error: null });
      deleted++;
    } catch (e) {
      const message = e.message || "Unknown error";
      // A 404 on delete means the post is already gone (admin deleted
      // manually, or Google removed it for policy). Desired end state
      // achieved — treat as success and mark AUTO_DELETED.
      if (message.includes("404")) {
        await updateGbpPostPushState(row.id, { state: "AUTO_DELETED", error: "Already gone (404)" });
        deleted++;
      } else {
        await updateGbpPostPushState(row.id, { state: "AUTO_DELETE_FAILED", error: message });
        failed++;
        if (errors.length < 20) {
          errors.push({
            shopId: row.shop_id,
            gbpPostName: row.gbp_post_name,
            error: message,
          });
        }
      }
    }

    if (i < expired.length - 1) {
      await new Promise((r) => setTimeout(r, DELETE_THROTTLE_MS));
    }
  }

  logActivity({
    user: user?.name || "cron:cleanup-expired-offers",
    action: "Auto-cleanup expired offers",
    location: "",
    brand: "system",
    details: `cutoff:${cutoffDate} found:${expired.length} deleted:${deleted} failed:${failed}`,
  }).catch((e) => console.error("logActivity (cleanup):", e.message));

  return NextResponse.json({
    ranAt: new Date().toISOString(),
    dryRun: false,
    found: expired.length,
    deleted,
    failed,
    cutoffDate,
    errors: errors.length > 0 ? errors : undefined,
  });
}

export async function GET(request) {
  return runCleanup(request);
}

export async function POST(request) {
  return runCleanup(request);
}

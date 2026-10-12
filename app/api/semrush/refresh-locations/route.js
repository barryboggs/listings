import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getRichStatus } from "@/lib/semrush-rich";
import { refreshLocationsCache } from "@/lib/locations-cache";
import { initDatabase, logActivity, hasPostgres } from "@/lib/db";

// The full Semrush walk is ~60 sequential requests at a 250ms throttle for
// a few thousand shops — roughly 30s today, and it grows with shop count.
// Give it plenty of headroom.
export const maxDuration = 300;

/**
 * GET|POST /api/semrush/refresh-locations
 *
 * Repopulates lm_locations from the Semrush rich API. This is the only thing
 * that pays the ~30s pagination cost; every read path serves from the cache.
 *
 * Auth (either is accepted, matching the cleanup-expired-offers cron):
 *   - Vercel Cron: `Authorization: Bearer <CRON_SECRET>`
 *   - Admin or manager: signed-in session cookie (the "Refresh" button)
 *
 * Scheduled every 2 hours via vercel.json.
 *
 * Response:
 *   {
 *     ranAt, fetched, stored, removed, pruned, durationMs,
 *     existingBefore
 *   }
 *
 * `pruned: false` means the truncation guard fired — Semrush returned
 * noticeably fewer locations than are cached, so stale rows were left alone
 * rather than risk emptying the cache on a partial upstream response.
 */

function isAuthorized(request, user) {
  if (user && ["admin", "manager"].includes(user.role)) return true;
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const secret = process.env.CRON_SECRET;
  return !!(secret && match && match[1] === secret);
}

async function runRefresh(request) {
  let user = null;
  const token = request.cookies.get("auth-token")?.value;
  if (token) {
    try { user = await verifyToken(token); } catch {}
  }
  if (!isAuthorized(request, user)) {
    return NextResponse.json(
      { error: "Unauthorized — needs admin/manager auth cookie or CRON_SECRET bearer" },
      { status: 401 }
    );
  }

  if (!hasPostgres()) {
    return NextResponse.json(
      { error: "No Postgres configured — the locations cache needs a database" },
      { status: 412 }
    );
  }

  const { hasKey } = getRichStatus();
  if (!hasKey) {
    return NextResponse.json(
      { error: "SEMRUSH_API_KEY not configured — nothing to sync from" },
      { status: 412 }
    );
  }

  await initDatabase();

  try {
    const result = await refreshLocationsCache();

    logActivity({
      user: user?.name || "cron",
      action: "Refreshed locations cache",
      location: "",
      brand: "system",
      details: `fetched:${result.fetched} stored:${result.stored} removed:${result.removed} pruned:${result.pruned} in ${Math.round(result.durationMs / 1000)}s`,
    }).catch(() => {});

    return NextResponse.json({ ranAt: new Date().toISOString(), ...result });
  } catch (error) {
    console.error("refresh-locations error:", error.message);
    return NextResponse.json(
      { error: error.message, ranAt: new Date().toISOString() },
      { status: 502 }
    );
  }
}

export async function GET(request) {
  return runRefresh(request);
}

export async function POST(request) {
  return runRefresh(request);
}

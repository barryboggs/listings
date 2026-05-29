import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getTokenStatus, getLocations } from "@/lib/semrush";
import { getRichStatus, getRichLocations } from "@/lib/semrush-rich";

/**
 * GET /api/semrush/token
 *
 * Returns the actual health of both Semrush APIs by actively verifying
 * with a tiny ping call on each request — NOT just reading cached
 * telemetry. Without the ping, per-worker telemetry could drift forever
 * from real state: a worker that hit failures earlier (e.g. before a
 * token recovery) would keep reporting "failing" until it served a
 * Semrush-touching route, while the status endpoint itself never made
 * one. That was the cause of the badge-vs-actual-state disagreement.
 *
 * Each request now fires:
 *   - GET /external/locations?size=1 (old API) — confirms refresh works
 *   - GET /locations?limit=1 (rich API)        — confirms API key works
 *
 * Both run in parallel, errors are swallowed (the underlying fetch
 * helpers update lastSuccessAt / lastErrorAt either way). Adds ~150ms
 * to status checks; eliminates the per-worker drift entirely.
 *
 * ?skipPing=1 short-circuits the verification and returns only cached
 * telemetry — used by diagnostic flows that want to see what telemetry
 * looks like right now, without triggering a refresh attempt.
 *
 * Response:
 *   {
 *     oldApi: { hasToken, state: "no_token"|"healthy"|"failing"|"untested",
 *               lastSuccessAt, lastErrorAt, lastErrorMessage, isExpired },
 *     richApi: { hasKey, state, lastSuccessAt, lastErrorAt, lastErrorMessage },
 *     mode: "live" | "demo"  // legacy alias for the dashboard badge
 *   }
 *
 * `mode` stays for backwards compat with any callers expecting the old
 * shape; new consumers should read `state` per API.
 */
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await verifyToken(token);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const skipPing = new URL(request.url).searchParams.get("skipPing") === "1";

  if (!skipPing) {
    // Snapshot configuration before pinging so we only call APIs that
    // are actually configured. The pings themselves update telemetry
    // via semrushFetch / richFetch's recordSuccess / recordError.
    const preOld = getTokenStatus();
    const preRich = getRichStatus();

    const pings = [];
    if (preOld.hasToken) {
      pings.push(getLocations({ page: 1, size: 1 }).catch(() => {}));
    }
    if (preRich.hasKey) {
      pings.push(getRichLocations({ offset: 0, limit: 1 }).catch(() => {}));
    }
    if (pings.length > 0) await Promise.all(pings);
  }

  const oldApi = getTokenStatus();
  const richApi = getRichStatus();

  // Legacy mode field — true if the deprecated API is configured at all.
  // The badge in app/dashboard/layout.js uses the new `state` field but
  // keeping `mode` avoids breaking any future callers.
  const mode = oldApi.hasToken ? "live" : "demo";

  return NextResponse.json({ oldApi, richApi, mode });
}

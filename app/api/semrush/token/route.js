import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getTokenStatus } from "@/lib/semrush";
import { getRichStatus } from "@/lib/semrush-rich";

/**
 * GET /api/semrush/token
 *
 * Returns the actual health of both Semrush APIs — not just whether
 * credentials are configured. Pre-Phase 4 this only checked `hasToken`,
 * which let an expired token silently fail behind a green badge.
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

  const oldApi = getTokenStatus();
  const richApi = getRichStatus();

  // Legacy mode field — true if the deprecated API is configured at all.
  // The badge in app/dashboard/layout.js uses the new `state` field but
  // keeping `mode` avoids breaking any future callers.
  const mode = oldApi.hasToken ? "live" : "demo";

  return NextResponse.json({ oldApi, richApi, mode });
}

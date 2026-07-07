import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getRichStatus, getRichLocations } from "@/lib/semrush-rich";

/**
 * GET /api/semrush/token
 *
 * Post-migration, this app only talks to the rich API (Apikey auth). No
 * OAuth token / refresh chain to babysit. This route now returns just the
 * rich API's live health.
 *
 * Each request fires a tiny ping (`GET /locations?limit=1`) so the badge
 * reflects current truth rather than per-worker cached state. `?skipPing=1`
 * returns the cached telemetry without triggering a call — useful for
 * diagnostic flows.
 *
 * Response shape is preserved for legacy callers (`oldApi` still present,
 * always `no_token`) so the dashboard layout's ApiHealthBadge continues
 * to read the same fields; the badge itself is updated to prefer richApi.
 */
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const skipPing = new URL(request.url).searchParams.get("skipPing") === "1";

  if (!skipPing) {
    const preRich = getRichStatus();
    if (preRich.hasKey) {
      await getRichLocations({ offset: 0, limit: 1 }).catch(() => {});
    }
  }

  const richApi = getRichStatus();

  // Legacy compatibility — the old API no longer exists as a live provider
  // in this app. Callers reading `mode` should read `richApi.state` instead.
  const oldApi = {
    hasToken: false,
    state: "no_token",
    expiresAt: null,
    isExpired: false,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
  };
  const mode = richApi.hasKey ? "live" : "demo";

  return NextResponse.json({ oldApi, richApi, mode });
}

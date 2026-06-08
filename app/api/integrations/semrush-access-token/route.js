import { NextResponse } from "next/server";
import { getTokenStatus, refreshAccessToken, getAccessToken } from "@/lib/semrush";
import { verifyIntegrationSecret, logActivity } from "@/lib/db";

/**
 * GET /api/integrations/semrush-access-token
 *
 * Token-broker endpoint for external apps (e.g. a coworker's local
 * script) that need to call Semrush directly without owning the
 * refresh-token chain. We refresh proactively if needed, return the
 * current access token, and never expose the refresh token.
 *
 * Auth:
 *   Authorization: Bearer <INTEGRATION_TOKEN_BROKER_SECRET>
 *   The plaintext secret is bcrypt-verified against lm_integration_secrets.
 *   Admin generates / rotates the secret on /dashboard/admin.
 *
 * Response (200):
 *   {
 *     access_token: "...",
 *     expires_at: "2026-06-08T19:37:51.018Z",
 *     expires_in_seconds: 3580
 *   }
 *
 * Errors:
 *   401 — missing / invalid bearer secret
 *   503 — Semrush credentials not configured on this side
 *   502 — refresh attempt failed
 *
 * Audit: each successful access is logged to lm_activity (action
 * "Token broker access") so unusual patterns are visible on the
 * Activity Log page. A leaked secret will show as a spike there.
 */

// If the access token has less than this many seconds remaining when
// we're called, proactively refresh so the caller gets a token they
// can use for the full hour without immediate re-refresh.
const REFRESH_HEADROOM_SECONDS = 300; // 5 min

function extractBearer(request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function GET(request) {
  const presented = extractBearer(request);
  if (!presented) {
    return NextResponse.json({ error: "Missing Authorization: Bearer <secret>" }, { status: 401 });
  }

  // Verify against DB-stored hash. Don't reveal whether the secret is
  // wrong vs. not configured — both surface as 401.
  let ok = false;
  try {
    ok = await verifyIntegrationSecret("semrush", presented);
  } catch (e) {
    console.error("[token-broker] verify error:", e.message);
  }
  if (!ok) {
    return NextResponse.json({ error: "Invalid integration secret" }, { status: 401 });
  }

  // Make sure we actually have Semrush credentials to broker.
  let status = getTokenStatus();
  if (!status.hasToken) {
    return NextResponse.json(
      { error: "Semrush credentials not configured on the broker side. Admin should run the recovery flow." },
      { status: 503 }
    );
  }

  // Proactive refresh if the access token is expired or expiring soon.
  // We want the caller to get something useful for at least a few minutes.
  const now = Date.now();
  const expiresAtMs = status.expiresAt ? new Date(status.expiresAt).getTime() : 0;
  const remainingSeconds = expiresAtMs ? Math.floor((expiresAtMs - now) / 1000) : -1;

  if (remainingSeconds < REFRESH_HEADROOM_SECONDS) {
    try {
      await refreshAccessToken();
      // Re-read status now that the refresh has updated the cache.
      status = getTokenStatus();
    } catch (e) {
      return NextResponse.json(
        {
          error: `Refresh attempt failed: ${e.message}. Admin should run the recovery flow.`,
        },
        { status: 502 }
      );
    }
  }

  // semrush.js's tokenCache is module-scope; getTokenStatus exposes
  // expiresAt but not the access token itself. getAccessToken() is the
  // sanctioned bridge (tokenCache itself isn't exported).
  const accessToken = getAccessToken();
  if (!accessToken) {
    return NextResponse.json(
      { error: "Access token unexpectedly empty after refresh" },
      { status: 502 }
    );
  }

  // Recompute expires_at after any refresh.
  const finalExpiresAt = status.expiresAt;
  const finalRemainingSeconds = finalExpiresAt
    ? Math.max(0, Math.floor((new Date(finalExpiresAt).getTime() - Date.now()) / 1000))
    : null;

  // Fire-and-forget audit log. Don't block the response if it fails.
  logActivity({
    user: "integration:semrush-broker",
    action: "Token broker access",
    location: "",
    brand: "system",
    details: `Returned access token with ${finalRemainingSeconds ?? "?"}s remaining`,
  }).catch((e) => console.error("[token-broker] activity log failed:", e.message));

  return NextResponse.json({
    access_token: accessToken,
    expires_at: finalExpiresAt,
    expires_in_seconds: finalRemainingSeconds,
  });
}

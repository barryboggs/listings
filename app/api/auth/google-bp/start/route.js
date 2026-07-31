import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { isGoogleBpConfigured, buildAuthorizationUrl } from "@/lib/google-bp";

/**
 * GET /api/auth/google-bp/start
 *
 * Admin-only. Builds Google's consent-screen URL with our client_id +
 * business.manage scope, sets a short-lived state cookie for CSRF, and
 * 302s the browser to Google. The user approves there; Google sends them
 * back to /api/auth/google-bp/callback with a `code` query param.
 *
 * Phase 0 behavior: if GOOGLE_BP_CLIENT_ID/SECRET aren't set yet, returns
 * a clear 503 so the admin UI can show "OAuth not configured" instead of
 * a cryptic error.
 */
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  if (!isGoogleBpConfigured()) {
    return NextResponse.json(
      {
        error: "Google Business Profile OAuth is not configured",
        message: "Set GOOGLE_BP_CLIENT_ID and GOOGLE_BP_CLIENT_SECRET in env, then redeploy.",
      },
      { status: 503 }
    );
  }

  // CSRF state — random + tied to a short-lived cookie. Callback verifies match.
  const state = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const requestOrigin = new URL(request.url).origin;
  const authUrl = buildAuthorizationUrl({ state, requestOrigin });

  // Diagnostic branch — hit /api/auth/google-bp/start?debug=1 to see the
  // constructed URL + resolved redirect_uri as JSON instead of redirecting.
  // Client IDs are safe to expose (they appear in every OAuth flow anyway),
  // so this helps debug redirect_uri and scope mismatches without leaking
  // anything the browser wouldn't already see.
  const wantDebug = new URL(request.url).searchParams.get("debug") === "1";
  if (wantDebug) {
    const parsed = new URL(authUrl);
    const params = Object.fromEntries(parsed.searchParams.entries());
    return NextResponse.json({
      requestOrigin,
      authUrl,
      params,
      clientIdConfigured: !!process.env.GOOGLE_BP_CLIENT_ID,
      clientSecretConfigured: !!process.env.GOOGLE_BP_CLIENT_SECRET,
      envRedirectUriOverride: process.env.GOOGLE_BP_REDIRECT_URI || null,
    });
  }

  const res = NextResponse.redirect(authUrl);
  res.cookies.set("gbp-oauth-state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600, // 10 minutes
    path: "/",
  });
  return res;
}

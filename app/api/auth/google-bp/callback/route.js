import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { isGoogleBpConfigured, exchangeCodeForTokens } from "@/lib/google-bp";

/**
 * GET /api/auth/google-bp/callback
 *
 * Google sends the user back here after consent with ?code=... &state=...
 * (or ?error=... if they denied). We verify the state cookie, exchange the
 * code for access+refresh tokens, persist them via setTokens(), and
 * redirect the admin to a landing page.
 *
 * Phase 0 caveat: same 503 surface as /start when env vars aren't set, in
 * case someone hits this URL directly without OAuth configured.
 */
export async function GET(request) {
  // Auth gate — same admin requirement as /start; protects against an
  // attacker tricking a non-admin into completing the flow.
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  if (!isGoogleBpConfigured()) {
    return NextResponse.json(
      { error: "Google Business Profile OAuth is not configured" },
      { status: 503 }
    );
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    // User denied consent or Google rejected the request.
    return NextResponse.redirect(new URL(`/dashboard/admin?gbp_error=${encodeURIComponent(errorParam)}`, url.origin));
  }

  if (!code) {
    return NextResponse.json({ error: "Missing authorization code" }, { status: 400 });
  }

  // Verify CSRF state matches the cookie set by /start.
  const expectedState = request.cookies.get("gbp-oauth-state")?.value;
  if (!expectedState || expectedState !== state) {
    return NextResponse.json(
      { error: "OAuth state mismatch — possible CSRF, or the consent took longer than 10 minutes. Retry from /api/auth/google-bp/start." },
      { status: 400 }
    );
  }

  try {
    const result = await exchangeCodeForTokens(code, { requestOrigin: url.origin });
    const redirect = NextResponse.redirect(
      new URL(`/dashboard/admin?gbp_connected=1&refresh=${result.hasRefreshToken ? "yes" : "no"}`, url.origin)
    );
    redirect.cookies.delete("gbp-oauth-state");
    return redirect;
  } catch (e) {
    return NextResponse.json(
      { error: e.message },
      { status: 502 }
    );
  }
}

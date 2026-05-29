import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { setTokensAndPersist, getTokenStatus } from "@/lib/semrush";
import { getOauthTokenMeta, clearOauthTokens } from "@/lib/db";

/**
 * Admin token-management for the Semrush OAuth pair.
 *
 * Why this exists: Semrush rotates refresh_tokens on use, so the env-var
 * refresh_token is invalidated the moment the first successful refresh
 * happens (the new one lives only in `lm_oauth_tokens`). If those rotated
 * tokens get into a bad state — wrong scope, revoked manually in Semrush,
 * etc. — admins need a way to reset or replace them without redeploying.
 *
 *   GET    → inspect what's stored (never returns the secret values)
 *   POST   → push a fresh token pair (e.g. after running scripts/get-semrush-token.mjs)
 *   DELETE → wipe the row so the next API call re-bootstraps from env vars
 */

async function requireAdmin(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const user = await verifyToken(token);
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (user.role !== "admin") {
    return { error: NextResponse.json({ error: "Admin access required" }, { status: 403 }) };
  }
  return { user };
}

export async function GET(request) {
  const { error } = await requireAdmin(request);
  if (error) return error;

  const stored = await getOauthTokenMeta();
  const live = getTokenStatus();

  return NextResponse.json({
    stored,
    live: {
      hasToken: live.hasToken,
      expiresAt: live.expiresAt,
      isExpired: live.isExpired,
      state: live.state,
      lastSuccessAt: live.lastSuccessAt,
      lastErrorAt: live.lastErrorAt,
      lastErrorMessage: live.lastErrorMessage,
    },
  });
}

export async function POST(request) {
  const { error } = await requireAdmin(request);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Defensive trim — accidental whitespace from copy-paste of OAuth-
  // script output has historically silently broken stored credentials.
  const accessToken = (body.accessToken || body.access_token || "").trim();
  const rawRefresh = body.refreshToken || body.refresh_token;
  const refreshToken = rawRefresh ? String(rawRefresh).trim() : null;
  const expiresIn = body.expiresIn || body.expires_in || null;

  if (!accessToken) {
    return NextResponse.json(
      { error: "accessToken is required (paste from scripts/get-semrush-token.mjs output)" },
      { status: 400 }
    );
  }

  // AWAIT the DB write so a silent failure surfaces here instead of
  // leaving the admin with a misleading 200 OK while DB still holds the
  // previous (broken) tokens. This was the root cause of the recurring
  // "tokens recovered, then broke again two days later" pattern — the
  // worker that handled the POST cached the new tokens fine, but the DB
  // persist failed silently and every cold start after that read the
  // old tokens from DB.
  const persisted = await setTokensAndPersist({ accessToken, refreshToken, expiresIn });
  if (!persisted) {
    return NextResponse.json(
      {
        success: false,
        error: "Tokens accepted in memory but DB write failed. They will be lost on the next cold start. Check Postgres connectivity and that lm_oauth_tokens exists (run POST /api/db once if not).",
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    success: true,
    stored: await getOauthTokenMeta(),
  });
}

export async function DELETE(request) {
  const { error } = await requireAdmin(request);
  if (error) return error;

  const ok = await clearOauthTokens();
  return NextResponse.json({
    success: ok,
    message: ok
      ? "Tokens cleared. Next API call will re-bootstrap from SEMRUSH_BEARER_TOKEN env vars."
      : "Clear failed — no Postgres connection, or DB error (see server logs).",
  });
}

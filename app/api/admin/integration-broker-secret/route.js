import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { randomBytes } from "crypto";
import {
  setIntegrationSecret,
  getIntegrationSecretMeta,
  clearIntegrationSecret,
  logActivity,
} from "@/lib/db";

/**
 * Admin endpoints to manage the integration token-broker secret.
 *
 *   GET    → inspect current secret presence + last-used timestamp
 *            (never returns the plaintext)
 *   POST   → generate a new 48-char URL-safe random secret, hash it
 *            into lm_integration_secrets, return the PLAINTEXT ONCE
 *            so the admin can copy + share via secure channel. Once
 *            this response is closed, the plaintext is unrecoverable.
 *   DELETE → wipe the secret (revoke broker access).
 *
 * Always replaces — there's only one secret per provider at a time.
 * Rotation = POST again, which immediately invalidates the old secret.
 */

const PROVIDER = "semrush";

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
  const meta = await getIntegrationSecretMeta(PROVIDER);
  return NextResponse.json(meta);
}

export async function POST(request) {
  const { error, user } = await requireAdmin(request);
  if (error) return error;

  // 48 random URL-safe chars: 36 bytes → base64url → 48 chars. Plenty
  // of entropy; short enough to copy comfortably.
  const plaintext = randomBytes(36)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const ok = await setIntegrationSecret(PROVIDER, plaintext, user.name);
  if (!ok) {
    return NextResponse.json(
      { error: "Failed to store the new secret. Check Postgres connectivity / lm_integration_secrets table exists (run POST /api/db once if not)." },
      { status: 502 }
    );
  }

  await logActivity({
    user: user.name,
    action: "Rotated integration broker secret",
    location: "",
    brand: "system",
    details: `Provider: ${PROVIDER}. Previous secret (if any) is immediately invalid.`,
  }).catch(() => {});

  // Return the PLAINTEXT — shown to the admin once, never recoverable.
  // The hash is what we'll verify against on future broker calls.
  const meta = await getIntegrationSecretMeta(PROVIDER);
  return NextResponse.json({
    success: true,
    plaintext,
    warning: "Save this secret now. It will not be shown again. Anyone with it can fetch your Semrush access token until revoked.",
    meta,
  });
}

export async function DELETE(request) {
  const { error, user } = await requireAdmin(request);
  if (error) return error;
  const ok = await clearIntegrationSecret(PROVIDER);
  if (ok) {
    await logActivity({
      user: user.name,
      action: "Revoked integration broker secret",
      location: "",
      brand: "system",
      details: `Provider: ${PROVIDER}. Broker endpoint will return 401 until a new secret is generated.`,
    }).catch(() => {});
  }
  return NextResponse.json({ success: ok });
}

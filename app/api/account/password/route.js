import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getUserAuthFields, updateOwnPassword, logActivity, initDatabase } from "@/lib/db";

/**
 * PATCH /api/account/password
 *
 * Self-service password change for the currently logged-in user.
 *
 * Body: { currentPassword?: string, newPassword: string }
 *
 * - currentPassword is REQUIRED for voluntary changes (password_temp = false).
 * - currentPassword is OPTIONAL when password_temp = true (the user just
 *   logged in with the temp password — re-asking is friction, not security).
 *
 * Sets password_temp = false on success so the user is no longer forced to
 * change it.
 */
export async function PATCH(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { currentPassword, newPassword } = body;

  if (!newPassword || typeof newPassword !== "string" || newPassword.length < 6) {
    return NextResponse.json(
      { error: "New password must be at least 6 characters" },
      { status: 400 }
    );
  }

  // Ensure password_temp column exists before reading or writing it.
  await initDatabase();

  // Pull the live auth fields — we need the current stored password to
  // verify, and the password_temp flag to decide whether to require it.
  const fields = await getUserAuthFields(user.id);
  if (!fields) {
    return NextResponse.json({ error: "Account record not found" }, { status: 404 });
  }

  // Voluntary change: must provide and match the current password.
  // Forced change (password_temp = true): the user just authenticated with
  // the temp password, so we skip re-asking.
  if (!fields.password_temp) {
    if (!currentPassword) {
      return NextResponse.json(
        { error: "Current password is required" },
        { status: 400 }
      );
    }
    if (currentPassword !== fields.password) {
      return NextResponse.json(
        { error: "Current password is incorrect" },
        { status: 401 }
      );
    }
  }

  if (newPassword === fields.password) {
    return NextResponse.json(
      { error: "New password must be different from the current password" },
      { status: 400 }
    );
  }

  try {
    await updateOwnPassword(user.id, newPassword);
    await logActivity({
      user: user.name,
      action: fields.password_temp ? "Set initial password" : "Changed password",
      location: "",
      brand: "system",
      details: "Self-service password change",
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error.message || "Failed to update password" },
      { status: 500 }
    );
  }
}

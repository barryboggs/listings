import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getUserAuthFields } from "@/lib/db";

export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;

  if (!token) {
    return NextResponse.json({ user: null }, { status: 401 });
  }

  const payload = await verifyToken(token);
  if (!payload) {
    return NextResponse.json({ user: null }, { status: 401 });
  }

  // Fetch live password_temp flag from DB — the JWT can't carry it
  // because it changes during a session (admin reset or self-change).
  // The dashboard layout reads this on every mount to decide whether
  // to redirect to the forced-change screen.
  let passwordTemp = false;
  try {
    const fields = await getUserAuthFields(payload.id);
    if (fields) passwordTemp = !!fields.password_temp;
  } catch {
    // If the lookup fails (e.g. demo mode with no Postgres), default to
    // false — demo users aren't subject to forced password change.
  }

  return NextResponse.json({
    user: {
      id: payload.id,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      initials: payload.initials,
      brands: payload.brands,
      passwordTemp,
    },
  });
}

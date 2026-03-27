import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getTokenStatus } from "@/lib/semrush";

export async function GET(request) {
  // Verify auth
  const token = request.cookies.get("auth-token")?.value;
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await verifyToken(token);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = getTokenStatus();

  return NextResponse.json({
    connected: status.hasToken,
    expiresAt: status.expiresAt,
    isExpired: status.isExpired,
    mode: status.hasToken ? "live" : "demo",
  });
}

import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getActivity, logActivity, clearActivity } from "@/lib/db";

export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const activity = await getActivity(200);
  return NextResponse.json({ activity });
}

export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const entry = await logActivity({
    user: user.name,
    action: body.action || "Updated location",
    location: body.location || "",
    brand: body.brand || "unknown",
    details: body.details || "",
  });

  return NextResponse.json({ entry });
}

// DELETE - clear all activity (admin only)
export async function DELETE(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || user.role !== "admin") return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  await clearActivity();
  await logActivity({
    user: user.name,
    action: "Cleared activity log",
    location: "",
    brand: "system",
    details: "All previous entries removed",
  });

  return NextResponse.json({ success: true });
}

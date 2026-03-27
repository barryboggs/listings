import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { updateLocation, getTokenStatus, toSemrushFormat } from "@/lib/semrush";

export async function PUT(request, { params }) {
  // Verify auth
  const token = request.cookies.get("auth-token")?.value;
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await verifyToken(token);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check role permissions
  if (user.role === "viewer") {
    return NextResponse.json({ error: "Viewers cannot edit locations" }, { status: 403 });
  }

  const locationId = params.id;
  const body = await request.json();

  // Check if Semrush API is configured
  const { hasToken } = getTokenStatus();

  if (!hasToken) {
    // Simulate success for demo mode
    return NextResponse.json({
      success: true,
      source: "demo",
      locationId,
      message: "Demo mode — no actual API call made. Set SEMRUSH_BEARER_TOKEN to go live.",
      updatedBy: user.name,
      updatedAt: new Date().toISOString(),
    });
  }

  // Transform our app data to Semrush API format
  const semrushPayload = toSemrushFormat(body);

  try {
    const result = await updateLocation(locationId, semrushPayload);

    return NextResponse.json({
      success: true,
      source: "semrush",
      locationId,
      result,
      updatedBy: user.name,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Semrush update error:", error.message);
    return NextResponse.json(
      {
        success: false,
        error: error.message,
        locationId,
      },
      { status: 502 }
    );
  }
}

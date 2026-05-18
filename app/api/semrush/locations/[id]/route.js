import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getLocation, updateLocation, getTokenStatus, toSemrushFormat } from "@/lib/semrush";

/**
 * GET /api/semrush/locations/[id]?raw=1  (admin-only diagnostic)
 *
 * Returns the unfiltered upstream payload from the deprecated API's
 * GetLocation endpoint. Used to probe whether Semrush exposes fields
 * we don't currently surface through transformLocation — specifically,
 * whether per-publisher/per-directory website URLs (e.g. a separate
 * GBP URL) are reachable via the API.
 *
 * Without ?raw=1 the route is a no-op (no transformed shape is needed
 * here — the locations list already returns transformed data).
 */
export async function GET(request, { params }) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const wantRaw = new URL(request.url).searchParams.get("raw") === "1";
  if (!wantRaw) {
    return NextResponse.json({ error: "Pass ?raw=1 to receive the upstream payload" }, { status: 400 });
  }
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Admin required for raw=1" }, { status: 403 });
  }

  const { hasToken } = getTokenStatus();
  if (!hasToken) {
    return NextResponse.json({ error: "SEMRUSH_BEARER_TOKEN not configured" }, { status: 412 });
  }

  try {
    const raw = await getLocation(params.id);
    return NextResponse.json({ raw });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
}

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

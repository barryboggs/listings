import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { ACTIVITY_LOG as SEED_ACTIVITY } from "@/lib/data";

/**
 * In-memory activity store. Seeded with demo data, then accumulates real actions.
 * For production, replace with a database.
 */
let activityStore = null;

function getActivity() {
  if (!activityStore) {
    activityStore = [...SEED_ACTIVITY];
  }
  return activityStore;
}

// GET - list activity
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({ activity: getActivity() });
}

// POST - log a new activity entry
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const activity = getActivity();

  const entry = {
    id: `act-${Date.now()}`,
    time: new Date().toISOString(),
    user: user.name,
    action: body.action || "Updated location",
    location: body.location || "",
    brand: body.brand || "unknown",
    details: body.details || "",
  };

  // Prepend so newest is first
  activityStore.unshift(entry);

  // Keep last 200 entries
  if (activityStore.length > 200) {
    activityStore = activityStore.slice(0, 200);
  }

  return NextResponse.json({ entry });
}

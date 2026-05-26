import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import {
  getPendingPushes,
  markPushesDoneByLocation,
  markAllPushesDone,
} from "@/lib/db";

/**
 * GET /api/pending-pushes?brand=<id>&includeDone=true
 *
 * Lists shops we've pushed to that the user likely still needs to handle
 * in Semrush's Updates queue. Default: open (not-yet-marked-done) only.
 * Each row carries semrush_new_id from the join so the client can build
 * the deep link: /gbp-optimization/location/{new_id}/updates/?type=DIFF&status=NEW
 *
 * Rows for the same location are returned individually (one per push event).
 * Clients typically dedupe by semrush_location_id and display per-shop.
 */
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const brand = url.searchParams.get("brand") || null;
  const includeDone = url.searchParams.get("includeDone") === "true";

  const rows = await getPendingPushes({
    markedDone: includeDone,
    brand,
    limit: 2000,
  });

  return NextResponse.json({ rows, count: rows.length });
}

/**
 * PATCH /api/pending-pushes
 *
 * Body shapes:
 *   { action: "mark_done", semrushLocationId }  — mark all open pushes for one shop
 *   { action: "mark_all_done", brand? }         — mark every open push (optionally one brand)
 */
export async function PATCH(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "viewer") {
    return NextResponse.json({ error: "Viewers cannot modify the queue" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));

  if (body.action === "mark_done") {
    if (!body.semrushLocationId) {
      return NextResponse.json({ error: "semrushLocationId required" }, { status: 400 });
    }
    const count = await markPushesDoneByLocation(body.semrushLocationId);
    return NextResponse.json({ success: true, marked: count });
  }

  if (body.action === "mark_all_done") {
    const count = await markAllPushesDone({ brand: body.brand || null });
    return NextResponse.json({ success: true, marked: count });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

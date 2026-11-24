import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getShopNumbers } from "@/lib/db";
import { getGoogleBpStatus } from "@/lib/google-bp";
import { parseHolidayCsv } from "@/lib/holiday-csv";

/**
 * POST - Parse a holiday-hours CSV and match its Franchise IDs to shops
 * with a Google Business Profile mapping. Preview only; nothing is written.
 * The client pushes the returned `updates` in chunks via /api/gbp/holiday-push.
 *
 * Same CSV as the Semrush import (Franchise ID, Holiday, Holiday Open,
 * Holiday Close [, Holiday 2, ...]). Additionally, Open or Close of
 * "REMOVE" takes that date off the profile.
 *
 * Body: { csvData }
 * Response: { total, matched, unmatched, unmatchedIds, noGbp, noGbpIds,
 *             closed, specialHours, removals, holiday2Count,
 *             updates: [{ shopId, brand, street, city, state, holidayHours }],
 *             preview: first 20 of updates, gbp: { state } }
 */
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["admin", "manager"].includes(user.role)) {
    return NextResponse.json({ error: "Only admins and managers can import GBP holiday hours" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  if (!body.csvData) return NextResponse.json({ error: "csvData is required" }, { status: 400 });

  let parsed;
  try {
    parsed = parseHolidayCsv(body.csvData, { allowRemove: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }

  const allShops = await getShopNumbers();
  const shopById = new Map(allShops.map((s) => [String(s.shop_id), s]));

  const out = {
    total: parsed.rows,
    matched: 0,
    unmatched: 0,
    unmatchedIds: [],
    noGbp: 0,
    noGbpIds: [],
    closed: parsed.closed,
    specialHours: parsed.specialHours,
    removals: parsed.removals,
    holiday2Count: parsed.holiday2Count,
    updates: [],
  };

  for (const [shopId, entries] of parsed.byShop) {
    const shop = shopById.get(shopId);
    if (!shop) {
      out.unmatched++;
      if (out.unmatchedIds.length < 50) out.unmatchedIds.push(shopId);
      continue;
    }
    if (!shop.gbp_location_id) {
      out.noGbp++;
      if (out.noGbpIds.length < 50) out.noGbpIds.push(shopId);
      continue;
    }
    if (entries.length === 0) continue;
    out.matched++;
    out.updates.push({
      shopId,
      brand: shop.brand,
      street: shop.street_address || "",
      city: shop.city || "",
      state: shop.state || "",
      holidayHours: entries,
    });
  }

  const gbp = await getGoogleBpStatus().catch((e) => ({ state: "error", error: e.message }));

  return NextResponse.json({
    ...out,
    preview: out.updates.slice(0, 20),
    gbp: { state: gbp.state },
  });
}

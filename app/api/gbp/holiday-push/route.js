import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import {
  getGbpSpecialHours,
  updateGbpSpecialHours,
  getGoogleBpStatus,
} from "@/lib/google-bp";
import { mergeSpecialHours } from "@/lib/gbp-hours";
import {
  getShopNumbers,
  recordGbpHoursPush,
  getGbpHoursPushes,
  getGbpHoursBatches,
  initDatabase,
  logActivity,
} from "@/lib/db";

// Two Google calls per shop (read current special hours, write merged
// list) at ~400-800ms each plus the throttle: a 50-shop chunk is ~60s in
// the worst case, so the loop stops starting shops at TIME_BUDGET_MS and
// hands the rest back — same pattern as /api/gbp/bulk-post.
export const maxDuration = 90;
const THROTTLE_MS = 250;
const TIME_BUDGET_MS = 60_000;

/**
 * POST - Apply one chunk of a holiday-hours import directly to Google
 * Business Profile (no Semrush involvement).
 *
 * Body: { batchId, updates: [{ shopId, holidayHours: [entry] }] }
 *   entry: { type: "CLOSED" | "RANGE" | "OPENED_ALL_DAY" | "REMOVE", day, times? }
 *
 * Per shop: read the profile's current specialHourPeriods, drop any period
 * covering a date in the CSV, add the CSV's hours for those dates, and
 * write the list back with updateMask=specialHours. Dates not in the CSV
 * are untouched. Shops whose list would not change are reported UNCHANGED
 * and not written. Every shop gets an audit row with before/after.
 *
 * Response: { pushed, unchanged, pushErrors, skipped, errors: [{shopId, error}],
 *             results: [{ shopId, state, before, after, error? }],
 *             remainingShopIds? }  // shops not attempted: time budget ran out
 */
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["admin", "manager"].includes(user.role)) {
    return NextResponse.json({ error: "Only admins and managers can push holiday hours to GBP" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const { batchId, updates } = body;
  if (!batchId || !Array.isArray(updates) || updates.length === 0) {
    return NextResponse.json({ error: "batchId and a non-empty updates array are required" }, { status: 400 });
  }
  if (updates.length > 50) {
    return NextResponse.json({ error: `Max 50 updates per call (got ${updates.length}); chunk on the client` }, { status: 400 });
  }
  for (const u of updates) {
    if (!u?.shopId || !Array.isArray(u.holidayHours) || u.holidayHours.length === 0) {
      return NextResponse.json({ error: "Each update needs shopId and a non-empty holidayHours array" }, { status: 400 });
    }
  }

  const status = await getGoogleBpStatus();
  if (status.state === "no_credentials" || status.state === "not_connected") {
    return NextResponse.json(
      { error: `GBP not ready: ${status.state}`, hint: "Visit /api/auth/google-bp/start" },
      { status: 412 }
    );
  }

  await initDatabase();

  const allShops = await getShopNumbers();
  const shopById = new Map(allShops.map((s) => [String(s.shop_id), s]));

  const results = [];
  const errors = [];
  const remainingShopIds = [];
  let pushed = 0;
  let unchanged = 0;
  let pushErrors = 0;
  let skipped = 0;
  const startedAt = Date.now();

  for (let i = 0; i < updates.length; i++) {
    const update = updates[i];
    const shopId = String(update.shopId);

    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      for (const u of updates.slice(i)) remainingShopIds.push(String(u.shopId));
      break;
    }

    const shop = shopById.get(shopId);
    if (!shop) {
      skipped++;
      results.push({ shopId, state: "SKIPPED", error: "Shop ID not in the Shop Numbers database" });
      continue;
    }
    if (!shop.gbp_location_id) {
      skipped++;
      results.push({ shopId, state: "SKIPPED", error: "No GBP mapping — run the GBP mapping sync on /dashboard/admin" });
      continue;
    }

    let before = null;
    try {
      before = await getGbpSpecialHours(shop.gbp_location_id);
      const { periods, changed } = mergeSpecialHours(before, update.holidayHours);

      if (!changed) {
        unchanged++;
        results.push({ shopId, state: "UNCHANGED", before, after: before });
        await recordGbpHoursPush({
          batchId, shopId, brand: shop.brand, gbpLocationId: shop.gbp_location_id,
          entries: update.holidayHours, before, after: null, state: "UNCHANGED", pushedBy: user.name,
        });
      } else {
        await new Promise((r) => setTimeout(r, THROTTLE_MS));
        await updateGbpSpecialHours(shop.gbp_location_id, periods);
        pushed++;
        results.push({ shopId, state: "SUCCESS", before, after: periods });
        await recordGbpHoursPush({
          batchId, shopId, brand: shop.brand, gbpLocationId: shop.gbp_location_id,
          entries: update.holidayHours, before, after: periods, state: "SUCCESS", pushedBy: user.name,
        });
      }
    } catch (err) {
      pushErrors++;
      const message = err.message || "Unknown error";
      results.push({ shopId, state: "FAILED", before, error: message });
      errors.push({ shopId, error: message });
      await recordGbpHoursPush({
        batchId, shopId, brand: shop.brand, gbpLocationId: shop.gbp_location_id,
        entries: update.holidayHours, before, after: null, state: "FAILED", error: message, pushedBy: user.name,
      });
    }

    if (i < updates.length - 1) {
      await new Promise((r) => setTimeout(r, THROTTLE_MS));
    }
  }

  const brands = [...new Set(results.map((r) => shopById.get(r.shopId)?.brand).filter(Boolean))];
  logActivity({
    user: user.name,
    action: "GBP holiday hours import",
    location: `${results.length} shops`,
    brand: brands.length === 1 ? brands[0] : "multi-brand",
    details: `updated:${pushed} unchanged:${unchanged} failed:${pushErrors} skipped:${skipped}${remainingShopIds.length > 0 ? ` deferred:${remainingShopIds.length}` : ""} · batch:${batchId}`,
  }).catch((e) => console.error("logActivity (gbp-holiday-push):", e.message));

  return NextResponse.json({
    batchId,
    pushed,
    unchanged,
    pushErrors,
    skipped,
    errors: errors.length > 0 ? errors : undefined,
    results,
    remainingShopIds: remainingShopIds.length > 0 ? remainingShopIds : undefined,
  });
}

/**
 * GET - Import history. No params: recent batches with counts.
 * ?batchId=<id>: that batch's per-shop rows (with before/after). Any
 * logged-in user can read.
 */
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const batchId = params.get("batchId");
  if (batchId) {
    const rows = await getGbpHoursPushes({ batchId, limit: 5000 });
    return NextResponse.json({
      batchId,
      rows: rows.map((r) => ({
        shopId: r.shop_id,
        brand: r.brand,
        state: r.state,
        entries: r.entries,
        before: r.before,
        after: r.after,
        error: r.error,
        pushedAt: r.pushed_at,
      })),
    });
  }
  const limit = Math.min(Math.max(Number(params.get("limit")) || 25, 1), 200);
  const batches = await getGbpHoursBatches({ limit });
  return NextResponse.json({ batches });
}

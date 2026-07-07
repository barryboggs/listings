import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getAllRichLocations, getRichStatus } from "@/lib/semrush-rich";
import {
  getShopNumbers,
  bulkSetNewIds,
  initDatabase,
  logActivity,
} from "@/lib/db";

/**
 * POST /api/db/sync-rich-mappings
 *
 * Admin-only. Populates lm_shop_numbers.semrush_new_id by matching each
 * shop record to a rich-API location via URL / phone / normalized address.
 *
 * Post-migration this is the ONLY sync — the deprecated old-API-to-new-API
 * cross-reference is gone (the app only speaks to the rich API now).
 * Idempotent; re-run any time. Shops already mapped are re-matched
 * harmlessly.
 *
 * Response: { newCount, shopCount, matched, updated, missing, ambiguous,
 *             strategies: { url, phone, address }, unmatchedShops }
 */
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const richStatus = getRichStatus();
  if (!richStatus.hasKey) {
    return NextResponse.json(
      { error: "SEMRUSH_API_KEY not configured — cannot fetch locations" },
      { status: 412 }
    );
  }

  // Ensure schema is up to date. Adds semrush_new_id / rich_matched_at
  // columns if they're missing (all statements idempotent).
  await initDatabase();

  let richLocations;
  let shops;
  try {
    [richLocations, shops] = await Promise.all([
      getAllRichLocations({ limit: 50 }),
      getShopNumbers(),
    ]);
  } catch (error) {
    return NextResponse.json({ error: `Fetch failed: ${error.message}` }, { status: 502 });
  }

  const newCount = richLocations.length;
  const shopCount = shops.length;

  // Build lookup indexes on the rich locations. Same match-strength ordering
  // as the previous shop matcher: URL beats phone beats address+city.
  const richByUrl = new Map();
  const richByPhone = new Map();
  const richByAddrCity = new Map();
  const ambiguousKeys = new Set();

  for (const r of richLocations) {
    const url = normalizeUrl(r.website_url);
    const phone = normalizePhone(r.phone_number);
    const addrCity = addrCityKey(r.address_line_1, r.city);

    if (url) {
      if (richByUrl.has(url)) ambiguousKeys.add(`url:${url}`);
      else richByUrl.set(url, r);
    }
    if (phone) {
      if (richByPhone.has(phone)) ambiguousKeys.add(`phone:${phone}`);
      else richByPhone.set(phone, r);
    }
    if (addrCity) {
      if (richByAddrCity.has(addrCity)) ambiguousKeys.add(`addr:${addrCity}`);
      else richByAddrCity.set(addrCity, r);
    }
  }

  const matches = [];
  const strategies = { url: 0, phone: 0, address: 0 };
  const unmatchedShops = [];
  let ambiguous = 0;

  for (const shop of shops) {
    const url = normalizeUrl(shop.website);
    const phone = normalizePhone(shop.phone);
    const addrCity = addrCityKey(shop.street_address, shop.city);

    let hit = null;
    let by = null;

    if (url && richByUrl.has(url)) {
      hit = richByUrl.get(url);
      by = "url";
      if (ambiguousKeys.has(`url:${url}`)) ambiguous++;
    } else if (phone && richByPhone.has(phone)) {
      hit = richByPhone.get(phone);
      by = "phone";
      if (ambiguousKeys.has(`phone:${phone}`)) ambiguous++;
    } else if (addrCity && richByAddrCity.has(addrCity)) {
      hit = richByAddrCity.get(addrCity);
      by = "address";
      if (ambiguousKeys.has(`addr:${addrCity}`)) ambiguous++;
    }

    if (hit) {
      // bulkSetNewIds keys by shop's semrush_location_id; but post-migration
      // most shops may not have that populated. Fall back to shop_id-based
      // update for those. We collect both variants and let bulkSetNewIds /
      // downstream logic pick the right update key.
      matches.push({
        oldId: shop.semrush_location_id || null,
        newId: hit.location_id,
        shopId: shop.shop_id,
      });
      strategies[by]++;
    } else {
      if (unmatchedShops.length < 50) {
        unmatchedShops.push({ shopId: shop.shop_id, brand: shop.brand, city: shop.city });
      }
    }
  }

  // bulkSetNewIds updates rows keyed by semrush_location_id (old-API ID).
  // For shops that lack an old-API ID (never had one) we skip DB writes
  // via bulkSetNewIds and use a shop_id-keyed setter instead. The
  // helper below applies whichever key exists.
  const { updated, missing, errors } = await applyRichMatches(matches);

  await logActivity({
    user: user.name,
    action: "Synced rich-field mappings",
    location: "",
    brand: "system",
    details: `${matches.length} matched (url:${strategies.url} phone:${strategies.phone} addr:${strategies.address}); ${updated} shop rows updated, ${missing} matched but no shop row.`,
  });

  return NextResponse.json({
    newCount,
    shopCount,
    matched: matches.length,
    updated,
    missing,
    ambiguous,
    strategies,
    unmatchedShops,
    dbErrors: errors,
  });
}

// GET /api/db/sync-rich-mappings — return sync readiness (no work done)
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({
    richApi: getRichStatus().hasKey,
  });
}

/**
 * Prefer the bulkSetNewIds path (old-API-ID keyed) for shops that have it —
 * that keeps the historical linkage intact. For shops without an old-API
 * ID we can't use bulkSetNewIds, so fall back to a shop_id-keyed update via
 * setNewIdByShopId (added to lib/db.js as part of the migration).
 */
async function applyRichMatches(matches) {
  const oldIdMatches = matches
    .filter((m) => m.oldId)
    .map(({ oldId, newId }) => ({ oldId, newId }));
  const shopIdOnlyMatches = matches.filter((m) => !m.oldId);

  const oldRes = await bulkSetNewIds(oldIdMatches);

  let extraUpdated = 0;
  const extraErrors = [];
  if (shopIdOnlyMatches.length > 0) {
    const { setNewIdByShopId } = await import("@/lib/db");
    for (const { shopId, newId } of shopIdOnlyMatches) {
      try {
        const ok = await setNewIdByShopId(shopId, newId);
        if (ok) extraUpdated++;
      } catch (e) {
        if (extraErrors.length < 3) extraErrors.push(`${shopId}: ${e.message}`);
      }
    }
  }

  return {
    updated: oldRes.updated + extraUpdated,
    missing: oldRes.missing,
    errors: [...oldRes.errors, ...extraErrors],
  };
}

// ---------------------------------------------------------------------------
// Normalization — matches the rules used by the existing shop matcher in
// app/api/shops/route.js so behavior stays consistent across the codebase.
// ---------------------------------------------------------------------------

function normalizeUrl(url) {
  if (!url) return "";
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\?.*$/, "")
    .replace(/\/$/, "")
    .trim();
}

function normalizePhone(phone) {
  if (!phone) return "";
  return phone.toString().replace(/\D/g, "").slice(-10);
}

function addrCityKey(addr, city) {
  const a = (addr || "")
    .toLowerCase()
    .replace(/[.,#]/g, "")
    .replace(
      /\b(street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|lane|ln|court|ct|place|pl|highway|hwy|way)\b/g,
      (m) => {
        const map = {
          street: "st",
          avenue: "ave",
          road: "rd",
          drive: "dr",
          boulevard: "blvd",
          lane: "ln",
          court: "ct",
          place: "pl",
          highway: "hwy",
        };
        return map[m] || m;
      }
    )
    .replace(/\s+/g, " ")
    .trim();
  const c = (city || "").toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
  if (!a || !c) return "";
  return `${a}|${c}`;
}

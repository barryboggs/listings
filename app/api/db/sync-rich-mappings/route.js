import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getAllLocations, getTokenStatus } from "@/lib/semrush";
import { getAllRichLocations, getRichStatus } from "@/lib/semrush-rich";
import { bulkSetNewIds, logActivity } from "@/lib/db";

/**
 * POST /api/db/sync-rich-mappings
 *
 * Admin-only. Pulls every location from both Semrush APIs and matches them
 * by website URL, phone, and address — same strategy as the existing
 * shop-number matching. For each match, writes semrush_new_id onto the
 * shop row keyed by semrush_location_id.
 *
 * Idempotent — re-run any time. Locations already mapped are re-matched
 * harmlessly.
 *
 * Response: { oldCount, newCount, matched, updated, missing, ambiguous,
 *             strategies: { url, phone, address }, unmatchedOld }
 */
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const oldStatus = getTokenStatus();
  const richStatus = getRichStatus();
  if (!oldStatus.hasToken) {
    return NextResponse.json(
      { error: "SEMRUSH_BEARER_TOKEN not configured — cannot fetch old-API locations" },
      { status: 412 }
    );
  }
  if (!richStatus.hasKey) {
    return NextResponse.json(
      { error: "SEMRUSH_API_KEY not configured — cannot fetch new-API locations" },
      { status: 412 }
    );
  }

  let oldLocations;
  let richLocations;
  try {
    [oldLocations, richLocations] = await Promise.all([
      getAllLocations(),
      getAllRichLocations({ limit: 50 }),
    ]);
  } catch (error) {
    return NextResponse.json(
      { error: `Fetch failed: ${error.message}` },
      { status: 502 }
    );
  }

  const oldCount = oldLocations.length;
  const newCount = richLocations.length;

  // Build lookup indexes on the rich (new-API) list. Each key is the strongest
  // available match signal; we look up old locations against each in turn.
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
  const unmatchedOld = [];
  let ambiguous = 0;

  for (const o of oldLocations) {
    const url = normalizeUrl(o.websiteUrl);
    const phone = normalizePhone(o.phone);
    const addrCity = addrCityKey(o.address, o.city);

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
      matches.push({ oldId: o.id, newId: hit.location_id });
      strategies[by]++;
    } else {
      if (unmatchedOld.length < 50) unmatchedOld.push({ id: o.id, name: o.locationName, city: o.city });
    }
  }

  const { updated, missing } = await bulkSetNewIds(matches);

  await logActivity({
    user: user.name,
    action: "Synced rich-field mappings",
    location: "",
    brand: "system",
    details: `${matches.length} matched (url:${strategies.url} phone:${strategies.phone} addr:${strategies.address}); ${updated} shop rows updated, ${missing} matched but no shop row, ${unmatchedOld.length === 50 ? "50+" : oldCount - matches.length} unmatched.`,
  });

  return NextResponse.json({
    oldCount,
    newCount,
    matched: matches.length,
    updated,
    missing,
    ambiguous,
    strategies,
    unmatchedOld,
  });
}

// GET /api/db/sync-rich-mappings — return current sync status (no work done)
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({
    oldApi: getTokenStatus().hasToken,
    richApi: getRichStatus().hasKey,
  });
}

// ---------------------------------------------------------------------------
// Normalization — match the rules used by the existing shop matcher in
// app/api/shops/route.js so behavior stays consistent across the codebase.
// ---------------------------------------------------------------------------

function normalizeUrl(url) {
  if (!url) return "";
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\?.*$/, "") // drop query params (utm_* etc.)
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

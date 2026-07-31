import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { listAccounts, listLocations, getGoogleBpStatus } from "@/lib/google-bp";
import {
  getShopNumbers,
  setGbpMappingByShopId,
  initDatabase,
  logActivity,
} from "@/lib/db";

/**
 * POST /api/db/sync-gbp-mappings
 *
 * Admin-only. Iterates every account the connected Google admin manages,
 * paginates through each account's locations, and matches shops in
 * lm_shop_numbers to GBP locations by URL → phone → address+city
 * (same heuristic order used everywhere else in this app).
 *
 * Writes matches to lm_shop_numbers.gbp_account_id + gbp_location_id via
 * setGbpMappingByShopId. Idempotent — re-run any time; already-mapped
 * shops are re-matched harmlessly.
 *
 * Throttle: 200ms between paginated location-list calls to stay well
 * under GBP's 300 QPM per-project quota.
 *
 * Response shape:
 *   {
 *     accountCount, gbpLocationCount, shopCount,
 *     matched, updated, unmatched,
 *     strategies: { url, phone, address },
 *     perBrand: { [brand]: { total, matched } },
 *     unmatchedShops: [{ shopId, brand, city }],
 *     ambiguous  // count of shops that matched a key with multiple GBP hits
 *   }
 */
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  // Ensure schema is up to date — gbp_* columns and index are added
  // idempotently by initDatabase.
  await initDatabase();

  const status = await getGoogleBpStatus();
  if (status.state === "no_credentials") {
    return NextResponse.json(
      { error: "GOOGLE_BP_CLIENT_ID / GOOGLE_BP_CLIENT_SECRET not configured" },
      { status: 412 }
    );
  }
  if (status.state === "not_connected") {
    return NextResponse.json(
      { error: "Google account not connected — visit /api/auth/google-bp/start first" },
      { status: 412 }
    );
  }

  // Fetch shops + GBP locations in parallel. Shops are DB-only (fast);
  // GBP is remote-paginated (potentially many calls) — running them
  // together saves total wall time.
  const throttle = 200;
  let accountsResult, shops;
  try {
    [accountsResult, shops] = await Promise.all([
      listAccounts(),
      getShopNumbers(),
    ]);
  } catch (e) {
    return NextResponse.json({ error: `Fetch failed: ${e.message}` }, { status: 502 });
  }

  const accounts = Array.isArray(accountsResult?.accounts) ? accountsResult.accounts : [];
  if (accounts.length === 0) {
    return NextResponse.json({
      error: "Connected Google account manages 0 GBP accounts",
      hint: "Confirm you connected with the Google account that actually manages the Driven Brands GBP profiles.",
    }, { status: 412 });
  }

  // Collect every location across every account. Each entry carries its
  // parent account so we can write both gbp_account_id and gbp_location_id.
  const gbpLocations = [];
  const perAccountCounts = [];
  for (const account of accounts) {
    const accountName = account.name; // "accounts/12345"
    let pageToken = null;
    let pagesForAccount = 0;
    let countForAccount = 0;
    // Safety cap in case pageToken cycles forever (never seen but cheap
    // to guard against). 200 pages × 100/pg = 20k locations per account,
    // well above realistic scale.
    while (pagesForAccount < 200) {
      let page;
      try {
        page = await listLocations(accountName, { pageSize: 100, pageToken });
      } catch (e) {
        return NextResponse.json(
          { error: `listLocations failed on ${accountName}: ${e.message}`, partial: gbpLocations.length },
          { status: 502 }
        );
      }
      const items = Array.isArray(page.locations) ? page.locations : [];
      for (const loc of items) {
        gbpLocations.push({ accountName, location: loc });
      }
      countForAccount += items.length;
      pagesForAccount++;
      pageToken = page.nextPageToken || null;
      if (!pageToken) break;
      await new Promise((r) => setTimeout(r, throttle));
    }
    perAccountCounts.push({ account: accountName, locationCount: countForAccount });
    // Throttle between accounts too.
    if (accounts.length > 1) await new Promise((r) => setTimeout(r, throttle));
  }

  // Build lookup indexes on the GBP location list. First-writer-wins per
  // key; conflicts get recorded in ambiguousKeys so the summary can flag
  // matches that could reasonably have gone either way.
  const gbpByUrl = new Map();
  const gbpByPhone = new Map();
  const gbpByAddrCity = new Map();
  const ambiguousKeys = new Set();

  for (const entry of gbpLocations) {
    const loc = entry.location;
    const url = normalizeUrl(loc.websiteUri);
    const phone = normalizePhone(loc.phoneNumbers?.primaryPhone);
    const addrCity = addrCityKey(
      loc.storefrontAddress?.addressLines?.[0],
      loc.storefrontAddress?.locality
    );

    if (url) {
      if (gbpByUrl.has(url)) ambiguousKeys.add(`url:${url}`);
      else gbpByUrl.set(url, entry);
    }
    if (phone) {
      if (gbpByPhone.has(phone)) ambiguousKeys.add(`phone:${phone}`);
      else gbpByPhone.set(phone, entry);
    }
    if (addrCity) {
      if (gbpByAddrCity.has(addrCity)) ambiguousKeys.add(`addr:${addrCity}`);
      else gbpByAddrCity.set(addrCity, entry);
    }
  }

  // Match every shop.
  const matches = [];
  const strategies = { url: 0, phone: 0, address: 0 };
  const perBrand = {};
  const unmatchedShops = [];
  let ambiguous = 0;

  for (const shop of shops) {
    const brand = shop.brand || "unknown";
    perBrand[brand] = perBrand[brand] || { total: 0, matched: 0 };
    perBrand[brand].total++;

    const url = normalizeUrl(shop.website);
    const phone = normalizePhone(shop.phone);
    const addrCity = addrCityKey(shop.street_address, shop.city);

    let hit = null;
    let by = null;

    if (url && gbpByUrl.has(url)) {
      hit = gbpByUrl.get(url); by = "url";
      if (ambiguousKeys.has(`url:${url}`)) ambiguous++;
    } else if (phone && gbpByPhone.has(phone)) {
      hit = gbpByPhone.get(phone); by = "phone";
      if (ambiguousKeys.has(`phone:${phone}`)) ambiguous++;
    } else if (addrCity && gbpByAddrCity.has(addrCity)) {
      hit = gbpByAddrCity.get(addrCity); by = "address";
      if (ambiguousKeys.has(`addr:${addrCity}`)) ambiguous++;
    }

    if (hit) {
      matches.push({
        shopId: shop.shop_id,
        gbpAccountId: hit.accountName,
        gbpLocationId: hit.location.name,
      });
      strategies[by]++;
      perBrand[brand].matched++;
    } else if (unmatchedShops.length < 100) {
      unmatchedShops.push({ shopId: shop.shop_id, brand, city: shop.city });
    }
  }

  // Persist matches. Sequential writes — postgres handles this well and
  // we get accurate per-write success counts. Errors are collected but
  // don't halt the loop.
  let updated = 0;
  const dbErrors = [];
  for (const m of matches) {
    try {
      const ok = await setGbpMappingByShopId(m.shopId, m.gbpAccountId, m.gbpLocationId);
      if (ok) updated++;
    } catch (e) {
      if (dbErrors.length < 5) dbErrors.push(`${m.shopId}: ${e.message}`);
    }
  }

  await logActivity({
    user: user.name,
    action: "Synced GBP mappings",
    location: "",
    brand: "system",
    details: `${matches.length} matched of ${shops.length} shops (url:${strategies.url} phone:${strategies.phone} addr:${strategies.address}); ${updated} rows updated.`,
  });

  return NextResponse.json({
    accountCount: accounts.length,
    gbpLocationCount: gbpLocations.length,
    shopCount: shops.length,
    matched: matches.length,
    updated,
    unmatched: shops.length - matches.length,
    strategies,
    perBrand,
    perAccountCounts,
    unmatchedShops,
    ambiguous,
    dbErrors,
  });
}

// GET — quick readiness check (no work done)
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({ gbp: (await getGoogleBpStatus()).state });
}

// ---------------------------------------------------------------------------
// Normalization — matches the rules used everywhere else (Semrush sync
// and shop matcher) so behavior stays consistent.
// ---------------------------------------------------------------------------

function normalizeUrl(url) {
  if (!url) return "";
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\?.*$/, "") // strip query params (utm_* etc.)
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
        const map = { street: "st", avenue: "ave", road: "rd", drive: "dr", boulevard: "blvd", lane: "ln", court: "ct", place: "pl", highway: "hwy" };
        return map[m] || m;
      }
    )
    .replace(/\s+/g, " ")
    .trim();
  const c = (city || "").toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
  if (!a || !c) return "";
  return `${a}|${c}`;
}

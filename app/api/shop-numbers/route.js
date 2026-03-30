import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import {
  getShopNumbers,
  getShopNumberMap,
  importShopNumbers,
  bulkMatchShops,
  matchShopToLocation,
  clearShopNumbers,
} from "@/lib/db";
import { logActivity } from "@/lib/db";

// GET - list all shop numbers with match status
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const shops = await getShopNumbers();
  const matched = shops.filter((s) => s.semrush_location_id).length;

  return NextResponse.json({
    shops,
    total: shops.length,
    matched,
    unmatched: shops.length - matched,
  });
}

// POST - import CSV data and auto-match to Semrush locations
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || !["admin", "manager"].includes(user.role)) {
    return NextResponse.json({ error: "Admin or manager access required" }, { status: 403 });
  }

  const body = await request.json();

  // Handle CSV import
  if (body.action === "import") {
    const records = parseCSVRecords(body.data || []);
    const result = await importShopNumbers(records);

    await logActivity({
      user: user.name,
      action: "Imported shop numbers",
      location: "",
      brand: "system",
      details: `${result.imported} imported, ${result.errors} errors`,
    });

    return NextResponse.json(result);
  }

  // Handle auto-match against Semrush locations
  if (body.action === "auto-match") {
    const semrushLocations = body.locations || [];
    const shopMap = await getShopNumberMap();
    const matches = [];
    const strategies = { url: 0, address_phone: 0, address_city: 0, unmatched: 0 };

    for (const shop of shopMap.all) {
      if (shop.semrush_location_id) continue; // already matched

      let matched = false;

      // Strategy 1: Match by shop ID in Semrush website URL
      // Many brands embed shop ID in their URL (e.g. /30099/ or /17015/)
      for (const loc of semrushLocations) {
        const locUrl = loc.website || loc.websiteRaw || "";
        if (locUrl && shop.shop_id && locUrl.includes(`/${shop.shop_id}/`)) {
          matches.push({ shopId: shop.shop_id, semrushLocationId: loc.id });
          strategies.url++;
          matched = true;
          break;
        }
        // Also check URL ending with shop ID (no trailing slash)
        if (locUrl && shop.shop_id && locUrl.endsWith(`/${shop.shop_id}`)) {
          matches.push({ shopId: shop.shop_id, semrushLocationId: loc.id });
          strategies.url++;
          matched = true;
          break;
        }
      }
      if (matched) continue;

      // Strategy 2: Match by normalized address + phone
      const shopAddr = normalizeAddress(shop.street_address);
      const shopPhone = normalizePhone(shop.phone);

      if (shopAddr && shopPhone) {
        for (const loc of semrushLocations) {
          const locAddr = normalizeAddress(loc.address);
          const locPhone = normalizePhone(loc.phone);
          if (shopAddr === locAddr && shopPhone === locPhone) {
            matches.push({ shopId: shop.shop_id, semrushLocationId: loc.id });
            strategies.address_phone++;
            matched = true;
            break;
          }
        }
      }
      if (matched) continue;

      // Strategy 3: Match by normalized address + city
      const shopCity = normalizeCity(shop.city);
      if (shopAddr && shopCity) {
        for (const loc of semrushLocations) {
          const locAddr = normalizeAddress(loc.address);
          const locCity = normalizeCity(loc.city);
          if (shopAddr === locAddr && shopCity === locCity) {
            matches.push({ shopId: shop.shop_id, semrushLocationId: loc.id });
            strategies.address_city++;
            matched = true;
            break;
          }
        }
      }

      if (!matched) strategies.unmatched++;
    }

    if (matches.length > 0) {
      await bulkMatchShops(matches);
    }

    await logActivity({
      user: user.name,
      action: "Auto-matched shop numbers",
      location: "",
      brand: "system",
      details: `${matches.length} matched (URL: ${strategies.url}, addr+phone: ${strategies.address_phone}, addr+city: ${strategies.address_city}), ${strategies.unmatched} unmatched`,
    });

    return NextResponse.json({
      matched: matches.length,
      strategies,
      matches: matches.slice(0, 20), // preview
    });
  }

  // Handle manual match
  if (body.action === "manual-match") {
    await matchShopToLocation(body.shopId, body.semrushLocationId);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

// DELETE - clear all shop numbers
export async function DELETE(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  await clearShopNumbers();
  await logActivity({
    user: user.name,
    action: "Cleared shop numbers",
    location: "",
    brand: "system",
    details: "All shop number records removed",
  });

  return NextResponse.json({ success: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCSVRecords(rows) {
  return rows.map((row) => ({
    shop_id: (row["Shop ID"] || row["shop_id"] || "").toString().trim(),
    brand: (row["Brand Name"] || row["brand"] || "").trim(),
    street_address: (row["Street Address"] || row["street_address"] || "").trim(),
    address2: (row["Address2"] || row["address2"] || "").trim(),
    city: (row["City"] || row["city"] || "").trim(),
    country: (row["Country"] || row["country"] || "").trim(),
    state: (row["State / Province"] || row["state"] || "").trim(),
    zip: (row["Zip / Postal Code"] || row["zip"] || "").trim(),
    phone: (row["Phone Number"] || row["phone"] || "").toString().trim(),
    website: (row["Website"] || row["website"] || "").trim(),
  }));
}

function normalizeAddress(addr) {
  if (!addr) return "";
  return addr
    .toLowerCase()
    .replace(/[.,#]/g, "")
    .replace(/\b(street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|lane|ln|court|ct|place|pl|highway|hwy|way)\b/g, (m) => {
      const map = { street: "st", avenue: "ave", road: "rd", drive: "dr", boulevard: "blvd", lane: "ln", court: "ct", place: "pl", highway: "hwy" };
      return map[m] || m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePhone(phone) {
  if (!phone) return "";
  return phone.toString().replace(/\D/g, "").slice(-10); // last 10 digits
}

function normalizeCity(city) {
  if (!city) return "";
  return city.toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
}

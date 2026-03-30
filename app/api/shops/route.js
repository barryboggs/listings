import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import {
  getShopNumbers,
  getShopNumberMap,
  importShopNumbers,
  bulkMatchShops,
  clearShopNumbers,
} from "@/lib/db";

/**
 * CSV brand names → our internal brand IDs
 */
const CSV_BRAND_MAP = {
  "take 5": "take5",
  "take 5 canada": "take5-ca",
  "carstar us": "carstar-us",
  "carstar canada": "carstar-ca",
  "auto glass now (agn)": "autoglass",
  "auto glass now": "autoglass",
  "maaco us": "maaco-us",
  "maaco ca": "maaco-ca",
  "fix auto": "fixauto",
  "abra": "abra",
  "1-800-radiator": "1800radiator",
  "docteur du pare-brise (uniban)": "uniban",
  "meineke": "meineke",
  "econo lube": "econo",
  "star lube": "starlube",
};

function mapBrandName(csvBrand) {
  return CSV_BRAND_MAP[csvBrand.toLowerCase().trim()] || csvBrand.toLowerCase().replace(/\s+/g, "-");
}

/**
 * Normalize strings for fuzzy matching
 */
function normalize(str) {
  if (!str) return "";
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizePhone(phone) {
  if (!phone) return "";
  return phone.replace(/[^0-9]/g, "").slice(-10); // last 10 digits
}

// GET - list all shop numbers
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const shops = await getShopNumbers();
  const { bySemrushId } = await getShopNumberMap();
  const matched = shops.filter((s) => s.semrush_location_id).length;
  const unmatched = shops.length - matched;

  return NextResponse.json({ shops, total: shops.length, matched, unmatched });
}

// POST - import CSV and optionally auto-match
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await request.json();

  // CSV import
  if (body.action === "import") {
    const { csvData, locations } = body;

    // Parse CSV lines
    const lines = csvData.split("\n").map((l) => l.replace(/\r/g, "").trim()).filter(Boolean);
    if (lines.length < 2) {
      return NextResponse.json({ error: "CSV must have a header row and at least one data row" }, { status: 400 });
    }

    const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const shopIdIdx = header.findIndex((h) => h.includes("shop") && h.includes("id"));
    const brandIdx = header.findIndex((h) => h.includes("brand"));
    const addressIdx = header.findIndex((h) => h.includes("street") || (h.includes("address") && !h.includes("2")));
    const address2Idx = header.findIndex((h) => h.includes("address2") || h.includes("address 2"));
    const cityIdx = header.findIndex((h) => h.includes("city"));
    const countryIdx = header.findIndex((h) => h.includes("country"));
    const stateIdx = header.findIndex((h) => h.includes("state") || h.includes("province"));
    const zipIdx = header.findIndex((h) => h.includes("zip") || h.includes("postal"));
    const phoneIdx = header.findIndex((h) => h.includes("phone"));
    const websiteIdx = header.findIndex((h) => h.includes("website") || h.includes("url"));

    if (shopIdIdx === -1 || brandIdx === -1) {
      return NextResponse.json({ error: "CSV must have 'Shop ID' and 'Brand Name' columns" }, { status: 400 });
    }

    // Parse rows — handle quoted fields with commas
    const records = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (!cols[shopIdIdx]) continue;

      records.push({
        shop_id: cols[shopIdIdx]?.trim() || "",
        brand: mapBrandName(cols[brandIdx] || ""),
        street_address: cols[addressIdx]?.trim() || "",
        address2: address2Idx >= 0 ? cols[address2Idx]?.trim() || "" : "",
        city: cols[cityIdx]?.trim() || "",
        country: countryIdx >= 0 ? cols[countryIdx]?.trim() || "" : "",
        state: stateIdx >= 0 ? cols[stateIdx]?.trim() || "" : "",
        zip: zipIdx >= 0 ? cols[zipIdx]?.trim() || "" : "",
        phone: phoneIdx >= 0 ? cols[phoneIdx]?.trim() || "" : "",
        website: websiteIdx >= 0 ? cols[websiteIdx]?.trim() || "" : "",
      });
    }

    const result = await importShopNumbers(records);

    // Auto-match if locations are provided
    let matchResult = { matched: 0 };
    if (locations && locations.length > 0) {
      matchResult = await autoMatchShops(records, locations);
    }

    return NextResponse.json({
      imported: result.imported,
      importErrors: result.errors,
      ...matchResult,
    });
  }

  // Auto-match existing shop numbers against locations
  if (body.action === "match") {
    const { locations } = body;
    if (!locations) {
      return NextResponse.json({ error: "Locations array required" }, { status: 400 });
    }

    const shops = await getShopNumbers();
    const result = await autoMatchShops(shops, locations);
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
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
  return NextResponse.json({ success: true });
}

/**
 * Auto-match shop numbers to Semrush locations using multiple strategies:
 * 1. Shop ID in Semrush website URL (strongest signal)
 * 2. Normalized phone number match + brand
 * 3. Normalized street address + city + brand
 */
async function autoMatchShops(shops, locations) {
  const matches = [];
  const unmatched = [];

  for (const shop of shops) {
    let bestMatch = null;

    // Strategy 1: Check if shop ID appears in any location's website URL
    for (const loc of locations) {
      const url = (loc.website || loc.websiteRaw || "").toLowerCase();
      if (url && shop.shop_id && url.includes(shop.shop_id.toLowerCase())) {
        bestMatch = loc;
        break;
      }
    }

    // Strategy 2: Phone number match + brand alignment
    if (!bestMatch && shop.phone) {
      const shopPhone = normalizePhone(shop.phone);
      if (shopPhone.length >= 10) {
        for (const loc of locations) {
          const locPhone = normalizePhone(loc.phone);
          if (locPhone === shopPhone) {
            bestMatch = loc;
            break;
          }
        }
      }
    }

    // Strategy 3: Street address + city match
    if (!bestMatch && shop.street_address && shop.city) {
      const shopAddr = normalize(shop.street_address);
      const shopCity = normalize(shop.city);
      for (const loc of locations) {
        const locAddr = normalize(loc.address);
        const locCity = normalize(loc.city);
        if (shopAddr && locAddr && shopCity && locCity && shopAddr === locAddr && shopCity === locCity) {
          bestMatch = loc;
          break;
        }
      }
    }

    if (bestMatch) {
      matches.push({ shopId: shop.shop_id, semrushLocationId: bestMatch.id });
    } else {
      unmatched.push(shop.shop_id);
    }
  }

  // Bulk save matches
  const result = await bulkMatchShops(matches);

  return {
    matched: result.matched,
    unmatched: unmatched.length,
    unmatchedIds: unmatched.slice(0, 50), // return first 50 for debugging
    total: shops.length,
  };
}

/**
 * Parse a CSV line handling quoted fields that may contain commas
 */
function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

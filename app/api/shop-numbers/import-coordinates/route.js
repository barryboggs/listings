import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { bulkSetShopCoordinates, initDatabase, logActivity } from "@/lib/db";

/**
 * POST /api/shop-numbers/import-coordinates
 *
 * Admin-only. Accepts a CSV of shop coordinates and upserts them into
 * lm_shop_numbers.latitude / .longitude. Used to fix Semrush map pins
 * when GBP has no latlng to source from (~10% of GBP locations).
 *
 * Body: { csvData: string }
 *
 * CSV format:
 *   shop_id,latitude,longitude
 *   13000,30.4394,-97.5993
 *   13001,30.4212,-97.6104
 *   ...
 *
 * Header row is optional but recommended. Column order matters ONLY if
 * there's no header; with a header we detect columns by name so admins
 * can hand-edit their CSVs freely.
 *
 * Response:
 *   {
 *     parsed: number,          // rows parsed from CSV
 *     updated: number,         // shop rows in DB updated
 *     unmatched: number,       // CSV rows whose shop_id isn't in our DB
 *     invalid: number,         // CSV rows with bad lat/lng values (skipped)
 *     invalidSamples: string[] // up to 5 example row descriptions
 *   }
 */
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  await initDatabase();

  const body = await request.json().catch(() => ({}));
  const csvData = typeof body.csvData === "string" ? body.csvData : "";
  if (!csvData.trim()) {
    return NextResponse.json({ error: "csvData string is required" }, { status: 400 });
  }

  const lines = csvData
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return NextResponse.json({ error: "CSV is empty" }, { status: 400 });
  }

  // Detect delimiter — spreadsheet copy-paste yields tabs; a saved CSV
  // yields commas. Pick whichever appears more often in the first line.
  // Semicolon added for European locale exports. Falls back to comma.
  const firstLine = lines[0];
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semiCount = (firstLine.match(/;/g) || []).length;
  const DELIMITER = tabCount > commaCount && tabCount > semiCount
    ? "\t"
    : semiCount > commaCount
    ? ";"
    : ",";
  const splitRow = (line) => line.split(DELIMITER).map((c) => c.trim());

  // Detect + skip header row. If the first row has any non-numeric
  // second column, treat it as a header. Column detection is fuzzy —
  // accepts anything containing "lat"/"lon"/"lng" for coordinates and
  // any of a broader set for shop id, so admins don't have to rename
  // their spreadsheet columns.
  let shopCol = 0, latCol = 1, lngCol = 2;
  let startAt = 0;
  const firstCells = splitRow(lines[0]);
  const looksLikeHeader = isNaN(parseFloat(firstCells[1]));
  if (looksLikeHeader) {
    const headers = firstCells.map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));

    // Longitude first — because "longitude" also contains "lat"... no
    // wait, it doesn't. But "long" partially matches later. Order the
    // more specific ones first to avoid collisions.
    const lng = headers.findIndex((h) =>
      h === "longitude" || h === "long" || h === "lng" || h === "lon" ||
      h.includes("longitude") || h.includes("lng")
    );
    const lat = headers.findIndex((h) =>
      h === "latitude" || h === "lat" || h.includes("latitude")
    );

    // Shop id: prefer exact matches over substrings so "shopname" doesn't
    // beat "shopid". Fall back to any column containing "shop" or "store"
    // paired with "id"/"num"/"number".
    const shopExact = headers.findIndex((h) =>
      ["shopid", "shop", "id", "shopnumber", "storeid", "storenumber", "storenum", "locationid", "locid"].includes(h)
    );
    const shopFuzzy = shopExact >= 0 ? shopExact : headers.findIndex((h) =>
      (h.includes("shop") || h.includes("store") || h.includes("location")) &&
      (h.includes("id") || h.includes("num"))
    );
    const shop = shopExact >= 0 ? shopExact : (shopFuzzy >= 0 ? shopFuzzy : -1);

    if (shop < 0 || lat < 0 || lng < 0) {
      return NextResponse.json({
        error: "Couldn't identify shop_id / latitude / longitude columns from your header row. Rename the columns to something like \"shop_id, latitude, longitude\" or open a diagnostic and share your header names.",
        headersReceived: firstCells,
        headersNormalized: headers,
        detected: {
          shop: shop >= 0 ? firstCells[shop] : null,
          latitude: lat >= 0 ? firstCells[lat] : null,
          longitude: lng >= 0 ? firstCells[lng] : null,
        },
      }, { status: 400 });
    }
    shopCol = shop; latCol = lat; lngCol = lng;
    startAt = 1;
  }

  const rows = [];
  let invalid = 0;
  const invalidSamples = [];
  for (let i = startAt; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    const shopId = cells[shopCol];
    const lat = parseFloat(cells[latCol]);
    const lng = parseFloat(cells[lngCol]);
    if (!shopId || isNaN(lat) || isNaN(lng)) {
      invalid++;
      if (invalidSamples.length < 5) invalidSamples.push(`row ${i + 1}: unparseable — "${lines[i].slice(0, 80)}"`);
      continue;
    }
    // Basic sanity — latitude in [-90,90], longitude in [-180,180]
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      invalid++;
      if (invalidSamples.length < 5) invalidSamples.push(`row ${i + 1}: out of range (lat=${lat}, lng=${lng}) — columns swapped?`);
      continue;
    }
    rows.push({ shopId, latitude: lat, longitude: lng });
  }

  const { updated, unmatched, errors } = await bulkSetShopCoordinates(rows);

  logActivity({
    user: user.name,
    action: "Imported shop coordinates",
    location: "",
    brand: "system",
    details: `parsed:${rows.length} updated:${updated} unmatched:${unmatched} invalid:${invalid}`,
  }).catch(() => {});

  return NextResponse.json({
    parsed: rows.length,
    updated,
    unmatched,
    invalid,
    invalidSamples,
    delimiter: DELIMITER === "\t" ? "tab" : DELIMITER,
    dbErrors: errors,
  });
}

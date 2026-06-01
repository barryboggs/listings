import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";

/**
 * Parse time strings like "9:00:00 AM", "5:00:00 PM" into "HH:mm" (24h)
 */
function parseTime(timeStr) {
  if (!timeStr) return null;
  const str = timeStr.trim();
  if (!str || str.toLowerCase() === "close" || str.toLowerCase() === "closed") return null;

  const match = str.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  if (match) {
    let hours = parseInt(match[1]);
    const minutes = match[2];
    const ampm = match[3].toUpperCase();
    if (ampm === "PM" && hours !== 12) hours += 12;
    if (ampm === "AM" && hours === 12) hours = 0;
    return `${String(hours).padStart(2, "0")}:${minutes}`;
  }

  const match24 = str.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) return `${String(parseInt(match24[1])).padStart(2, "0")}:${match24[2]}`;

  return null;
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const str = dateStr.trim();
  if (!str) return null;
  const match = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return `${match[3]}-${String(parseInt(match[1])).padStart(2, "0")}-${String(parseInt(match[2])).padStart(2, "0")}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  return null;
}

function isClosed(openVal, closeVal) {
  const o = (openVal || "").trim().toLowerCase();
  const c = (closeVal || "").trim().toLowerCase();
  return o === "close" || o === "closed" || c === "close" || c === "closed" || (!o && !c);
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') { inQuotes = !inQuotes; }
    else if (char === "," && !inQuotes) { result.push(current); current = ""; }
    else { current += char; }
  }
  result.push(current);
  return result;
}

/**
 * POST - Parse holiday hours CSV and return preview with matched location data.
 * Does NOT push to Semrush — the client handles batched pushing via /api/holiday-push.
 */
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { csvData, locations } = body;

  if (!csvData) return NextResponse.json({ error: "csvData is required" }, { status: 400 });

  const lines = csvData.split("\n").map((l) => l.replace(/\r/g, "").replace(/^\uFEFF/, "").trim()).filter(Boolean);
  if (lines.length < 2) return NextResponse.json({ error: "CSV must have a header row and data rows" }, { status: 400 });

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const franchiseIdIdx = header.findIndex((h) => h.includes("franchise") && h.includes("id"));
  const holiday1Idx = header.findIndex((h) => h === "holiday" || (h.includes("holiday") && !h.includes("open") && !h.includes("close") && !h.includes("2")));
  const holiday1OpenIdx = header.findIndex((h) => h === "holiday open" || (h.includes("holiday") && h.includes("open") && !h.includes("2")));
  const holiday1CloseIdx = header.findIndex((h) => h === "holiday close" || (h.includes("holiday") && h.includes("close") && !h.includes("2")));
  const holiday2Idx = header.findIndex((h) => h === "holiday 2" || (h.includes("holiday") && h.includes("2") && !h.includes("open") && !h.includes("close")));
  const holiday2OpenIdx = header.findIndex((h) => (h.includes("holiday") && h.includes("open") && h.includes("2")));
  const holiday2CloseIdx = header.findIndex((h) => (h.includes("holiday") && h.includes("close") && h.includes("2")));

  if (franchiseIdIdx === -1) return NextResponse.json({ error: "CSV must have a 'Franchise ID' column" }, { status: 400 });
  if (holiday1Idx === -1) return NextResponse.json({ error: "CSV must have a 'Holiday' date column" }, { status: 400 });

  const locByShopId = new Map();
  for (const loc of (locations || [])) {
    if (loc.shopId) locByShopId.set(loc.shopId.toString(), loc);
  }

  const results = {
    total: 0, matched: 0, unmatched: 0, unmatchedIds: [],
    closed: 0, specialHours: 0, holiday2Count: 0,
    updates: [],
  };

  // Aggregate by location: each row contributes its Holiday 1 + Holiday 2
  // entries to the shop's running list. A CSV with N rows for the same
  // shop now produces one update with all of that shop's holidays merged.
  // Previously a hard "skip if seen" dropped all rows after the first,
  // so multi-row holiday CSVs silently lost data after row 1.
  //
  // Within a shop, dedupe by date — first-write-wins for predictability
  // (same shop + same date appearing twice keeps the first row's hours).
  const byLocation = new Map(); // locationId → { loc, shopId, holidayHours, seenDates }

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const shopId = (cols[franchiseIdIdx] || "").trim();
    if (!shopId) continue;

    results.total++;

    const loc = locByShopId.get(shopId);
    if (!loc) {
      results.unmatched++;
      if (results.unmatchedIds.length < 50) results.unmatchedIds.push(shopId);
      continue;
    }

    // First time we see this shop, register it and count it as matched.
    let acc = byLocation.get(loc.id);
    if (!acc) {
      acc = { loc, shopId, holidayHours: [], seenDates: new Set() };
      byLocation.set(loc.id, acc);
      results.matched++;
    }

    // Parse one (date, open, close) tuple from the row and append to the
    // shop's accumulator if it's a new date and the hours parse cleanly.
    // `isSecond` flips the counter that drives the "Second Holiday" stat
    // card in the UI; otherwise it shows the Holiday 1 counts.
    const addEntry = (dateIdx, openIdx, closeIdx, isSecond) => {
      if (dateIdx < 0) return;
      const date = parseDate(cols[dateIdx]);
      if (!date) return;
      if (acc.seenDates.has(date)) return;
      const openVal = cols[openIdx] || "";
      const closeVal = cols[closeIdx] || "";
      let entry = null;
      if (isClosed(openVal, closeVal)) {
        entry = { type: "CLOSED", day: date };
        results.closed++;
      } else {
        const from = parseTime(openVal);
        const to = parseTime(closeVal);
        if (from && to) {
          entry = { type: "RANGE", day: date, times: [{ from, to }] };
          results.specialHours++;
        }
      }
      if (entry) {
        acc.holidayHours.push(entry);
        acc.seenDates.add(date);
        if (isSecond) results.holiday2Count++;
      }
    };

    addEntry(holiday1Idx, holiday1OpenIdx, holiday1CloseIdx, false);
    addEntry(holiday2Idx, holiday2OpenIdx, holiday2CloseIdx, true);
  }

  // Flatten the per-location map into the updates[] the client iterates.
  for (const acc of byLocation.values()) {
    if (acc.holidayHours.length > 0) {
      results.updates.push({
        loc: acc.loc,
        shopId: acc.shopId,
        holidayHours: acc.holidayHours,
      });
    }
  }

  return NextResponse.json({
    ...results,
    duplicatesSkipped: results.total - results.unmatched - results.matched,
    preview: results.updates.slice(0, 20).map((u) => ({
      shopId: u.shopId,
      locationId: u.loc.id,
      locationName: u.loc.name,
      city: u.loc.city,
      state: u.loc.state,
      holidayHours: u.holidayHours,
    })),
  });
}

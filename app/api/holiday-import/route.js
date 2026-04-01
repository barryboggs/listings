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

  const seenLocationIds = new Set();

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

    // Deduplicate by location ID
    if (seenLocationIds.has(loc.id)) continue;
    seenLocationIds.add(loc.id);

    results.matched++;

    const holidayHours = [];

    // Holiday 1
    const date1 = parseDate(cols[holiday1Idx]);
    if (date1) {
      const open1 = cols[holiday1OpenIdx] || "";
      const close1 = cols[holiday1CloseIdx] || "";
      if (isClosed(open1, close1)) {
        holidayHours.push({ type: "CLOSED", day: date1 });
        results.closed++;
      } else {
        const from = parseTime(open1);
        const to = parseTime(close1);
        if (from && to) {
          holidayHours.push({ type: "RANGE", day: date1, times: [{ from, to }] });
          results.specialHours++;
        }
      }
    }

    // Holiday 2
    if (holiday2Idx >= 0) {
      const date2 = parseDate(cols[holiday2Idx] || "");
      if (date2) {
        const open2 = cols[holiday2OpenIdx] || "";
        const close2 = cols[holiday2CloseIdx] || "";
        results.holiday2Count++;
        if (isClosed(open2, close2)) {
          holidayHours.push({ type: "CLOSED", day: date2 });
        } else {
          const from = parseTime(open2);
          const to = parseTime(close2);
          if (from && to) {
            holidayHours.push({ type: "RANGE", day: date2, times: [{ from, to }] });
          }
        }
      }
    }

    if (holidayHours.length > 0) {
      results.updates.push({
        loc,
        shopId,
        holidayHours,
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

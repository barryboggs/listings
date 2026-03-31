import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { bulkUpdateLocations, toSemrushFormat } from "@/lib/semrush";

/**
 * Parse time strings like "9:00:00 AM", "5:00:00 PM", "12:00:00 PM" into "HH:mm" (24h)
 */
function parseTime(timeStr) {
  if (!timeStr) return null;
  const str = timeStr.trim();
  if (!str || str.toLowerCase() === "close" || str.toLowerCase() === "closed") return null;

  // Try parsing "H:MM:SS AM/PM" or "H:MM AM/PM" format
  const match = str.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  if (match) {
    let hours = parseInt(match[1]);
    const minutes = match[2];
    const ampm = match[3].toUpperCase();

    if (ampm === "PM" && hours !== 12) hours += 12;
    if (ampm === "AM" && hours === 12) hours = 0;

    return `${String(hours).padStart(2, "0")}:${minutes}`;
  }

  // Try parsing "HH:MM" 24h format directly
  const match24 = str.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    return `${String(parseInt(match24[1])).padStart(2, "0")}:${match24[2]}`;
  }

  return null;
}

/**
 * Parse date strings like "4/5/2026" into "2026-04-05"
 */
function parseDate(dateStr) {
  if (!dateStr) return null;
  const str = dateStr.trim();
  if (!str) return null;

  // M/D/YYYY
  const match = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    return `${match[3]}-${String(parseInt(match[1])).padStart(2, "0")}-${String(parseInt(match[2])).padStart(2, "0")}`;
  }

  // Already YYYY-MM-DD
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

// POST - import holiday hours CSV
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { csvData, locations, dryRun } = body;

  if (!csvData) {
    return NextResponse.json({ error: "csvData is required" }, { status: 400 });
  }

  // Parse CSV
  const lines = csvData.split("\n").map((l) => l.replace(/\r/g, "").replace(/^\uFEFF/, "").trim()).filter(Boolean);
  if (lines.length < 2) {
    return NextResponse.json({ error: "CSV must have a header row and at least one data row" }, { status: 400 });
  }

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const franchiseIdIdx = header.findIndex((h) => h.includes("franchise") && h.includes("id"));
  const holiday1Idx = header.findIndex((h) => h === "holiday" || (h.includes("holiday") && !h.includes("open") && !h.includes("close") && !h.includes("2")));
  const holiday1OpenIdx = header.findIndex((h) => h === "holiday open" || (h.includes("holiday") && h.includes("open") && !h.includes("2")));
  const holiday1CloseIdx = header.findIndex((h) => h === "holiday close" || (h.includes("holiday") && h.includes("close") && !h.includes("2")));
  const holiday2Idx = header.findIndex((h) => h === "holiday 2" || (h.includes("holiday") && h.includes("2") && !h.includes("open") && !h.includes("close")));
  const holiday2OpenIdx = header.findIndex((h) => (h.includes("holiday") && h.includes("open") && h.includes("2")));
  const holiday2CloseIdx = header.findIndex((h) => (h.includes("holiday") && h.includes("close") && h.includes("2")));

  if (franchiseIdIdx === -1) {
    return NextResponse.json({ error: "CSV must have a 'Franchise ID' column" }, { status: 400 });
  }
  if (holiday1Idx === -1) {
    return NextResponse.json({ error: "CSV must have a 'Holiday' date column" }, { status: 400 });
  }

  // Build location lookup by shop ID (from the merged location data)
  const locByShopId = new Map();
  for (const loc of (locations || [])) {
    if (loc.shopId) {
      locByShopId.set(loc.shopId.toString(), loc);
    }
  }

  // Parse rows and build holiday entries
  const results = {
    total: 0,
    matched: 0,
    unmatched: 0,
    unmatchedIds: [],
    closed: 0,
    specialHours: 0,
    holiday2Count: 0,
    updates: [], // { locationId, locationName, shopId, holidayHours: [...] }
  };

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const shopId = (cols[franchiseIdIdx] || "").trim();
    if (!shopId) continue;

    results.total++;

    // Find matching Semrush location
    const loc = locByShopId.get(shopId);
    if (!loc) {
      results.unmatched++;
      if (results.unmatchedIds.length < 50) results.unmatchedIds.push(shopId);
      continue;
    }

    results.matched++;

    // Build holiday hours array for this location
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

    // Holiday 2 (if present)
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
        locationId: loc.id,
        shopId,
        // Store the full location so we can pass all fields to Semrush
        loc,
        holidayHours,
      });
    }
  }

  // If dry run, return preview without pushing
  if (dryRun) {
    return NextResponse.json({
      ...results,
      dryRun: true,
      preview: results.updates.slice(0, 20).map((u) => ({
        shopId: u.shopId,
        locationId: u.locationId,
        locationName: u.loc.name,
        city: u.loc.city,
        state: u.loc.state,
        holidayHours: u.holidayHours,
      })),
    });
  }

  // Push updates to Semrush directly using bulk update endpoint
  // Bulk update: max 50 locations per request, 5 requests per MINUTE
  let pushed = 0;
  let pushErrors = 0;
  const errors = [];

  // Build Semrush payloads using toSemrushFormat for proper field mapping
  // Pass the full location data so Semrush gets all fields it validates
  const semrushPayloads = results.updates.map((update) => {
    const loc = update.loc;
    const payload = toSemrushFormat({
      name: loc.name,
      address: loc.address,
      additionalAddressInfo: loc.additionalAddressInfo,
      city: loc.city,
      state: loc.state,
      zip: loc.zip,
      phone: loc.phone,
      website: loc.website,
      urlParams: loc.urlParams,
      businessHours: loc.businessHours,
      holidayHours: update.holidayHours, // Override with the new holiday hours from CSV
      reopenDate: loc.reopenDate,
    });
    payload.id = update.locationId;
    return payload;
  });

  // Chunk into batches of 50
  const chunks = [];
  for (let i = 0; i < semrushPayloads.length; i += 50) {
    chunks.push(semrushPayloads.slice(i, i + 50));
  }

  for (let c = 0; c < chunks.length; c++) {
    try {
      const batchResults = await bulkUpdateLocations(chunks[c]);

      // batchResults: [{ locationId, state: "UPDATED"|"FAILED", error? }]
      if (Array.isArray(batchResults)) {
        for (const r of batchResults) {
          if (r.state === "UPDATED") {
            pushed++;
          } else {
            pushErrors++;
            if (errors.length < 20) {
              const shopId = results.updates.find((u) => u.locationId === r.locationId)?.shopId || r.locationId;
              errors.push({ shopId, error: r.error?.message || r.state || "Unknown" });
            }
          }
        }
      } else {
        // If response isn't an array, count the whole batch as pushed (legacy format)
        pushed += chunks[c].length;
      }
    } catch (error) {
      // Entire batch failed
      pushErrors += chunks[c].length;
      if (errors.length < 20) errors.push({ shopId: `batch-${c + 1}`, error: error.message });
    }

    // Wait 12 seconds between batches (5 req/min = 1 every 12s)
    if (c < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 12000));
    }
  }

  // Log activity
  try {
    const { logActivity } = await import("@/lib/db");
    await logActivity({
      user: user.name,
      action: "Holiday hours import",
      location: `${pushed} locations updated, ${pushErrors} errors`,
      brand: "multi-brand",
      details: `${chunks.length} batches sent to Semrush. ${results.closed} closed, ${results.specialHours} special hours.`,
    });
  } catch {}

  return NextResponse.json({
    ...results,
    pushed,
    pushErrors,
    batches: chunks.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}

/**
 * Holiday-hours CSV parsing, shared by the Semrush import
 * (/api/holiday-import) and the GBP import (/api/gbp/holiday-import).
 *
 * The CSV format is the brand teams' spreadsheet:
 *   Franchise ID, Holiday, Holiday Open, Holiday Close
 *   [, Holiday 2, Holiday Open 2, Holiday Close 2]
 *
 * Open/Close of "Close"/"CLOSED" (or both blank) means closed all day.
 * With `allowRemove`, Open or Close of "REMOVE"/"DELETE" means "take this
 * date off the profile" — only the GBP import honours that, because the
 * Semrush import replaces the whole special-hours list anyway.
 *
 * Pure functions, no I/O.
 */

/** "9:00:00 AM" / "5:00 PM" / "17:00" → "HH:mm" (24h). null when not a time. */
export function parseTime(timeStr) {
  if (!timeStr) return null;
  const str = String(timeStr).trim();
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

/** "4/5/2026" or "2026-04-05" → "2026-04-05". null when not a date. */
export function parseDate(dateStr) {
  if (!dateStr) return null;
  const str = String(dateStr).trim();
  if (!str) return null;
  const match = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return `${match[3]}-${String(parseInt(match[1])).padStart(2, "0")}-${String(parseInt(match[2])).padStart(2, "0")}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  return null;
}

export function isClosed(openVal, closeVal) {
  const o = (openVal || "").trim().toLowerCase();
  const c = (closeVal || "").trim().toLowerCase();
  return o === "close" || o === "closed" || c === "close" || c === "closed" || (!o && !c);
}

export function isRemove(openVal, closeVal) {
  const o = (openVal || "").trim().toLowerCase();
  const c = (closeVal || "").trim().toLowerCase();
  return o === "remove" || o === "delete" || c === "remove" || c === "delete";
}

export function parseCSVLine(line) {
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
 * Parse the CSV into per-shop holiday entries.
 *
 * Returns { byShop: Map<shopId, entries[]>, rows, closed, specialHours,
 * removals, holiday2Count } or throws with a user-facing message when the
 * header is unusable. `entries` are in the app's holiday shape:
 *   { type: "CLOSED" | "RANGE" | "REMOVE", day: "YYYY-MM-DD", times?: [{from,to}] }
 *
 * Rows for the same shop are merged; within a shop the first row for a
 * given date wins.
 */
export function parseHolidayCsv(csvData, { allowRemove = false } = {}) {
  const lines = String(csvData || "")
    .split("\n")
    .map((l) => l.replace(/\r/g, "").replace(/^﻿/, "").trim())
    .filter(Boolean);
  if (lines.length < 2) throw new Error("CSV must have a header row and data rows");

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const franchiseIdIdx = header.findIndex((h) => h.includes("franchise") && h.includes("id"));
  const holiday1Idx = header.findIndex((h) => h === "holiday" || (h.includes("holiday") && !h.includes("open") && !h.includes("close") && !h.includes("2")));
  const holiday1OpenIdx = header.findIndex((h) => h === "holiday open" || (h.includes("holiday") && h.includes("open") && !h.includes("2")));
  const holiday1CloseIdx = header.findIndex((h) => h === "holiday close" || (h.includes("holiday") && h.includes("close") && !h.includes("2")));
  const holiday2Idx = header.findIndex((h) => h === "holiday 2" || (h.includes("holiday") && h.includes("2") && !h.includes("open") && !h.includes("close")));
  const holiday2OpenIdx = header.findIndex((h) => (h.includes("holiday") && h.includes("open") && h.includes("2")));
  const holiday2CloseIdx = header.findIndex((h) => (h.includes("holiday") && h.includes("close") && h.includes("2")));

  if (franchiseIdIdx === -1) throw new Error("CSV must have a 'Franchise ID' column");
  if (holiday1Idx === -1) throw new Error("CSV must have a 'Holiday' date column");

  const out = { byShop: new Map(), rows: 0, closed: 0, specialHours: 0, removals: 0, holiday2Count: 0 };

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const shopId = (cols[franchiseIdIdx] || "").trim();
    if (!shopId) continue;
    out.rows++;

    let acc = out.byShop.get(shopId);
    if (!acc) {
      acc = { entries: [], seenDates: new Set() };
      out.byShop.set(shopId, acc);
    }

    const addEntry = (dateIdx, openIdx, closeIdx, isSecond) => {
      if (dateIdx < 0) return;
      const date = parseDate(cols[dateIdx]);
      if (!date) return;
      if (acc.seenDates.has(date)) return;
      const openVal = cols[openIdx] || "";
      const closeVal = cols[closeIdx] || "";
      let entry = null;
      if (allowRemove && isRemove(openVal, closeVal)) {
        entry = { type: "REMOVE", day: date };
        out.removals++;
      } else if (isClosed(openVal, closeVal)) {
        entry = { type: "CLOSED", day: date };
        out.closed++;
      } else {
        const from = parseTime(openVal);
        const to = parseTime(closeVal);
        if (from && to) {
          entry = { type: "RANGE", day: date, times: [{ from, to }] };
          out.specialHours++;
        }
      }
      if (entry) {
        acc.entries.push(entry);
        acc.seenDates.add(date);
        if (isSecond) out.holiday2Count++;
      }
    };

    addEntry(holiday1Idx, holiday1OpenIdx, holiday1CloseIdx, false);
    addEntry(holiday2Idx, holiday2OpenIdx, holiday2CloseIdx, true);
  }

  // Strip the bookkeeping set; callers get plain arrays.
  for (const [shopId, acc] of out.byShop) out.byShop.set(shopId, acc.entries);
  return out;
}

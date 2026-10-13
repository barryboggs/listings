import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { verifyToken } from "@/lib/auth";
import { getReviewsForExport, getShopNumbers, initDatabase, logActivity } from "@/lib/db";
import { getBrandConfig } from "@/lib/data";

// A quarter across every brand is tens of thousands of rows. The query
// and CSV build are each a few seconds at most; the Blob upload of a
// ~10 MB file is the slow part.
export const maxDuration = 60;

// Column order matches the Reviews_2026Q2.csv the brand teams already use.
const HEADER = [
  "BusinessName", "StreetAddress", "City", "State", "Zip",
  "Client Location ID", "Rating", "Review Date", "Review Detail",
];

// Longest window we'll export in one file. A year of all-brand reviews
// is well past what anyone opens in Excel; this keeps a typo'd date
// from turning into a multi-year dump.
const MAX_RANGE_DAYS = 366;

/**
 * POST /api/gbp/reviews-csv-export
 *
 * Admin-only. One row per Google review created in [start, end], as CSV.
 *
 * Body:
 *   {
 *     start: "2026-07-01",          // inclusive, UTC
 *     end:   "2026-09-30",          // inclusive, UTC
 *     brands?: ["take5", ...]       // omitted / empty / ["*"] → all brands
 *   }
 *
 * Delivery: the file is uploaded to Vercel Blob and the response is JSON
 * with its URL, because a quarter of reviews (~5-10 MB) is over Vercel's
 * 4.5 MB function response cap. Without BLOB_READ_WRITE_TOKEN (local dev)
 * the CSV is returned directly instead, with the summary JSON in the
 * X-Export-Summary header.
 *
 * Summary shape:
 *   {
 *     filename, url? (Blob download link), rows,
 *     coverage: { totalShops, mappedShops, shopsWithReviews }
 *   }
 * `mappedShops` < `totalShops` means some shops have no GBP location
 * mapped, so their reviews can't be in the file — the UI surfaces this.
 */
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  await initDatabase();

  const body = await request.json().catch(() => ({}));
  const { start, end } = body;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(start || "") || !dateRe.test(end || "")) {
    return NextResponse.json({ error: "start and end (YYYY-MM-DD) are required" }, { status: 400 });
  }
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
    return NextResponse.json({ error: "end must be on or after start" }, { status: 400 });
  }
  if ((endMs - startMs) / 86400000 > MAX_RANGE_DAYS) {
    return NextResponse.json({ error: `Range is limited to ${MAX_RANGE_DAYS} days` }, { status: 400 });
  }

  const requested = Array.isArray(body.brands) ? body.brands.filter(Boolean) : [];
  const brands = requested.length === 0 || requested.includes("*") ? null : requested;

  // end is inclusive for the caller; the query wants an exclusive bound.
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs + 86400000).toISOString();

  let rows;
  try {
    rows = await getReviewsForExport({ brands, start: startIso, end: endIso });
  } catch (e) {
    console.error("reviews-csv-export query error:", e.message);
    return NextResponse.json({ error: `Query failed: ${e.message}` }, { status: 500 });
  }

  const brandNames = new Map();
  const businessName = (brand) => {
    if (!brand) return "";
    if (!brandNames.has(brand)) brandNames.set(brand, getBrandConfig(brand).name);
    return brandNames.get(brand);
  };

  const lines = [HEADER.map(csvField).join(",")];
  for (const r of rows) {
    lines.push([
      businessName(r.brand),
      r.street_address,
      r.city,
      r.state,
      r.zip,
      r.shop_id,
      r.rating,
      formatUtcDate(r.google_created_at),
      neutralizeFormula(r.comment),
    ].map(csvField).join(","));
  }
  // BOM so Excel opens the file as UTF-8 — otherwise emoji and curly
  // quotes in review text render as mojibake.
  const csv = "﻿" + lines.join("\r\n") + "\r\n";

  const allShops = await getShopNumbers();
  const inScope = allShops.filter((s) => !brands || brands.includes(s.brand));
  const coverage = {
    totalShops: inScope.length,
    mappedShops: inScope.filter((s) => s.gbp_location_id).length,
    shopsWithReviews: new Set(rows.map((r) => r.shop_id).filter(Boolean)).size,
  };

  const filename = buildFilename(start, end, brands);
  const summary = { filename, rows: rows.length, coverage };

  logActivity({
    user: user.name,
    action: "Exported reviews CSV",
    location: "",
    brand: brands ? brands.join(",") : "all",
    details: `${start}..${end} rows:${rows.length} shops:${coverage.shopsWithReviews}/${coverage.mappedShops} mapped/${coverage.totalShops} total`,
  }).catch(() => {});

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Export-Summary": JSON.stringify(summary),
      },
    });
  }

  try {
    // Random suffix makes the public URL unguessable; the contents are
    // public Google reviews plus shop addresses, nothing private.
    const blob = await put(`review-exports/${filename}`, csv, {
      access: "public",
      contentType: "text/csv; charset=utf-8",
      addRandomSuffix: true,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    // downloadUrl forces Content-Disposition: attachment; the plain url
    // would open as text in the browser tab.
    return NextResponse.json({ ...summary, url: blob.downloadUrl });
  } catch (e) {
    console.error("reviews-csv-export blob upload error:", e.message);
    return NextResponse.json({ error: `Upload failed: ${e.message}` }, { status: 502 });
  }
}

function csvField(value) {
  if (value == null) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Review text is customer-written. A comment starting with = + - @ would
// be evaluated as a formula when the file is opened in Excel, so prefix
// those with an apostrophe (OWASP CSV-injection guidance).
function neutralizeFormula(value) {
  if (value == null) return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

// M/D/YYYY in UTC, matching the existing report's Review Date format.
function formatUtcDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

// Reviews_2026Q3.csv for an exact calendar quarter (the naming the brand
// teams use), otherwise Reviews_2026-07-01_to_2026-08-15.csv. A single
// brand gets its id appended.
function buildFilename(start, end, brands) {
  let period = `${start}_to_${end}`;
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const quarterEndDay = new Date(Date.UTC(ey, em, 0)).getUTCDate();
  if (sy === ey && sd === 1 && (sm - 1) % 3 === 0 && em === sm + 2 && ed === quarterEndDay) {
    period = `${sy}Q${(sm - 1) / 3 + 1}`;
  }
  const suffix = brands && brands.length === 1 ? `_${brands[0].replace(/[^a-zA-Z0-9-]/g, "")}` : "";
  return `Reviews_${period}${suffix}.csv`;
}

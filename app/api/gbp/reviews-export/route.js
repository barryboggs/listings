import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { verifyToken } from "@/lib/auth";
import {
  getReviewStatsForMonth,
  getTopThemesForMonth,
  getReviewsWithEnrichmentsForMonth,
  initDatabase,
} from "@/lib/db";
import { getBrandConfig } from "@/lib/data";

// Vercel Pro function timeout. Building the workbook is CPU-bound but
// fast even for ~2000 reviews (~500ms). Setting a modest ceiling.
export const maxDuration = 60;

const THEME_LABELS = {
  quality: "Quality of work",
  price: "Pricing",
  staff: "Staff",
  wait_time: "Wait time",
  communication: "Communication",
  location: "Location / access",
  cleanliness: "Cleanliness",
  scheduling: "Scheduling",
  value: "Value",
  other: "Other",
};
const themeLabel = (tag) => THEME_LABELS[tag] || tag;

/**
 * GET /api/gbp/reviews-export?brand=<brand>&month=YYYY-MM
 *
 * Admin-only. Builds a 4-sheet XLSX workbook and returns it as a
 * binary download:
 *
 *   Sheet 1: Summary
 *     - Brand, month, generated-at timestamp
 *     - Total reviews, avg rating, response rate, all with MoM deltas
 *     - Rating distribution (1-5 star counts)
 *
 *   Sheet 2: Top Positive Themes
 *     - Rank, theme (human label), mention count, up to 3 sample quotes
 *
 *   Sheet 3: Top Negative Themes
 *     - Same shape
 *
 *   Sheet 4: All Reviews
 *     - Every review in the month with its enrichment themes as
 *       comma-separated columns (positive themes, negative themes,
 *       neutral themes) so the AGN team can pivot / filter in Excel.
 *
 * Filename: {brandSlug}_reviews_{YYYY-MM}.xlsx (e.g. "autoglass_reviews_2026-07.xlsx")
 */
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  await initDatabase();

  const url = new URL(request.url);
  const brand = url.searchParams.get("brand");
  const month = url.searchParams.get("month");

  if (!brand || !month) {
    return NextResponse.json({ error: "brand and month (YYYY-MM) are required" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "month must be YYYY-MM" }, { status: 400 });
  }

  // Prior month for MoM delta rendering in the Summary sheet.
  const [year, m] = month.split("-").map(Number);
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? year - 1 : year;
  const prevMonth = `${prevY}-${String(prevM).padStart(2, "0")}`;

  const [stats, prevStats, themes, allReviews] = await Promise.all([
    getReviewStatsForMonth({ brand, monthStr: month }),
    getReviewStatsForMonth({ brand, monthStr: prevMonth }),
    getTopThemesForMonth({ brand, monthStr: month, topN: 10 }),
    getReviewsWithEnrichmentsForMonth({ brand, monthStr: month }),
  ]);

  const brandCfg = getBrandConfig(brand);
  const brandName = brandCfg?.name || brand;

  // ---------- Build workbook ----------

  const wb = XLSX.utils.book_new();

  // Sheet 1: Summary
  const monthDate = new Date(`${month}-01T00:00:00Z`);
  const monthLabel = monthDate.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const fmtDelta = (cur, prev) => {
    if (prev == null || cur == null) return "n/a";
    const d = cur - prev;
    if (Math.abs(d) < 0.005) return "no change";
    return (d > 0 ? "+" : "") + (Number.isInteger(d) ? d : d.toFixed(2));
  };
  const fmtPct = (n) => n == null ? "n/a" : `${Math.round(n * 100)}%`;

  const summaryRows = [
    ["Brand", brandName],
    ["Month", monthLabel],
    ["Generated at", new Date().toISOString()],
    [""],
    ["Metric", "This month", `Previous (${prevMonth})`, "Change"],
    ["Total reviews", stats?.total || 0, prevStats?.total || 0, fmtDelta(stats?.total, prevStats?.total)],
    ["Average rating", stats?.avg_rating ?? "n/a", prevStats?.avg_rating ?? "n/a", fmtDelta(stats?.avg_rating, prevStats?.avg_rating)],
    ["Response rate", fmtPct(stats?.response_rate), fmtPct(prevStats?.response_rate), fmtDelta(stats?.response_rate, prevStats?.response_rate)],
    [""],
    ["Rating distribution", "Count"],
    ["5 star", stats?.distribution?.[5] || 0],
    ["4 star", stats?.distribution?.[4] || 0],
    ["3 star", stats?.distribution?.[3] || 0],
    ["2 star", stats?.distribution?.[2] || 0],
    ["1 star", stats?.distribution?.[1] || 0],
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet["!cols"] = [{ wch: 22 }, { wch: 18 }, { wch: 22 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");

  // Sheets 2 & 3: Top themes (positive, negative)
  const themeSheet = (list) => {
    const rows = [
      ["Rank", "Theme", "Mentions", "Quote 1", "Quote 2", "Quote 3"],
      ...list.map((t, i) => [
        i + 1,
        themeLabel(t.tag),
        t.count,
        (t.sample_quotes || [])[0] || "",
        (t.sample_quotes || [])[1] || "",
        (t.sample_quotes || [])[2] || "",
      ]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 6 }, { wch: 22 }, { wch: 10 }, { wch: 60 }, { wch: 60 }, { wch: 60 }];
    return ws;
  };
  XLSX.utils.book_append_sheet(wb, themeSheet(themes.positive || []), "Top Positive Themes");
  XLSX.utils.book_append_sheet(wb, themeSheet(themes.negative || []), "Top Negative Themes");

  // Sheet 4: All Reviews
  // Each review gets its themes flattened into three comma-separated columns
  // (positive / negative / neutral) so the AGN team can pivot on any of them.
  const reviewRows = [
    [
      "Date (UTC)",
      "Rating",
      "Reviewer",
      "Comment",
      "Positive themes",
      "Negative themes",
      "Neutral themes",
      "Reply",
      "Reply date (UTC)",
      "Shop ID",
    ],
    ...allReviews.map((r) => {
      const themes = Array.isArray(r.themes) ? r.themes : [];
      const pos = themes.filter((t) => t.sentiment === "positive").map((t) => themeLabel(t.tag)).join(", ");
      const neg = themes.filter((t) => t.sentiment === "negative").map((t) => themeLabel(t.tag)).join(", ");
      const neu = themes.filter((t) => t.sentiment === "neutral").map((t) => themeLabel(t.tag)).join(", ");
      return [
        r.google_created_at ? String(r.google_created_at).slice(0, 10) : "",
        r.rating ?? "",
        r.reviewer_display_name || "",
        r.comment || "",
        pos,
        neg,
        neu,
        r.reply_comment || "",
        r.reply_updated_at ? String(r.reply_updated_at).slice(0, 10) : "",
        r.shop_id || "",
      ];
    }),
  ];
  const reviewsSheet = XLSX.utils.aoa_to_sheet(reviewRows);
  reviewsSheet["!cols"] = [
    { wch: 12 }, { wch: 7 }, { wch: 24 }, { wch: 60 },
    { wch: 30 }, { wch: 30 }, { wch: 20 }, { wch: 40 }, { wch: 12 }, { wch: 10 },
  ];
  // Freeze the header row so scrolling keeps column labels visible
  reviewsSheet["!freeze"] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, reviewsSheet, "All Reviews");

  // Serialize to buffer + return with download headers.
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const filename = `${brand}_reviews_${month}.xlsx`;

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buf.length),
    },
  });
}
